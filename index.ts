import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	type Credential,
	type Model,
	type Provider,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const AUTO_MODEL_ID = "auto";
const AUTO_API = "github-copilot-auto";
const AUTO_SESSION_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const AUTO_SESSION_TIMEOUT_MS = 10_000;
const ROUTER_TIMEOUT_MS = 1_000;
const DEFAULT_CACHE_KEY = "__default__";

interface AutoSessionResponse {
	available_models: string[];
	expires_at: number;
	discounted_costs?: Record<string, number>;
	session_token: string;
}

interface RouterResponse {
	chosen_model?: string;
	candidate_models: string[];
}

interface AutoSessionState {
	autoSession?: AutoSessionResponse;
	autoSessionPromise?: Promise<AutoSessionResponse>;
	selectedModelId?: string;
}

type AutoStreamOptions = StreamOptions | SimpleStreamOptions;
type StreamDelegate = (
	model: Model<Api>,
	context: Context,
	options?: AutoStreamOptions,
) => AssistantMessageEventStream;

export interface CopilotAutoProviderOptions {
	/** Only primary agent requests should update the active Auto model's context limits. */
	isPrimarySession?: (requestSessionId: string | undefined) => boolean;
}

function createAutoModel(baseUrl: string): Model<Api> {
	return {
		id: AUTO_MODEL_ID,
		name: "Auto (GitHub Copilot)",
		api: AUTO_API,
		provider: "github-copilot",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 64_000,
		headers: {
			"User-Agent": "GitHubCopilotChat/0.35.0",
			"Editor-Version": "vscode/1.107.0",
			"Editor-Plugin-Version": "copilot-chat/0.35.0",
			"Copilot-Integration-Id": "vscode-chat",
			"X-GitHub-Api-Version": "2025-10-01",
		},
	};
}

function mergeHeaders(headers: ProviderHeaders | undefined, additions: Record<string, string>): ProviderHeaders {
	return { ...(headers ?? {}), ...additions };
}

function toFetchHeaders(headers: ProviderHeaders | undefined, apiKey: string): Headers {
	const result = new Headers();
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result.set(name, value);
	}
	result.set("Accept", "application/json");
	result.set("Content-Type", "application/json");
	result.set("Authorization", `Bearer ${apiKey}`);
	return result;
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function baseUrlOf(model: Model<Api>): string {
	return model.baseUrl.replace(/\/+$/, "");
}

function responseError(response: Response, operation: string): Error {
	const statusText = response.statusText ? ` ${response.statusText}` : "";
	return new Error(`${operation} failed with HTTP ${response.status}${statusText}`);
}

function validateAutoSession(value: unknown): AutoSessionResponse {
	if (!value || typeof value !== "object") {
		throw new Error("Copilot Auto returned an invalid session response");
	}
	const candidate = value as Partial<AutoSessionResponse>;
	if (
		!Array.isArray(candidate.available_models) ||
		!candidate.available_models.every((id) => typeof id === "string") ||
		typeof candidate.expires_at !== "number" ||
		typeof candidate.session_token !== "string" ||
		candidate.session_token.length === 0
	) {
		throw new Error("Copilot Auto returned an incomplete session response");
	}
	return candidate as AutoSessionResponse;
}

function validateRouterResponse(value: unknown): RouterResponse {
	if (!value || typeof value !== "object") {
		throw new Error("Copilot Auto router returned an invalid response");
	}
	const candidate = value as Partial<RouterResponse>;
	if (!Array.isArray(candidate.candidate_models) || !candidate.candidate_models.every((id) => typeof id === "string")) {
		throw new Error("Copilot Auto router returned an incomplete response");
	}
	if (candidate.chosen_model !== undefined && typeof candidate.chosen_model !== "string") {
		throw new Error("Copilot Auto router returned an invalid chosen model");
	}
	return candidate as RouterResponse;
}

function extractLatestUserPrompt(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message.role !== "user") continue;
		if (typeof message.content === "string") {
			const text = message.content.trim();
			return text || undefined;
		}
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		return text || undefined;
	}
	return undefined;
}

function hasImageInput(context: Context): boolean {
	return context.messages.some((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return false;
		return message.content.some((content) => content.type === "image");
	});
}

function createErrorMessage(model: Model<Api>, reason: "error" | "aborted", error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: reason,
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

function markEventAsAuto(event: AssistantMessageEvent): void {
	if ("partial" in event) {
		event.partial.model = AUTO_MODEL_ID;
	} else if (event.type === "done") {
		event.message.model = AUTO_MODEL_ID;
	} else {
		event.error.model = AUTO_MODEL_ID;
	}
}

async function loadGitHubCopilotProvider(): Promise<Provider<Api>> {
	// pi's extension loader aliases the pi-ai root to its compatibility entrypoint.
	// Resolve that public entrypoint first, then load the provider module beside it;
	// importing the exported provider subpath directly is currently misresolved by jiti.
	const piAiEntry = import.meta.resolve("@earendil-works/pi-ai");
	const providerModuleUrl = new URL("./providers/github-copilot.js", piAiEntry).href;
	const providerModule = (await import(providerModuleUrl)) as {
		githubCopilotProvider(): Provider<Api>;
	};
	return providerModule.githubCopilotProvider();
}

export async function createCopilotAutoProvider(
	providerOptions: CopilotAutoProviderOptions = {},
): Promise<Provider<Api>> {
	const baseProvider = await loadGitHubCopilotProvider();
	const builtInAuto = baseProvider.getModels().find((model) => model.id === AUTO_MODEL_ID);
	if (builtInAuto) return baseProvider;

	const autoModel = createAutoModel(baseProvider.baseUrl ?? "https://api.individual.githubcopilot.com");
	const sessionStates = new Map<string, AutoSessionState>();

	const getState = (options?: AutoStreamOptions): AutoSessionState => {
		const key = options?.sessionId || DEFAULT_CACHE_KEY;
		let state = sessionStates.get(key);
		if (!state) {
			state = {};
			sessionStates.set(key, state);
		}
		return state;
	};

	const requestAutoSession = async (
		model: Model<Api>,
		options: AutoStreamOptions | undefined,
		state: AutoSessionState,
	): Promise<AutoSessionResponse> => {
		const current = state.autoSession;
		if (current && current.expires_at * 1000 - Date.now() > AUTO_SESSION_REFRESH_MARGIN_MS) return current;
		if (state.autoSessionPromise) return state.autoSessionPromise;

		const apiKey = options?.apiKey;
		if (!apiKey) throw new Error("GitHub Copilot is not authenticated. Run /login and select GitHub Copilot.");

		const request = (async () => {
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const response = await fetchImpl(`${baseUrlOf(model)}/models/session`, {
				method: "POST",
				headers: toFetchHeaders(options?.headers, apiKey),
				body: JSON.stringify({ auto_mode: { model_hints: [AUTO_MODEL_ID] } }),
				signal: withTimeout(options?.signal, AUTO_SESSION_TIMEOUT_MS),
			});
			if (!response.ok) throw responseError(response, "Copilot Auto session request");
			const autoSession = validateAutoSession(await response.json());
			state.autoSession = autoSession;
			if (state.selectedModelId && !autoSession.available_models.includes(state.selectedModelId)) {
				state.selectedModelId = undefined;
			}
			return autoSession;
		})();

		state.autoSessionPromise = request;
		try {
			return await request;
		} finally {
			if (state.autoSessionPromise === request) state.autoSessionPromise = undefined;
		}
	};

	const requestRouterDecision = async (
		model: Model<Api>,
		context: Context,
		options: AutoStreamOptions | undefined,
		autoSession: AutoSessionResponse,
		state: AutoSessionState,
	): Promise<string | undefined> => {
		const prompt = extractLatestUserPrompt(context);
		if (!prompt || hasImageInput(context)) return undefined;

		const apiKey = options?.apiKey;
		if (!apiKey) return undefined;

		try {
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = toFetchHeaders(options?.headers, apiKey);
			headers.set("Copilot-Session-Token", autoSession.session_token);
			const response = await fetchImpl(`${baseUrlOf(model)}/models/session/intent`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					prompt,
					available_models: autoSession.available_models,
					session_id: options?.sessionId,
					previous_model: state.selectedModelId,
					turn_number: state.selectedModelId ? 2 : 1,
					reference_count: 0,
					prompt_char_count: prompt.length,
				}),
				signal: withTimeout(options?.signal, ROUTER_TIMEOUT_MS),
			});
			if (!response.ok) return undefined;
			const decision = validateRouterResponse(await response.json());
			const orderedCandidates = [decision.chosen_model, ...decision.candidate_models].filter(
				(candidate): candidate is string => typeof candidate === "string",
			);
			return orderedCandidates.find((candidate) => autoSession.available_models.includes(candidate));
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			return undefined;
		}
	};

	const selectActualModel = async (
		model: Model<Api>,
		context: Context,
		options?: AutoStreamOptions,
	): Promise<{ model: Model<Api>; sessionToken: string }> => {
		const state = getState(options);
		const autoSession = await requestAutoSession(model, options, state);
		const knownModels = baseProvider.getModels().filter((candidate) => candidate.id !== AUTO_MODEL_ID);
		const knownById = new Map(knownModels.map((candidate) => [candidate.id, candidate]));

		let selectedModelId = state.selectedModelId;
		if (!selectedModelId || !autoSession.available_models.includes(selectedModelId) || !knownById.has(selectedModelId)) {
			selectedModelId = await requestRouterDecision(model, context, options, autoSession, state);
		}

		const needsVision = hasImageInput(context);
		if (selectedModelId && needsVision && !knownById.get(selectedModelId)?.input.includes("image")) {
			selectedModelId = undefined;
		}

		selectedModelId ??= autoSession.available_models.find((candidate) => {
			const known = knownById.get(candidate);
			return known && (!needsVision || known.input.includes("image"));
		});

		if (!selectedModelId) {
			throw new Error(
				"Copilot Auto did not return a model known to this pi installation. Run `pi update --models` and retry.",
			);
		}

		const selectedModel = knownById.get(selectedModelId);
		if (!selectedModel) {
			throw new Error(`Copilot Auto selected unknown model: ${selectedModelId}`);
		}
		state.selectedModelId = selectedModelId;

		// Pi checks compaction after the response using the active model object. Keep
		// the Auto pseudo-model in sync with the model selected for the main agent
		// session. Compaction summaries use fresh session IDs and must not overwrite
		// the primary conversation's limits.
		if (providerOptions.isPrimarySession?.(options?.sessionId) ?? true) {
			autoModel.contextWindow = selectedModel.contextWindow;
			autoModel.maxTokens = selectedModel.maxTokens;
			model.contextWindow = selectedModel.contextWindow;
			model.maxTokens = selectedModel.maxTokens;
		}

		return {
			model: { ...selectedModel, baseUrl: model.baseUrl },
			sessionToken: autoSession.session_token,
		};
	};

	const streamAuto = (
		model: Model<Api>,
		context: Context,
		options: AutoStreamOptions | undefined,
		delegate: StreamDelegate,
	): AssistantMessageEventStream => {
		const output = createAssistantMessageEventStream();
		void (async () => {
			try {
				const selected = await selectActualModel(model, context, options);
				const delegatedOptions: AutoStreamOptions = {
					...(options ?? {}),
					headers: mergeHeaders(options?.headers, { "Copilot-Session-Token": selected.sessionToken }),
				};
				const inner = delegate(selected.model, context, delegatedOptions);
				for await (const event of inner) {
					// Keep the persisted model identity aligned with Pi's active `auto`
					// model so overflow recovery is not skipped as a cross-model error.
					markEventAsAuto(event);
					output.push(event);
				}
				output.end();
			} catch (error) {
				const reason = options?.signal?.aborted ? "aborted" : "error";
				const message = createErrorMessage(model, reason, error);
				output.push({ type: "error", reason, error: message });
				output.end();
			}
		})();
		return output;
	};

	const provider: Provider<Api> = {
		...baseProvider,
		getModels: () => [...baseProvider.getModels().filter((model) => model.id !== AUTO_MODEL_ID), autoModel],
		filterModels: (models: readonly Model<Api>[], credential: Credential | undefined) => {
			const regularModels = models.filter((model) => model.id !== AUTO_MODEL_ID);
			const available = baseProvider.filterModels?.(regularModels, credential) ?? regularModels;
			return [...available, autoModel];
		},
		stream: (model, context, options) =>
			model.id === AUTO_MODEL_ID
				? streamAuto(model, context, options, (selected, selectedContext, selectedOptions) =>
						baseProvider.stream(selected, selectedContext, selectedOptions),
					)
				: baseProvider.stream(model, context, options),
		streamSimple: (model, context, options) =>
			model.id === AUTO_MODEL_ID
				? streamAuto(model, context, options, (selected, selectedContext, selectedOptions) =>
						baseProvider.streamSimple(selected, selectedContext, selectedOptions as SimpleStreamOptions),
					)
				: baseProvider.streamSimple(model, context, options),
	};

	return provider;
}

export default async function copilotAutoExtension(pi: ExtensionAPI): Promise<void> {
	let activeSessionId: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		activeSessionId = ctx.sessionManager.getSessionId();
	});
	pi.on("session_shutdown", () => {
		activeSessionId = undefined;
	});

	pi.registerProvider(
		await createCopilotAutoProvider({
			isPrimarySession: (requestSessionId) =>
				activeSessionId === undefined || requestSessionId === activeSessionId,
		}),
	);
}
