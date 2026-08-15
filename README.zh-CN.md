# cursor-sdk2api

[English](README.md)

独立 MIT 网关：把官方 Cursor TypeScript SDK（`@cursor/sdk`）暴露成 Anthropic 与 OpenAI 兼容 HTTP API。

这不是 Cursor / Anysphere 官方产品。它不逆向私有 Cursor 传输、Cookie、Desktop/CLI 凭据库或 IDE 会话。唯一的 Cursor 执行引擎是公开发布的 `@cursor/sdk`。使用者必须提供合法获得的 Cursor API Key，并遵守 Cursor 服务条款。

**v0.1 以 Anthropic Messages 为先。** `/v1/chat/completions` 和 `/v1/responses` 都是同一套 Run 引擎上的协议适配层（已有 contract 测试，不是真实模型验收声明）。

## v0.1 包含什么

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/console/` | 页面加载无需 | 可选 BF Labs 运维控制台。页面发起 API 请求仍需 key，且只保存在当前标签页的 React 内存中。 |
| `GET` | `/health` | 无 | 构建版本、SDK 版本、就绪状态、**已实现**能力位、网络传输模式，以及独立的 `verification` 对象。能力位为 `true` 只表示网关实现了该路径，不是真实模型验收声明。`/health` 不含账号数据、密钥或代理 URL。 |
| `GET` | `/v1/models` | 需要 | 实时 `Cursor.models.list()` 目录，保留精确公开模型 ID。不可用时返回空列表并给出明确 reason。 |
| `GET` | `/v1/account` | 需要 | 身份来自 `Cursor.me()`。花费和额度字段仅在官方接口真正返回时出现。 |
| `POST` | `/v1/messages` | 需要 | Anthropic Messages 文本、SSE、客户端工具、同轮并行工具、多轮 continuation，以及进程内 replay。 |
| `POST` | `/v1/chat/completions` | 需要 | OpenAI Chat Completions 适配：文本、`data:` SSE + `[DONE]`、function tools、continuation、`reasoning_content`、base64 `image_url`。与 Messages 共用同一套 session/run 引擎。 |
| `POST` | `/v1/responses` | 需要 | OpenAI Responses 适配：`input` 字符串或 item、Responses SSE + `response.completed`、reasoning、base64 `input_image`、`type=function` 工具、按 `call_id` 续轮 `function_call_output`。与 Messages 共用同一套 session/run 引擎。`previous_response_id` / 托管工具 / `store=true` 会 fail closed。控制台 playground 仍只有 Messages/Chat。 |

默认 **API Compatibility Profile**：

- 请求里的 `tools[]` 映射为 SDK `local.customTools`。
- 存在客户端工具时内置 allowlist 为 `["mcp"]`，否则为 `[]`。
- 拒绝 Cursor ambient 能力（`shell`、`read`、`edit`、`task`、`webSearch`、`webFetch`）。
- `settingSources: []`，并使用空 workspace。不会隐式带上调用方仓库。

## 快速开始

需要 Node.js 22.19 或更新版本。

```bash
npm ci
npm run build
export AUTH_MODE=byok
node dist/index.js
```

打开 `http://localhost:8080/console/` 使用可选运维控制台。Health 无需 key；
模型、账号和协议测试请求使用只存在于页面内存中的 key，刷新或关闭标签页后即清除。

```bash
curl -s localhost:8080/health
curl -s localhost:8080/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

Docker：

```bash
docker build -t cursor-sdk2api:local .
docker run --rm -p 8080:8080 -e AUTH_MODE=byok cursor-sdk2api:local
```

`docker-compose.yml` 是单服务包装。它把 `STATE_DIR` 默认设为命名卷上的 `/data`，并且不携带密钥。

完整配置面见 [`.env.example`](.env.example)。不要提交真实密钥。

## 出站代理

官方 SDK 不会自动继承宿主机代理。设置受支持的代理变量后，网关会同时接管 **两条** SDK 数据通路：

- 本地 Agent 切换到 HTTP/1.1，并通过 `proxy-agent` 出站
- 模型目录和账号查询走 Undici 的环境代理 dispatcher

`HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY` 与 `NO_PROXY` 的大小写形式均接受。代理 URL 必须是 `http://` 或 `https://`。SOCKS / PAC 会 fail closed，因为两条 SDK 通路无法一致支持它们。未配置代理时，Agent 保留官方 HTTP/2 传输。

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

不要把带 userinfo 的代理 URL 写进 compose 或文档。优先使用无凭据的回环地址，或把凭据放在单独保护的环境里。

## 认证

**BYOK（默认）。** 每个请求用 `Authorization: Bearer` 或 `x-api-key` 携带 Cursor API Key。进程只在内存中持有该密钥，并用不可逆 fingerprint 隔离会话。

**Managed（可选）。** 进程持有 `CURSOR_API_KEY`。客户端发送不同的 `GATEWAY_ACCESS_KEY`。Health 不会暴露 managed 模式下的 Cursor 身份。

禁止：浏览器 Cookie、Desktop/CLI 私有凭据库、邮箱密码登录、refresh token 导入，以及把密钥放进 URL、模型名或 tool ID。

## API 示例

非流式 Messages 会返回 assistant 消息以及 `cursor_session_id`（`ses_...`）。后续 completed follow-up 把它放进 `x-cursor-session-id`：

```bash
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -H "x-cursor-session-id: ses_replace_me" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"continue"}]}'
```

Chat Completions 使用同一个 session header。非流式响应会返回 `cursor_session_id` 和 `x-cursor-session-id`。末尾的 `role:tool` 消息会继续同一个 pending SDK run：

```bash
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"hello"}]}'
```

`n` 只能是 `1` 或省略。远程 `image_url` 会被 `422` 拒绝，需要 base64 data URL。流式帧是 OpenAI `data:` chunk（每帧后空一行，没有 Anthropic event 名），并以 `data: [DONE]` 结束。`stream_options.include_usage=true` 会在 `[DONE]` 前多发一个 `choices=[]` 的 usage chunk。

`/v1/responses` 使用同一套 Run 引擎。已完成 follow-up 仍走 `x-cursor-session-id`。pending 工具续轮只接受最新 `input` 全是 `function_call_output`，并且 `call_id` 对上当前 live tool id。`previous_response_id` 会被拒绝；这不是无状态的 OpenAI store。

```bash
curl -s localhost:8080/v1/responses \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","input":"hello"}'
```

流式事件使用 Responses 事件名（`response.created` … `response.completed`）。出错时发 Responses `error` 事件，不会发假的 `response.completed`。托管工具、`store=true`、background、conversation 和 include 展开会 fail closed。

`function_call_output.output` 接受字符串或文本 content part 数组。图片/文件型工具结果在能够无损映射到 SDK 前会以 `422` fail closed，不会静默转成 JSON 文本。

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

工具续轮使用同一进程内的 Agent/Run。最新 user turn 只能包含 `tool_result` 块：

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

对于 `/v1/messages`，`max_tokens` 会被接受，以便 Claude Code 形态的请求能解析。SDK Harness 没有精确的 max-token 强制执行，网关也不会模拟一层。`temperature`、`top_p`、`stop_sequences` 和 `tool_choice` 会被接受，但 **不会映射** 到 `@cursor/sdk`。对于 `/v1/chat/completions` 和 `/v1/responses`，`tool_choice` 只能是 `auto` 或省略；其他值会以 `422` fail closed。

错误体：

```json
{
  "type": "error",
  "error": { "type": "invalid_request", "message": "..." },
  "request_id": "req_..."
}
```

公开错误类型：`invalid_request`、`authentication_error`、`forbidden`、`cursor_session_conflict`、`cursor_session_lost`、`rate_limited`、`cursor_empty_turn`、`cursor_upstream_error`、`cursor_timeout`。

## 原生工具闭环

broker 在进程内持有一个 SDK Agent/Run。

1. 第一次请求可以在同一 assistant turn 返回 N 个 `tool_use` 块。
2. 下一次请求的最新 user turn 只能发送 `tool_result` 块。
3. 结果按 `tool_use_id` 匹配，顺序不是权威依据。
4. 错误、缺失、跨 session 或 duplicate-different ID 都会 fail closed。
5. duplicate-same 结果会 replay 已存储的 turn，不会再次 resolve。
6. HTTP sink 会在 deferred tool Promise resolve 之前挂上。
7. `run.stream()` 只有一个 consumer。

默认工具批处理 debounce 是从最近一次 callback 起 1500ms（`TOOL_BATCH_SETTLE_MS`）。真实 SDK 探针观察到，同一 assistant turn 里 Claude callback 可能相隔超过 1 秒；收到第一个就封包会丢掉后续 pending 调用。

pending callback 是普通内存 Promise，不能跨进程序列化。

## Usage 与 cache

- 中间工具轮返回零 usage，并带 `usage_deferred: true`。
- 累计 SDK usage 只在最终轮通过 `run.wait()` 确认一次。
- cache 字段仅在 SDK 真正返回时出现。缺失字段会被省略，不会编造。

## 状态、resume 与多实例

MVP 只在创建该 live run 的进程里持有它。

- 蓝绿和多实例部署需要排空连接，并对 session 做粘性归属。
- 进程重启后，未完成的工具续轮返回 `409 cursor_session_lost`。
- 网关不会新建 Agent 来假装原来的 pending Run 已经恢复。

带 `x-cursor-session-id` 的 completed follow-up，在 `SESSION_TTL_MS` 内且 credential / model / 显式模型参数匹配时，可以通过 `Agent.resume` 续聊。`pending_tool_restart_resume` 保持 `false`，直到 kill/restart 验收证明能精确恢复 callback。

`STATE_DIR` 存放：

- 官方 JSONL SDK store：`$STATE_DIR/sdk-store/<credential-fingerprint>`
- 仅属主可读写的 lineage 元数据：`$STATE_DIR/lineage`（`0700` / `0600`）

本机 / 开发默认是 `$TMPDIR/cursor-sdk2api/state`。镜像和 compose 默认是 `/data`。lineage 只存 resume 元数据（session id、SDK agent id、fingerprint、model、显式参数、state、pending tool id、可选 result digest、时间戳）。它不存 API Key、prompt 或工具载荷。assistant replay 正文不会落盘，因此重启后的 duplicate-same 也是 `cursor_session_lost`。

BYOK 凭据共享进程容量上限，但官方 SDK store 和空 workspace 按 credential fingerprint 分区。这是进程内租户隔离，不是“可抵御恶意多租户托管”的声明。

开发默认值：全局 4 个 active run、每个凭据 2 个、session TTL 30 分钟、replay TTL 10 分钟、run deadline 60 分钟。active-run 限制适用于 create、completed follow-up 和持久化 resume。drain 期间仍接受等待中的 `tool_result`。

## 现状与证据

v0.1 已实现 Messages 文本/SSE、客户端 customTools/MCP、同轮并行工具、多轮 continuation、进程内 replay、租户/模型隔离、completed Agent resume，以及 pending 重启 fail closed。Chat Completions 和 Responses 是这套引擎上的协议适配，已有 contract 测试，不是真实模型验收声明。运维控制台 playground 仍只覆盖 Messages/Chat；Responses 通过 `/v1/responses` 的 contract 测试验收，不走控制台 UI。

脱敏、不含秘密的验收摘要见 [`docs/evidence/2026-08-15-live-smoke.md`](docs/evidence/2026-08-15-live-smoke.md)。这份 receipt 是有日期的本地样本，不能保证每个凭据、地区或镜像都一样：

- 宿主机上 Claude Sonnet 4.6 与 Fable 5 通过了要求的代理矩阵，包括并行工具和 Claude Code 形态的 Fable 请求。
- Composer 2.5 通过了要求的宿主机矩阵，包括同轮并行选择。
- Grok 4.6 xhigh 通过了文本、SSE、单工具、多轮、replay、pending 重启 fail-closed 和 completed resume。该样本里同轮并行选择是 **模型非确定** 的，**不能**当作保证行为。
- Node 22 容器证明两条 SDK 数据通路都会走已配置的 HTTP(S) 代理，代理不可达时会失败。Fable 容器的并行/上游成功 **并非** 完全可重复，因此 **不会** 宣传成全绿容器矩阵。
- 运行时 `/health.verification.live_smoke` 保持 `false`。二进制无法推断另一次部署继承了这份 receipt。

thinking 和 image 块已实现并有 contract 测试。真实模型上的 thinking/image 粒度仍是独立模型 gate。

## 已知限制

- 运行时必须使用官方 `@cursor/sdk`。其自身许可证和 Cursor Terms 仍然适用。见 [NOTICE.md](NOTICE.md)。
- 生产依赖 `npm audit --omit=dev`（2026-08-15）在 SDK 树中报告 3 个传递性发现：`undici`（high），以及 `@connectrpc/connect-node` / `@cursor/sdk`（moderate）。`fixAvailable` 为 false。不要执行破坏性的 `npm audit fix`。
- `Cursor.me()` 目前不暴露花费或剩余额度；因此 `/v1/account` 在官方接口补齐这些字段前是 `partial`。
- 进行中工具轮的硬崩溃恢复是 `cursor_session_lost`，不是高可用。
- 带凭据的真实模型测试需要显式启用，不属于默认 CI。

尚未实现：

- Responses 的 `previous_response_id` 重建、`store=true`、background、conversation、include 展开，以及托管内置工具（`web_search`、`file_search`、`computer`、`shell`、`apply_patch`）
- Cursor Agent Profile（`/v1/agents`、原生 shell/edit、plan mode）
- 分布式 session 归属 / Redis / Postgres

## 开发

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run dev` 会先构建一次控制台再启动网关。只调试 UI 时可运行
`npm run dev:web`；只有开发者明确配置代理时，Vite 才会把 API 请求转发到网关。

测试注入确定性 fake SDK，从不读取真实 Cursor 凭据。GitHub Actions CI 见 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)，会跑 typecheck、测试、构建和 `docker build`。

显式启用的 live 矩阵（不是默认 CI，也不会被 `npm test` 执行）：

```bash
npm run build
CURSOR_LIVE_SMOKE=1 CURSOR_API_KEY=... npm run live:smoke
```

runner 只绑定回环，在临时目录写脱敏 receipt，并且从不记录密钥、prompt 或工具载荷。见 [`scripts/live-smoke/README.md`](scripts/live-smoke/README.md)。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Run 归属、代理传输、重启语义 |
| [docs/PROTOCOL_COMPATIBILITY.md](docs/PROTOCOL_COMPATIBILITY.md) | 端点与内容块支持矩阵 |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | 本机、Docker、drain 与升级 |
| [docs/SECURITY.md](docs/SECURITY.md) | 凭据、日志与威胁说明 |
| [docs/NEW_API_INTEGRATION.md](docs/NEW_API_INTEGRATION.md) | 把网关当作通用 Anthropic 上游使用 |
| [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md) | 公开路线图与后续阶段 |
| [CHANGELOG.md](CHANGELOG.md) | v0.1 说明 |

在存在已发布镜像 digest 之前，把 Claude Code、OpenCode 或通用 Anthropic 客户端指向 `http://<gateway-host>:8080`，密钥用 Cursor key（BYOK）或 gateway access key（managed）。不要把 `@cursor/sdk` 嵌进另一个网关进程。

## 安全

- 不要在共享主机上开启 payload logging。
- 不要在共享主机上设置 `DEBUG=*` 或 `DEBUG=proxy-agent`；第三方传输日志可能打印代理配置。
- 把 `STATE_DIR` 当作仅属主可访问的敏感状态。官方 SDK store 可能包含对话和 checkpoint 数据；本网关不会审计这些文件。
- 面向公网部署仍需要 TLS、访问控制、加密状态、监控，以及明确的运营威胁模型。
- 默认日志可以包含 request id、model id、stream 标志、status、pending 数量和最终数值 usage。不得包含密钥、Cookie、prompt、thinking、工具 schema、工具参数或工具结果。

## 许可与贡献

MIT。见 [LICENSE](LICENSE) 与 [NOTICE.md](NOTICE.md)。

贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)。先写确定性 contract 测试，再做隔离 Docker 构建；真实 live smoke 仅使用显式提供的测试凭据执行。
