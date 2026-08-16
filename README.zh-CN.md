# cursor-sdk2api

[English](README.md)

独立 MIT 网关：把官方公开发布的 Cursor TypeScript SDK（`@cursor/sdk`）转成三条 HTTP 协议：Anthropic Messages、OpenAI Chat Completions、OpenAI Responses。

**Claude Code 优先，Grok Build 可用，兼容 Codex / Responses。** 已验收的 Claude 路径覆盖流式输出、多轮与同轮并行客户端工具、cache usage、已完成会话续聊，以及 Claude Code 上下文估算。Cursor 实时目录暴露 `context=1m` 时，网关会把这个官方模型参数原样交给 `@cursor/sdk`。

这不是 Cursor / Anysphere 官方产品。它不逆向私有 Cursor 传输、Cookie、Desktop/CLI 凭据库或浏览器会话。唯一的模型执行引擎是公开发布的 `@cursor/sdk`。你需要提供合法获得的 Cursor User API Key（或 Service Account Key），并遵守 Cursor 服务条款。

[![CI](https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml/badge.svg)](https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933)](package.json)
[![@cursor/sdk](https://img.shields.io/badge/%40cursor%2Fsdk-1.0.28-111111)](https://www.npmjs.com/package/@cursor/sdk)

**v0.1 是单进程、可信网络侧车。** `/v0/management/accounts` 没有单独 Access Key，会把原始 Cursor Key 返回给同源运维控制台。请只放在可信本地网络，或在外层加 TLS 和你自己的认证代理。

## 为什么做这个

多数「CLI 转 API」网关包的是 Claude Code、Codex 或 Grok 的登录态。这个项目反过来。

你已经有一把合法 Cursor API Key。Cursor 已经发布 `@cursor/sdk`。编码客户端已经会说 Messages 或 Responses。`cursor-sdk2api` 补的是这一层 HTTP 边缘：一个进程、一套 Run 协调器、三个协议适配，不靠 Cookie 里藏第二套 Cursor 运行时。

现在能用的：

- Claude Code 走 **Messages**，覆盖 SSE、客户端工具闭环、同轮并行工具、cache usage、已完成会话续聊，并提供带标记的本地 `count_tokens` 估算
- Grok Build 走 **Responses**，包含 Grok 的具名 function 工具选择，以及可选的 `reasoning.encrypted_content` include（接受后省略）
- OpenAI SDK / 通用 Chat 客户端走 **Chat Completions**
- Codex 和其他 Responses 客户端走 **Responses**，前提是它们不依赖 `previous_response_id`、`store=true` 或托管工具
- 调用方自己的工具（Claude Code / Grok / Codex 本机工具，包括该客户端自己暴露的网页 / 网络搜索）
- 同轮并行工具回调、多轮续轮、流式、base64 图片，以及 thinking / reasoning 块（已实现并有 contract 测试；真实模型上的 thinking 粒度仍未验收）
- 实时 `GET /v1/models`，保留精确公开模型 ID
- `GET /v1/account`：身份 + 同一把 User API Key 查 Cursor Dashboard 额度
- 可选运维控制台 `/console/`
- 两条 SDK 数据通路的出站 HTTP(S) 代理

它不是：

- 不是 Anthropic、OpenAI 或 xAI 的无损替代
- 不是逆向出来的 Cursor IDE 反代
- 不是 xAI 原生 Grok 端点（这里没有 `x_search`）
- 不是多实例高可用集群

## 客户端兼容

让每个客户端打它本来就会的协议。混在同一通道上，最常见的结果是 422。

| 客户端 | 用这个 | 不要用 |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` = 网关 origin → `POST /v1/messages` | Chat Completions。Claude Code 需要 Messages，包括 `max_tokens` 和 `count_tokens`。 |
| **Grok Build** | 自定义模型 `api_backend = "responses"` → `POST /v1/responses` | Messages。若客户端后来带上 `previous_response_id`，本网关会 422；把该模型改成 `chat_completions`。 |
| **Codex / OpenAI Responses** | `base_url` 指到 `…/v1`，`wire_api = "responses"` → `POST /v1/responses` | 不要假定 OpenAI store 语义。`previous_response_id`、`store=true`、conversation 和托管工具会 fail closed。 |
| **OpenAI SDK / 通用 Chat** | `base_url` 指到 `…/v1` → `POST /v1/chat/completions` | 除非客户端是 Anthropic 形态，否则不要走 Messages。 |
| **new-api / one-api** | Anthropic 上游 = origin（Messages）；OpenAI 上游 = `origin/v1`（Chat） | 同一通道混用两种协议。目前没有官方 new-api 渠道 PR，按通用 sidecar 配置。 |

Claude Code、Grok Build、Codex 改的是**你本机项目**，用的是**它们自己的工具**。网关只跑模型。Cursor SDK 的 `cwd` 是按凭证隔离的空目录，所以模型有时会吐出那个绝对路径。优先写相对路径，或写你的真实项目路径。

**Claude 1M 上下文。** Cursor 实时目录目前会为 Claude Sonnet 4.6、Fable 5 等模型暴露 `context=1m`。本网关保留精确公开模型 ID，并把官方 SDK 的 `{id,value}` 参数原样转发。它不会自己发明上下文窗口，也不会模拟 Anthropic 长上下文计费。1M 目录路径已经核验，但公开回执不包含人为构造的一百万 token 压测。

**网页 / 网络搜索。** 客户端自己的搜索工具仍在客户端执行。如果 Claude Code、Grok Build 或 Codex 暴露了本机网页 / 网络搜索工具，网关会把它当成普通调用方工具回传结果。Cursor ambient 的 `webSearch` / `webFetch` 会被拒绝。托管的 OpenAI `web_search` 会被拒绝。**经 Cursor 路由的 Grok 不会暴露 xAI 原生 `x_search`。** 那个工具在 xAI 自己的 API 上，不在这条 Cursor SDK 路径上。

兼容性证据：

- Claude Code：Sonnet 4.6 与 Fable 5 的完整宿主机 Messages 矩阵已通过，覆盖文本、SSE、单工具、并行工具、多轮工具、replay、cache 读写和 completed resume。公开矩阵中的 Fable 5 Claude Code 形态请求已通过；之后真实 Claude Code 运营探测也完成了 Sonnet 4.6 会话并调用本机工作区工具。
- Grok Build：Responses 适配对 Grok 的具名工具选择、usage 明细对象、已知的加密 reasoning include 有 contract 测试。一次本地运营探测用真实 Grok Build Responses 会话写下了工作区标记。同样只证明接通 + 本机工具。
- Codex：有 Responses contract 套件。本仓库没有 Codex 真实客户端回执。

## 能力矩阵

`GET /health` 的能力位只表示网关实现了该路径，不是真实模型验收章。二进制里的 `verification.live_smoke` 保持 `false`。

| 能力 | 状态 | 边界 |
|---|---|---|
| Anthropic Messages 文本 + SSE | 已实现；Sonnet 4.6、Fable 5、Composer 2.5、Grok 4.6 xhigh 有 live 抽样 | 有日期的宿主机回执：[docs/evidence/2026-08-15-live-smoke.md](docs/evidence/2026-08-15-live-smoke.md) |
| OpenAI Chat Completions | 协议适配；已有 contract 测试 | Health 标记为 `contract_tested_unverified_live`。没有 live Chat 矩阵。 |
| OpenAI Responses | 协议适配；已有 contract 测试 | 同样的 health 标记。Grok Build 接通有本地探测。Codex 未做 live 认证。 |
| Claude `count_tokens` | 本地保守估算 | 响应头 `x-cursor-sdk2api-token-count: estimated`。不启动 SDK Run。不计费。 |
| Claude 1M 上下文 | 目录 / 参数透传 | 只转发精确 Cursor ID 和官方 SDK 参数。本仓库没有 1M token 验收。 |
| Thinking / reasoning | 已实现；有 contract 测试 | 真实模型上的 thinking 粒度仍是独立 gate。Grok 的加密 reasoning include 会接受并省略。 |
| 图片 | 已实现；有 contract 测试 | 只接受 base64。远程 `image_url` 返回 `422`。 |
| 调用方工具经 custom MCP | 已实现 | 请求里的 `tools[]` → SDK `local.customTools`。有调用方工具时 allowlist 为 `["mcp"]`，否则 `[]`。 |
| 同轮并行工具 | 已实现；Claude / Composer 有 live 抽样 | 公开回执里 Grok 同轮两工具选择**不可重复**。不要当成保证行为。 |
| 多轮工具续轮 | 已实现；有 live 抽样 | 最新 user turn 只能是 `tool_result` / `function_call_output`。文本和结果混在一起会 `422`。 |
| 客户端网页 / 网络搜索 | 仅当**客户端**拥有该工具 | 按普通调用方工具映射。网关不会白送搜索。 |
| Cursor ambient `shell` / `read` / `edit` / `task` / `webSearch` / `webFetch` | 拒绝 | 空 workspace。`settingSources: []`。 |
| xAI `x_search` | **不可用** | 经 Cursor 路由的 Grok 仍然是 Cursor。需要 `x_search` 请走 xAI 原生 API。 |
| 托管 OpenAI 工具（`web_search`、`file_search`、`computer`、`shell`、`apply_patch`） | Fail closed | `422` |
| Responses `previous_response_id` / `store=true` / conversation | Fail closed | 续轮用 `function_call_output.call_id` 或 `x-cursor-session-id`。 |
| 进程内 live 工具续轮 | 进程内 Promise | 一个 owner 进程。Pending callback 不能按原样序列化。 |
| Pending 工具重启恢复 | 已实现；fake SDK 集成测试已覆盖 | 精确匹配 credential / model / 参数 / tool-id 批次 / 工具目录后，走 `Agent.resume` + `local.force=true`。已发布的 2026-08-15 live-smoke 仍记录 `409 cursor_session_lost`（当时 runner 按旧的 fail-closed 路径验收）。 |
| 已完成 follow-up resume | 已实现；有 live 抽样 | `x-cursor-session-id`，在 `SESSION_TTL_MS` 内。 |
| Cursor Dashboard 额度 | 已实现 | 同一把 User API Key。不需要 Cookie、Team Admin Key 或 OAuth 导入。缺失用量返回 `partial`，不会伪造为零。 |
| 出站 HTTP(S) 代理 | 已实现；容器内探测过 | 两条 SDK 数据通路。SOCKS / PAC fail closed。 |

## 快速开始

需要 Node.js 22.19 或更新版本。

```bash
git clone https://github.com/Sunnyender-org/cursor-sdk2api.git
cd cursor-sdk2api
npm ci
npm run build
export AUTH_MODE=byok
node dist/index.js
```

打开 [http://localhost:8080/console/](http://localhost:8080/console/)。在控制台里添加 Cursor API Key，或在每个请求里携带。

```bash
curl -s localhost:8080/health
curl -s localhost:8080/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

### Docker

```bash
docker build -t cursor-sdk2api:local .
docker run --rm -p 8080:8080 -e AUTH_MODE=byok cursor-sdk2api:local
```

`docker-compose.yml` 是单服务包装。它把 `STATE_DIR` 默认设为命名卷上的 `/data`，并且不携带密钥。

完整配置面见 [`.env.example`](.env.example)。不要提交真实密钥。

### 出站代理

官方 SDK 不会自己继承宿主机代理。设置受支持的代理变量后，网关会同时接管 **两条** SDK 数据通路：

- 本地 Agent 切换到 HTTP/1.1，经 `proxy-agent` 出站
- 模型目录、账号与 Cursor Dashboard 查询走 Undici 的环境代理 dispatcher

`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 的大小写形式均接受。代理 URL 必须是 `http://` 或 `https://`。SOCKS / PAC 会 fail closed。未配置代理时，Agent 保留官方 HTTP/2 传输。

`/health` 只报告 `network.proxy_configured`、`network.agent_transport` 与 `network.fetch_transport`，从不返回代理 URL 或认证信息。

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=127.0.0.1,localhost
node dist/index.js
```

在 Docker Desktop 里访问宿主机代理应使用 `host.docker.internal`，不能写容器内的 `127.0.0.1`：

```bash
docker run --rm -p 8080:8080 \
  -e AUTH_MODE=byok \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e NO_PROXY=127.0.0.1,localhost \
  cursor-sdk2api:local
```

不要把带 userinfo 的代理 URL 写进 compose 或文档。

## 客户端配置

网关不在本机回环时，换成实际 origin。BYOK 模式下密钥是 Cursor API Key；managed 模式下是 `GATEWAY_ACCESS_KEY`。

### Claude Code → Messages

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN="$CURSOR_API_KEY"
export ANTHROPIC_MODEL=claude-sonnet-4-6
claude
```

Claude Code 发送 `x-api-key`。网关同时接受它和 `Authorization: Bearer`。`ANTHROPIC_BASE_URL` 填 origin（不要带 `/v1`）；Claude Code 会自己拼 `/v1/messages`。

若账号开了 Privacy Mode，或属于 Team / Enterprise，Fable 5 可能要先在 [Cursor Dashboard](https://cursor.com/dashboard/restricted_models/claude-fable-5) 批准数据保留政策，才会出现在官方目录。

### Grok Build → Responses

```toml
[models]
default = "cursor-gw"

[model.cursor-gw]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
api_key = "<cursor-api-key>"
model = "grok-4.6"
api_backend = "responses"
```

Grok 本机的 `web_search` / `web_fetch`（若你没关掉）跑在 **Grok 进程里**，再以普通 function 结果回来。它们不是 Cursor ambient 工具，也不是 xAI `x_search`。

### Codex / OpenAI Responses

```toml
model = "composer-2.5"
model_provider = "cursor-sdk2api"

[model_providers.cursor-sdk2api]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "CURSOR_API_KEY"
```

或用 OpenAI SDK：

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=CURSOR_API_KEY)
client.responses.create(model="composer-2.5", input="hello")
```

不要发送 `previous_response_id`。Pending 工具续轮只接受末尾的 `function_call_output`，且 `call_id` 对得上当前 live tool id。已完成 follow-up 走 `x-cursor-session-id`。若你的 Codex 版本坚持要用 store 里的 response id，本网关会 422；改走 Chat Completions。

### OpenAI Chat Completions

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=CURSOR_API_KEY)
client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "hello"}],
)
```

### new-api / 通用 SDK sidecar

```text
Base URL（Anthropic 上游）：  http://<gateway-host>:8080
Base URL（OpenAI 上游）：     http://<gateway-host>:8080/v1
API key：                    Cursor Key（BYOK）或 GATEWAY_ACCESS_KEY（managed）
模型发现：                   GET /v1/models
```

不要把 `@cursor/sdk` 嵌进另一个网关进程。本进程保持 sidecar。

## 端点

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/console/` | 打开页面不需要 | 可选 BF Labs 运维控制台。 |
| `GET` / `POST` / `DELETE` | `/v0/management/accounts` | **v0.1 无认证** | 增删查持久化的 Cursor Key，并返回原始密钥。只允许可信网络或外层认证代理。 |
| `GET` | `/health` | 无 | 构建版本、SDK 版本、就绪状态、能力位、传输模式、`verification`。不含账号数据、密钥或代理 URL。 |
| `GET` | `/v1/models` | 需要 | 实时 `Cursor.models.list()`，保留精确公开 ID。不可用时返回空列表并给出 reason。 |
| `GET` | `/v1/account` | 需要 | `Cursor.me()` 身份 + 同一把 User API Key 查 Dashboard 当前周期用量。 |
| `POST` | `/v1/messages/count_tokens` | 需要 | 给 Claude Code 上下文管理用的本地估算。 |
| `POST` | `/v1/messages` | 需要 | Anthropic Messages 文本、SSE、调用方工具、并行工具、多轮续轮、进程内 replay。 |
| `POST` | `/v1/chat/completions` | 需要 | 同一套 Run 引擎上的 OpenAI Chat 适配。 |
| `POST` | `/v1/responses` | 需要 | 同一套 Run 引擎上的 OpenAI Responses 适配。 |

默认 **API Compatibility Profile**（三条推理端点共用）：

- 请求里的 `tools[]` 映射为 SDK `local.customTools`
- 存在调用方工具时内置 allowlist 为 `["mcp"]`，否则为 `[]`
- 拒绝 Cursor ambient 能力（`shell`、`read`、`edit`、`task`、`webSearch`、`webFetch`）
- `settingSources: []`，并使用空 workspace。不会隐式带上调用方仓库

## 认证

**BYOK（默认）。** 每个请求用 `Authorization: Bearer` 或 `x-api-key` 携带 Cursor API Key。进程只在内存中持有该密钥，并用不可逆 fingerprint 隔离会话。

**Managed（可选）。** 进程持有 `CURSOR_API_KEY`。客户端发送不同的 `GATEWAY_ACCESS_KEY`。Health 不会暴露 managed 模式下的 Cursor 身份。

**控制台账号。** 控制台把 Cursor 账号文件写到 `STATE_DIR/auths`（目录 `0700`、文件 `0600`，明文密钥）。刷新页面会从 `/v0/management/accounts` 重新加载这些密钥。该管理接口没有单独 Access Key。

禁止：浏览器 Cookie、Desktop/CLI 私有凭据库、邮箱密码登录、refresh token 导入，以及把密钥放进 URL、模型名或 tool ID。

## 运维控制台与额度

`/console/` 是同一 Node 进程提供的静态 Vite 资源，不需要第二个生产服务。

- 概览：health、SDK 版本、传输模式
- 账号：增删查持久化的 Cursor Key
- 额度：当前周期花费、剩余 included 用量、套餐元数据、模型族占比（Dashboard 返回时才有）
- 试跑：Messages、Chat Completions、Responses
- 接入：与本 README 相同的客户端配方
- 中 / 英、浅色 / 深色

`/v1/account` 会用同一把 User API Key 做两件事：官方 `Cursor.me()` 取身份，再用短期 Dashboard access token 调 `GetCurrentPeriodUsage` 和 `GetPlanInfo`。不需要 Cookie、Team Admin Key 或 OAuth Token。Dashboard 不可用时，身份仍可能返回，响应为 `status: partial` 并带明确 reason。缺失用量会被省略，不会编成 0。

## 架构与工具归属

```
Claude Code | Grok Build | Codex | OpenAI SDK | new-api | curl
        |
        v
HTTP /v1/messages | /v1/chat/completions | /v1/responses
        |
        v
协议解析（Chat / Responses -> 规范 ParsedMessages）
        |
        v
RunCoordinator
  SessionRegistry   （fingerprint、model、tool_use_id、TTL）
  ToolBridge        （调用方工具 -> local.customTools）
  EventPump         （唯一的 run.stream() consumer）
  协议写出           （Anthropic SSE | Chat data: | Responses 事件）
        |
        v
官方 @cursor/sdk  （Agent / Run / Jsonl store / models.list / me）
```

Chat Completions 和 Responses 没有第二套 session 引擎。只有解析器和 HTTP 写出层不同。

这里有两种完全不同的「工具」。混为一谈，就会幻想出 `x_search` 和静默 shell。

| 归属 | 跑什么 | 跑在哪里 |
|---|---|---|
| Claude Code / Grok / Codex | 它们的本机工具：读、改、shell，以及该客户端若开启的网页 / 网络搜索 | 你的项目目录，在客户端进程里 |
| 本网关 | 模型推理 + 工具*选择* | `@cursor/sdk` Agent，cwd 为空目录 |
| Cursor ambient 工具 | `shell`、`read`、`edit`、`task`、`webSearch`、`webFetch` | **拒绝** |
| xAI | `x_search` 及其他 xAI 原生托管工具 | **不在这条路径上** |

存在调用方工具时，prompt 会告诉模型：custom MCP 工具在 API 调用方环境执行，SDK cwd 不是权威路径。

## 协议说明

非流式 Messages 会返回 assistant 消息以及 `cursor_session_id`（`ses_...`）。已完成 follow-up 把它放进 `x-cursor-session-id`。

工具续轮使用同一进程内的 Agent/Run。最新 user turn 只能包含 `tool_result` 块，按 `tool_use_id` 匹配（顺序不是权威依据）。

```json
{
  "model": "composer-2.5",
  "max_tokens": 64,
  "tools": [{ "name": "lookup", "input_schema": { "type": "object" } }],
  "messages": [
    { "role": "user", "content": "weather?" },
    {
      "role": "assistant",
      "content": [{ "type": "tool_use", "id": "toolu_1", "name": "lookup", "input": { "q": "weather" } }]
    },
    {
      "role": "user",
      "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "72F" }]
    }
  ]
}
```

Chat Completions 使用同一个 session header。末尾的 `role:tool` 消息会继续同一个 pending run。`n` 只能是 `1` 或省略。流式帧是 OpenAI `data:` chunk，并以 `data: [DONE]` 结束。

Responses 的 pending 工具续轮只接受最新 `input` 全是 `function_call_output`，并且每个 `call_id` 对上当前 live tool id。`function_call_output.output` 接受字符串或文本 part。图片 / 文件型工具结果在能无损映射到 SDK 之前会 `422`。流式事件使用 Responses 事件名（`response.created` … `response.completed`）。出错时发 Responses `error` 事件，不会发假的 `response.completed`。

保持公开目录中的模型 ID 不变。例如 Grok 4.6 xhigh：

```json
{
  "model": "grok-4.6",
  "reasoning_effort": "xhigh",
  "max_tokens": 64,
  "messages": [{ "role": "user", "content": "hello" }]
}
```

高级调用方可通过 `cursor_model_params` 传入已校验的官方 SDK `{id,value}` 参数。同一 session 上显式改参数会得到 `409 cursor_session_conflict`。

`max_tokens` 会被接受，以便 Claude Code 形态的请求能解析。SDK Harness 没有精确的 max-token 强制执行，网关也不会模拟一层。工具选择会映射成 Harness 指令：Messages 支持 `auto` / `any` / 指定 `tool`；Chat 与 Responses 支持 `auto` / `required` / 指定 `function`。串行工具标志会生效。`tool_choice=none` 仍然 fail closed。

`temperature`、`top_p`、`stop_sequences` 会被接受，但**不会映射**到 `@cursor/sdk`。

默认工具批处理 debounce 是从最近一次 callback 起 1500ms（`TOOL_BATCH_SETTLE_MS`）。真实 SDK 探针观察到，同一 assistant turn 里 Claude callback 可能相隔超过 1 秒。

Usage：中间工具轮返回零 usage，并带 `usage_deferred: true`。累计 SDK usage 只在最终轮通过 `run.wait()` 确认一次。cache 与 reasoning 字段仅在 SDK 真正返回时出现。

公开错误类型：`invalid_request`、`authentication_error`、`forbidden`、`cursor_session_conflict`、`cursor_session_lost`、`rate_limited`、`cursor_empty_turn`、`cursor_upstream_error`、`cursor_timeout`。

## 安全与限制

把 v0.1 当成可信本地 sidecar。

- `/v0/management/accounts` 没有 Access Key，并返回原始 Cursor Key。
- `STATE_DIR/auths` 下的账号 JSON 是明文。优先使用加密卷。
- `STATE_DIR/sdk-store` 是官方 SDK 的对话 / checkpoint store。本网关不审计这些文件。
- `STATE_DIR/lineage` 只存 resume 元数据（session id、agent id、fingerprint、model、参数、pending tool id/name、可选 result digest）。不存 API Key、prompt 或工具载荷。
- Live 工具 callback 是内存 Promise。多实例和蓝绿部署需要排空连接，并对 session 做粘性归属。
- 崩溃后的 pending 恢复要求同一份 `STATE_DIR`，以及精确的身份 / 目录 / 结果批次匹配。不匹配就是 `409`，不会静默新建 Agent。重启后的 duplicate-same 没有持久化的 assistant 正文。
- 不要在共享主机上开启 payload logging，也不要设置 `DEBUG=*` 或 `DEBUG=proxy-agent`。
- 面向公网仍需要 TLS、认证代理、加密状态、监控，以及明确的威胁模型。进程内 fingerprint 隔离不是「可抵御恶意多租户托管」。
- 官方 `@cursor/sdk` 许可证和 Cursor Terms 仍然适用。见 [NOTICE.md](NOTICE.md)。
- 生产依赖 `npm audit --omit=dev`（2026-08-15）在 SDK 树中报告 3 个传递性发现：`undici`（high），以及 `@connectrpc/connect-node` / `@cursor/sdk`（moderate）。`fixAvailable` 为 false。不要执行破坏性的 `npm audit fix`。

尚未实现：

- Responses 的 `previous_response_id` 重建、`store=true`、background、conversation、未知 include 展开、托管内置工具
- xAI 原生 `x_search`
- Cursor Agent Profile（`/v1/agents`、原生 shell/edit、plan mode）
- 分布式 session 归属 / Redis / Postgres
- 官方 new-api 渠道类型

开发默认值：全局 4 个 active run、每个凭据 2 个、session TTL 30 分钟、replay TTL 10 分钟、run deadline 60 分钟。drain 期间仍接受等待中的 `tool_result`。本机默认 `STATE_DIR` 是 `$TMPDIR/cursor-sdk2api/state`。镜像和 compose 默认是 `/data`。

## 测试、证据、现状

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run dev` 会先构建一次控制台再启动网关。`npm run dev:web` 只跑 UI。

测试注入确定性 fake SDK，从不读取真实 Cursor 凭据。CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，会跑 typecheck、测试、构建和 `docker build`。

显式启用的 live 矩阵（不是默认 CI，也不会被 `npm test` 执行）：

```bash
npm run build
CURSOR_LIVE_SMOKE=1 CURSOR_API_KEY=... npm run live:smoke
```

runner 只绑定回环，并写脱敏 receipt。见 [`scripts/live-smoke/README.md`](scripts/live-smoke/README.md)。

已发布样本：[`docs/evidence/2026-08-15-live-smoke.md`](docs/evidence/2026-08-15-live-smoke.md)。有日期、绑定特定凭据，不能被另一个二进制继承。

- 宿主机上 Claude Sonnet 4.6 与 Fable 5 通过了要求的代理 Messages 矩阵，包括并行工具和 Claude Code 形态的 Fable 请求。
- Composer 2.5 通过了同一套宿主机矩阵，包括同轮并行选择。
- Grok 4.6 xhigh 通过了文本、SSE、单工具、多轮、replay、pending 重启 fail-closed（当时为 `409`）和 completed resume。同轮并行在一次运行里出现过、后来又没选满；不要宣传成保证行为。
- Node 22 容器证明两条 SDK 数据通路都会走已配置的 HTTP(S) 代理，代理不可达时会失败。Fable 容器的并行 / 上游成功并非完全可重复。
- 之后的本地运营探测（未作为公开回执入库）接通了真实 Claude Code（Sonnet 4.6）和 Grok Build（Responses，Grok 4.6），并确认这些客户端用自己的工作区文件工具写了标记。

当前是 v0.1。Chat Completions 和 Responses 是 Messages Run 引擎上的适配层。npm 发布、GHCR digest 和 new-api 上游 PR 都是后续独立决定。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Run 归属、代理传输、重启语义 |
| [docs/PROTOCOL_COMPATIBILITY.md](docs/PROTOCOL_COMPATIBILITY.md) | 端点与内容块支持矩阵 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 本机、Docker、drain 与升级 |
| [docs/SECURITY.md](docs/SECURITY.md) | 凭据、日志与威胁说明 |
| [docs/NEW_API_INTEGRATION.md](docs/NEW_API_INTEGRATION.md) | 通用 Anthropic / OpenAI sidecar |
| [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md) | 公开路线图 |
| [CHANGELOG.md](CHANGELOG.md) | v0.1 说明 |

## 许可与贡献

MIT。见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)。先写确定性 contract 测试，再做隔离 Docker 构建；真实 live smoke 仅使用显式提供的测试凭据执行。
