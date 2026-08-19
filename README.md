# pi-copilot-auto

为 pi 增加 `github-copilot/auto` 模型，适用于已开通 GitHub Copilot 的账号，包括 Copilot Student 订阅。

Copilot 的 Auto 并不是可以直接发送到聊天 API 的普通模型 ID。这个扩展会按官方客户端的流程：

1. 向 Copilot 请求 Auto 会话和当前账号可用的候选模型；
2. 将本轮文本提示发送给 Copilot 的模型路由器；
3. 选择路由结果中的实际模型；
4. 携带 `Copilot-Session-Token` 调用该模型；
5. 在同一个 pi 会话中保持所选模型，Auto 会话过期后自动刷新。

## 要求

- Node.js 22.19 或更高版本；
- 较新的 `@earendil-works/pi-coding-agent`（已在 0.84.2 上验证）；
- GitHub 账号拥有可用的 Copilot 订阅及聊天模型权限。

## 安装

从 GitHub 安装：

```bash
pi install git:github.com/fireworkofsummer/pi-copilot-auto
```

也可以先临时测试：

```bash
pi --no-extensions -e git:github.com/fireworkofsummer/pi-copilot-auto
```

从本地源码安装时，在仓库目录执行：

```bash
pi install .
```

安装后重启 pi，或者在现有会话中执行 `/reload`。

## 使用

首次使用先在 pi 中登录：

```text
/login
```

选择 **GitHub Copilot** 并完成设备授权。然后执行：

```text
/model
```

选择：

```text
github-copilot/auto
```

也可以直接启动：

```bash
pi --model github-copilot/auto
```

## 验证

```bash
pi --list-models auto
```

登录成功且扩展已加载时，应看到 `github-copilot/auto`。

## 隐私与计费说明

- 为实现官方 Auto 路由，扩展会把当前会话首次待处理的文本提示发送到 GitHub Copilot 的 `/models/session/intent` 接口；之后正常请求仍发送给 GitHub Copilot。
- 扩展不会读取或保存 `auth.json`，身份验证、令牌刷新和企业版 API 地址均复用 pi 内置的 GitHub Copilot Provider。
- 实际可用模型、请求倍率、额度及费用由 GitHub 根据你的 Copilot 方案决定；Student 资格不会绕过 GitHub 的服务端策略。
- 如果 GitHub 返回的候选模型尚未包含在本地 pi 模型目录中，请先运行 `pi update --models`。

## 工作方式与限制

- Auto 在 pi 的模型列表中是一个伪模型；会话消息中记录的响应模型可能显示为实际被路由到的模型，这是预期行为。
- 为避免在工具调用循环中反复改变模型，扩展和官方客户端一样，在一个会话中优先保持首次路由结果。
- Auto 模型自身不暴露 pi 的 thinking level 选择器；实际模型会采用其支持的默认推理级别。
- 扩展对 Auto 使用保守的 128K 上下文声明，以免在路由前高估未知候选模型的上下文窗口。
