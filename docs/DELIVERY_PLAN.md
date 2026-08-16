# cursor-sdk2api 公开路线图

## 1. Alignment Snapshot

本路线图说明如何通过一个独立、MIT 许可、可直接部署的 HTTP 网关，把官方 `@cursor/sdk` Harness 转换为 Anthropic 和 OpenAI 兼容 API。

### Building

- 公开仓库：`Sunnyender-org/cursor-sdk2api`。
- 官方 `@cursor/sdk` 是唯一 Cursor 执行引擎。
- 独立网关，可直接供 Claude Code、OpenCode、Codex、SDK 和其他 HTTP 客户端使用。
- Anthropic Messages-first，随后增加 OpenAI Chat Completions 和 Responses。
- 原生 streaming、thinking、images、single/parallel tools、tool continuation、replay、usage 与 cache 字段。
- SDK Agent 生命周期、Store、resume、取消、超时、会话排空和清晰的进程重启语义。
- Docker-first 发布，并为 new-api 提供外部网关集成面。
- 可选的同进程 BF Labs Operator Console，用于健康检查、模型/账号读取、连接配置与协议测试。

### Not Building

- 不实现用户充值、计费、分组、渠道调度、账号池或多租户管理后台。
- 不逆向 Cursor 私有 H2、ConnectRPC、浏览器 Cookie 或 IDE OAuth 会话。
- 不把 Node.js 或 `@cursor/sdk` 内嵌进 new-api 主进程。
- 不默认开放 Cursor 的 shell、read、edit、task、web 或项目 settings。

## 2. Product Definition

### 2.1 Positioning

> `cursor-sdk2api` turns the official Cursor SDK harness into Anthropic- and OpenAI-compatible APIs with native streaming, thinking, parallel tools, continuation, replay, model discovery, and explicit session semantics.

它不是 Cursor 私有接口反代，也不是通用多供应商网关。它是一个窄而深的 Cursor SDK protocol gateway，类似 CPA 的独立部署形态，但执行层完全依赖官方 SDK。

### 2.2 Target Users

1. 想通过 Claude Code 使用 Cursor 模型和 Harness 的开发者。
2. 想通过 OpenAI/Anthropic SDK、curl 或自动化系统调用 Cursor 模型的团队。
3. 希望把 Cursor 作为 provider 接入 new-api、one-api 或内部网关的运维者。
4. 需要自托管、BYOK、模型发现和稳定工具续轮的基础设施维护者。

### 2.3 User Jobs

- 用一个 Cursor API Key 启动本地网关，并看到实时模型目录。
- 将 Claude Code 的 base URL 指向网关，完成多轮和工具任务。
- 让多个客户端以标准 Messages、Chat 或 Responses 协议使用同一套 Cursor 模型。
- 部署在 Docker 中，查看 health、能力位和无敏感信息的运行指标。
- 将网关作为 new-api 的外部 Cursor SDK 渠道，而不是在 new-api 内运行 Node SDK。

### 2.4 Success Metrics

- v0.1 六模型/协议核心矩阵无空成功：所有终止响应必须有文本、结构化工具调用或显式错误。
- single 和 parallel tool continuation 的结果 ID、顺序、错误和 replay 均有 deterministic contract test。
- 网关自身事件转发开销 p95 不超过 100 ms；该指标不含上游模型推理时间。
- 第一条 SDK text/thinking delta 到客户端对应 SSE delta 的转发延迟 p95 不超过 100 ms。
- 默认日志和测试 artifact 中 API Key、Bearer Token、Cookie、工具原始参数和工具原始结果泄漏数为 0。
- 发布镜像能在干净 Linux Docker 环境独立启动，不依赖其他项目的文件、数据库或网络。

## 4. Product Principles

1. **Official SDK only**：协议、模型、工具与 Agent 生命周期只通过公开 SDK。
2. **API semantics first**：客户端工具由客户端执行；默认不让 Cursor Harness 额外操作文件或 shell。
3. **Fail closed**：无内容终止、未知 tool ID、身份变化、会话丢失和 usage 不确定都不能伪装成功。
4. **One live run, one owner**：同一个工具会话在任一时刻只有一个 worker 拥有 SDK Run。
5. **No duplicate side effects**：重试和 replay 必须按 request/tool result digest 幂等。
6. **Evidence before claims**：fixture 只证明转换逻辑；真实模型兼容必须由使用专用测试凭据的 live matrix 证明。
7. **Small core, optional scale**：单实例是默认产品；多实例能力通过明确接口增量加入。

## 5. Runtime Profiles

### 5.1 API Compatibility Profile — v0.1 Default

适用于 `/v1/messages`、后续 `/v1/chat/completions` 和 `/v1/responses`。

- SDK 是唯一推理执行器。
- 请求 `tools[]` 动态映射为 `local.customTools`。
- SDK tool surface 限制为 MCP/customTools。
- 默认禁用 `shell`、`read`、`edit`、`task`、`webSearch`、`webFetch`。
- `settingSources: []`，不加载宿主机用户或项目 Cursor 配置。
- 使用空 workspace；不把调用者仓库、环境变量或文件系统隐式传给 Cursor。
- Claude Code/OpenCode/Codex 是外层 Agent；Cursor Harness 负责模型推理和工具选择。

### 5.2 Agent Profile — Post-v0.3 Optional Surface

未来独立 `/v1/agents` 承载：

- Cursor native tools。
- plan/agent mode。
- fast/model parameters。
- subagents、artifacts、branches 和 Cloud Agents。
- 经明确配置加载的 settings、hooks、plugins 和 MCP。

Agent Profile 不与兼容 API 默认路径混用；其权限、workspace 和外部副作用需要单独安全模型与发布合同。

## 6. High-Level Architecture

```text
Claude Code / OpenCode / Codex / SDK / curl
                      |
                      v
              HTTP Protocol Layer
       Messages | Chat | Responses | SSE
                      |
                      v
             Session / Run Coordinator
        identity | state | replay | timeout
                      |
                      v
            Tool Bridge + Event Pump
       customTools | parallel batch | usage
                      |
                      v
                official @cursor/sdk
             Agent | Run | Store | Models
                      |
                      v
             Cursor runtime and models
```

### 6.1 Core Modules

| Module | Responsibility |
|---|---|
| `protocols/anthropic` | Messages request parsing, SSE, content blocks, errors and usage |
| `protocols/openai-chat` | v0.2 Chat/tool conversion |
| `protocols/openai-responses` | v0.2 Responses events, items and tool continuation |
| `core/run-coordinator` | one event consumer per SDK Run, state transitions and terminal semantics |
| `core/session-registry` | tool ID and session indexes, identity binding, TTL and drain |
| `core/tool-bridge` | dynamic customTools, pending calls, parallel batches and result resolution |
| `core/replay` | request digest, cached terminal response and idempotency |
| `sdk/runtime` | Agent create/resume/send/close, Run stream/wait/cancel |
| `sdk/store` | SDK Store selection and agent lineage |
| `sdk/catalog` | models and exposed parameters |
| `auth` | BYOK/managed mode and credential fingerprinting |
| `account` | identity and capability-based spending/limit lookup |
| `server` | routing, request limits, cancellation, health and shutdown |

## 7. Public API Contract

### 7.1 v0.1 Endpoints

| Endpoint | Auth | Contract |
|---|---|---|
| `GET /health` | none | build, SDK version, runtime mode, readiness and capability bits; no account data |
| `GET /v1/models` | required | live Cursor catalog with stable public model IDs and exposed params |
| `GET /v1/account` | required | authenticated identity plus capability-based spending/limit fields |
| `POST /v1/messages` | required | Anthropic-compatible stream and non-stream text/tool contract |
| `POST /v1/chat/completions` | required | OpenAI Chat adapter over the same Messages run engine |
| `POST /v1/responses` | required | OpenAI Responses adapter over the same Messages run engine. Tool continuation is `function_call_output.call_id`; completed follow-up is `x-cursor-session-id`. `previous_response_id` is rejected. |

### 7.2 Health Shape

Health returns at least:

```json
{
  "status": "ok",
  "service": "cursor-sdk2api",
  "version": "0.1.0",
  "sdk_version": "1.0.x",
  "runtime": "local",
  "capabilities": {
    "messages": true,
    "chat_completions": true,
    "responses": true,
    "streaming": true,
    "thinking": true,
    "images": true,
    "tools": true,
    "parallel_tools": true,
    "replay": true,
    "agent_resume": true,
    "pending_tool_restart_resume": false
  }
}
```

Capabilities are runtime truth, not marketing constants. `pending_tool_restart_resume` remains false until kill/restart live acceptance proves exact pending callback recovery.

### 7.3 Models Contract

- Source is `Cursor.models.list()`.
- Public response preserves exact Cursor catalog IDs; it does not invent provider-prefixed aliases.
- Expose model parameters such as context, effort, reasoning, thinking and fast only when SDK catalog reports them.
- Catalog cache is credential-fingerprint scoped; one credential cannot observe another credential's catalog.
- Development cache default is five minutes and configurable; stale cache can serve only with an explicit stale marker after a live refresh failure.

### 7.4 Account Contract

- Identity comes from official SDK/account surface where available.
- Spending、limits 和 remaining 来自同一把 User API Key 的 Cursor Dashboard 当前周期接口；只返回上游真实数值。
- 不抓取浏览器 Cookie，不要求 Team Admin API，不导入 OAuth token，不推断未返回额度。
- 部分能力不可用时返回 `status: partial` 和 capability reason；身份成功不能被 spending 缺失升级为伪造数据。

### 7.5 Messages Contract

- 支持 string 和 content-block system/messages。
- 支持 text、thinking、image、tool_use、tool_result。
- 支持 stream 和 non-stream。
- 支持同一 assistant turn 的多个 tool calls。
- tool result 请求只解析最新 user turn；混合新文本与 tool result 默认 422。
- request model、credential identity 和 session owner 在续轮中不可变化。
- terminal turn 必须包含语义输出或显式错误。

## 8. Session And Tool State Machine

```text
Creating
  -> Running
  -> AwaitingToolResults
  -> Resuming
  -> Running
  -> AwaitingToolResults (zero or more rounds)
  -> Completed

Any state -> Failed -> Closed
Any active state -> Cancelled -> Closed
```

### 8.1 Session Identity

内部 session 绑定：

- random session ID。
- credential fingerprint，不存明文 key。
- model ID 与 effective params。
- SDK agent ID、run ID 和 Store identity。
- current worker/instance ID。
- pending tool ID set。
- last activity、deadline 和 replay records。

任何 credential、model、store identity 或 instance generation 不匹配都 fail closed。

### 8.2 Parallel Tool Semantics

- pending 结构必须是以 `toolUseId` 为键、`PendingCall` 为值的 Map，禁止单 pending shortcut。
- 同一 assistant turn 已观察到的调用一次性作为一个 tool batch 返回。
- client 可以在同一个 user turn 返回全部结果；结果顺序不作为匹配依据，ID 才是权威。
- mixed-session IDs、unknown IDs、missing required IDs、duplicate different result 均返回 conflict/validation error。
- duplicate identical result 返回相同 replay response，不再次 resolve 或执行。

### 8.3 Single Event Pump

- 每个 SDK Run 只有一个后台 consumer 读取 `run.stream()`。
- HTTP handler 只 attach/detach response sink，不重复迭代 Run stream。
- customTool callback 是 client tool call 的权威来源；SDK tool event 只用于补充状态和诊断，并按 call ID 去重。
- terminal 后再用 `run.wait()`校验状态、usage 和结果。

### 8.4 Restart Semantics

SDK Store 和 `Agent.resume()`可以恢复 Agent 历史与后续会话，但正在等待外部 tool result 的 in-process Promise 不可假定可序列化。

v0.1 规则：

- graceful deploy 优先 session drain，不中断 active owner。
- completed/replay state 可持久化并恢复。
- Agent history 可通过 Store + `Agent.resume()`恢复。
- pending tool turn 只有在 kill/restart acceptance 证明 SDK 会重新建立同一 callback 后才宣告可恢复。
- 未证明时返回 `409 cursor_session_lost`；不自动创建新 Agent 重放可能有副作用的工具轮。
- 从完整 transcript 新建 Agent 的 fallback 仅用于明确的新 follow-up，不用于伪装原 pending Run 已恢复。

## 9. Authentication And Credential Modes

### 9.1 BYOK — Default

- 请求 `Authorization: Bearer` 或 `x-api-key` 直接承载 Cursor API Key。
- 网关只在内存中传给 SDK，并以不可逆 fingerprint 做会话隔离。
- API Key 不写日志、不写 Store、不写 replay、不进入 error body。

### 9.2 Managed Key — Optional

- 服务器通过环境或 secret mount 配置 Cursor API Key。
- 客户端使用独立 gateway access key。
- gateway key 与 Cursor key 必须是不同 secret namespace。
- health 不透露 managed mode 的 Cursor identity。

### 9.3 Forbidden Credential Paths

- 浏览器 Cookie。
- Cursor Desktop/CLI 私有 credential store 复制。
- email/password 自动登录。
- refresh token 导入。
- 把 Cursor key 放入 URL、query、模型名、tool ID 或 telemetry。

## 10. Usage, Cache And Accounting Semantics

- 网关透传 SDK 实际返回的 input、output、cache read、cache write。
- 不从价格、prompt 差值或后续 cache hit 反推 cache write。
- SDK 返回累计 usage 时，同一 Run 只在 final turn 对外确认一次累计值。
- 工具中间轮返回零 usage 并明确 `usage_deferred: true`，避免多次计算累计值。
- replay 返回原始 final usage，不产生新的 usage claim。
- standalone gateway 不做人民币、美元、quota 或模型倍率计费。
- 调用方网关负责根据 final usage 计费。

## 11. Streaming Contract

- SDK thinking/text delta 到达后立即向当前 sink 转发。
- Anthropic SSE 顺序遵循 `message_start -> content blocks -> message_delta -> message_stop`。
- tool input JSON 可分片，但 content block 必须在名称和 ID 已知后开始。
- client disconnect before first semantic output：取消 Run 并关闭 Agent。
- disconnect after complete tool batch emitted：保留 AwaitingToolResults session。
- result-resume response disconnect：Run 可继续进入短 replay buffer；相同 result digest 可重新 attach。
- buffer 超限、TTL 到期或 explicit cancel：终止 Run，返回可辨识错误。

## 12. Error Contract

| Error | HTTP | Meaning |
|---|---:|---|
| `invalid_request` | 400/422 | body、tool schema、mixed content 或模型参数非法 |
| `authentication_error` | 401 | 缺失或无效 credential |
| `forbidden` | 403 | Cursor account/model/region permission 拒绝 |
| `cursor_session_conflict` | 409 | model、credential、instance 或 result digest 冲突 |
| `cursor_session_lost` | 409 | owner 进程/Run 不可恢复 |
| `rate_limited` | 429 | gateway 或 Cursor 并发/配额限制 |
| `cursor_empty_turn` | 502 | SDK terminal 无 text、thinking、tool 或 explicit upstream error |
| `cursor_upstream_error` | 502/503 | SDK/transport/provider error |
| `cursor_timeout` | 504 | first event、tool wait、resume 或 run deadline 超时 |
| `client_closed` | 499 in logs | client abort，不保证写出 response |

错误体不得包含 API Key、Cookie、原始工具参数/结果、文件内容或内部 endpoint。

## 13. Concurrency, TTL And Drain

- 资源限制分为 global active runs、per-credential active runs 和 awaiting sessions。
- 达到上限返回 429；不得驱逐 Running session 给新请求让路。
- 开发默认 4 global / 2 per credential；发布默认值由 v0.1 load gate 选取，不高于通过错误率和内存门的最大安全值。
- AwaitingToolResults TTL 以 `last_activity`刷新，默认 30 分钟，可配置到 5–60 分钟。
- replay TTL 默认 10 分钟。
- 总 Run deadline 默认 60 分钟；provider/SDK 更短 deadline 优先。
- graceful shutdown：停止新 session，继续路由 existing tool results，active session 归零后退出；最大 drain deadline 与 Run deadline 对齐。
- hard crash：依照 Restart Semantics fail closed 或恢复，不由 load balancer 随机重放。

## 14. Repository Shape

```text
cursor-sdk2api/
├── src/
│   ├── auth/
│   ├── account/
│   ├── core/
│   ├── protocols/
│   │   ├── anthropic/
│   │   ├── openai-chat/
│   │   └── openai-responses/
│   ├── sdk/
│   ├── server/
│   └── index.ts
├── tests/
│   ├── contract/
│   ├── integration/
│   └── fixtures/
├── scripts/
│   └── live-smoke/
├── docs/
│   ├── DELIVERY_PLAN.md
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL_COMPATIBILITY.md
│   ├── SECURITY.md
│   ├── DEPLOYMENT.md
│   └── NEW_API_INTEGRATION.md
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── LICENSE
├── NOTICE.md
└── README.md
```

## 15. Technology And Dependency Decisions

- TypeScript ESM。
- Node.js >= 22.19。
- npm lockfile。
- exact pinned `@cursor/sdk` version；升级必须跑完整 contract + live matrix。
- Node HTTP 或 Hono 作为轻量 server；promotion spike 以 streaming、abort 和 SSE ergonomics 决定，禁止引入大型 web framework。
- SDK built-in SQLite/JSONL Store 为默认持久层；自定义 distributed store 是 v0.3 interface，不是 v0.1 强制依赖。
- 单元与 contract tests 使用 Vitest 或 Node test runner；promotion spike 选择测试可读性和 fake timer/stream 支持更好的一个，仓库只保留一种。
- runtime dependency 必须说明用途、许可证和移除条件。

## 16. Licensing And Provenance

- 新仓库采用 MIT License，copyright owner 为 Sunnyender-org/贡献者。
- `@cursor/sdk` 作为 npm dependency，不 vendor、patch 或重新分发其源码和平台二进制。
- README 明确本项目不是 Cursor/Anysphere 官方项目。
- 用户必须使用合法 credential 并遵守 Cursor Terms 和适用法律。
- 不复制其他网关的 adaptor、计费、数据库、UI 或部署代码。
- 可基于我们独立编写的 sidecar 行为合同进行 clean extraction；抽取前做 file-level provenance audit。
- 若复用 MIT 项目片段，保留原 copyright/license notice 并在 NOTICE 记录。

## 17. Delivery Phases

### Phase 0 — Repository Bootstrap

Deliverables:

- public-ready repository skeleton, MIT, NOTICE, README and contribution policy。
- TypeScript build、lint/typecheck、unit test、Docker build CI。
- no-secret logging baseline and redaction tests。
- pinned SDK dependency and SDK license/Terms note。

Gate:

- local checker/build/tests pass。
- no private runtime/import/path dependency。
- public repository contents pass secret and provenance review。

Stop condition:

- provenance audit cannot establish a clean MIT boundary。

### Phase 1 — v0.1 Messages Vertical Slice

Deliverables:

- `/health`、`/v1/models`、`/v1/account`、`/v1/messages`。
- text + SSE vertical slice first。
- thinking/images。
- dynamic customTools。
- single/parallel tool batches。
- multi-round continuation、replay、usage/cache。
- Store、Agent lineage、resume and explicit session-lost。
- Docker deployment docs and live-smoke scripts。

Gate:

- contract suite passes。
- isolated Docker suite passes。
- approved real Cursor matrix passes。
- independent reviewer checks protocol, credentials, concurrency and idempotency before public release。

Stop condition:

- Sonnet/Fable tool continuation requires private protocol or produces unresolved empty success。

### Phase 2 — v0.2 OpenAI Compatibility

Deliverables:

- `/v1/chat/completions`。
- `/v1/responses`。
- tool_choice、parallel tools、reasoning、images and continuation translation。
- protocol-specific usage and error mapping。

Gate:

- Chat and Responses each pass independent text, stream, tool, parallel, continuation and error suites。
- Codex/OpenCode real-client smoke is not substituted by curl fixture。

Stop condition:

- protocol abstraction forces lossy behavior that breaks Messages correctness；Messages remains the canonical internal contract。

### Phase 2.5 — Optional BF Labs Operator Console

Prerequisite:

- `/health`、`/v1/models`、`/v1/account` 与至少一个推理协议已稳定；Responses 不作为控制台首个竖切前置条件。

Deliverables:

- 同一 Node 进程在 `/console/` 提供静态 React/Vite 控制台，不增加生产前端服务或线程。
- 使用 vendored MIT BF Labs UI tokens/components；不依赖私有 package registry。
- runtime overview、模型目录、官方账号 surface、Messages/Chat/Responses playground 与 Claude Code/OpenAI/new-api 配置复制。
- 原始 Cursor Key 不进入浏览器持久化。账号按 CPA 风格持久化到服务端 `STATE_DIR/auths` 的 `0700`/`0600` JSON 文件；v0.1 不增加 Console Access Key。
- 英文默认、中文切换、light/dark、desktop 与 390px 验收。

Non-goals:

- 用户、充值、计费、分组、渠道调度、日志 payload 浏览与网页修改 `.env`。
- 复制 CPA/New API 的完整管理域；这里只保留账号文件的最小增删查。

Gate:

- frontend typecheck/build、静态资源/CSP/path traversal contract tests、Docker build/run 通过。
- 真实浏览器读取 health；使用隔离测试 key 时才能验收 models/account/playground。
- desktop 与 390px 无横向溢出、控制台错误、浏览器原始 Cursor Key 持久化或误导性能力声明。

Stop condition:

- 前端要求新增 billing/user/channel 数据模型；该需求留给上层 new-api/BeefAPI，不扩张 standalone gateway core。

### Phase 3 — v0.3 Operational Reliability

Deliverables:

- optional Redis/Postgres registry interface。
- owner lease and fencing。
- multi-instance tool result routing。
- active-session aware draining。
- durable replay records and metrics。
- kill/restart and rolling-deploy acceptance harness。

Gate:

- no mixed credential/session resume。
- owner death and duplicate delivery produce deterministic result。
- deploy does not terminate live session before drain deadline。

Stop condition:

- distributed recovery cannot preserve at-most-once tool result semantics；retain single-instance supported mode instead of false HA。

### Phase 4 — Upstream New API Integration

Prerequisite:

- standalone v0.1 release exists at a stable tag and immutable image digest。

Deliverables in `QuantumNous/new-api`:

- optional `Cursor SDK Gateway` channel type/adaptor。
- Base URL、Key、model discovery、account/health capability。
- existing new-api protocol conversion routes to gateway Messages API。
- frontend channel form and i18n。
- tests and docs linking `Sunnyender-org/cursor-sdk2api`。
- PR template preserved and PR body discloses AI-assisted implementation per upstream rule。

Non-goal:

- upstream new-api does not bundle Node.js、SDK or gateway container。

Gate:

- upstream tests pass。
- upstream PR submission follows the target project's contribution process。
- README and PR cross-links use the real PR URL only after it exists。

## 18. Acceptance Matrix

| Criterion | Evidence level | Test or manual evidence | Status | Notes |
|---|---|---|---|---|
| Repository has no private code/runtime dependency | local | dependency graph plus `rg`/build from current local snapshot | passed-local | Clean-checkout proof remains a release gate |
| Health reports runtime capability truth | fixture | health contract tests with enabled/disabled features | passed-local | Live-smoke fields remain explicitly false/unverified |
| Models preserve exact Cursor IDs and params | real-smoke | live catalog snapshot with redacted identity | passed-live | Exact Sonnet 4.6, Fable 5, Grok 4.6 xhigh and Composer 2.5 IDs resolved |
| Account endpoint never fabricates spending or remaining | fixture + real-smoke | dashboard exchange/usage fixtures plus opt-in live read | fixture-passed | Live dashboard read required before release claim; browser Cookie path forbidden |
| Messages non-stream text is protocol-correct | real-smoke | exact opaque marker | passed-live | Sonnet 4.6, Fable 5, Grok 4.6 xhigh and Composer 2.5 passed |
| Messages stream forwards text incrementally | real-smoke | first/last delta timing trace without content logging | passed-live | All four required models passed with SDK `onDelta` |
| Thinking block order is valid | real-smoke | Fable 5/Sonnet thinking SSE parser | pending | Must finish content blocks correctly |
| Single tool round-trip works | real-smoke | tool_use -> tool_result -> exact final | passed-live | All four required models passed |
| Parallel tool round-trip works | real-smoke | at least two calls returned in one assistant batch before results | partial-live | Sonnet, Fable and Composer passed; Grok model selection remains nondeterministic |
| Multiple tool rounds work | real-smoke | two sequential tool batches then exact final | passed-live | All four required models passed on the same SDK Run |
| Identical result retry is idempotent | integration | same digest returns byte/semantic equivalent response | passed-local | No second resolve |
| Different result for same tool ID fails | integration | conflict fixture | passed-local | No side-effect replay |
| Mixed/missing/unknown tool IDs fail closed | integration | table-driven session fixtures | passed-local | No empty 200 |
| Empty terminal turn returns `cursor_empty_turn` | integration | fake SDK TurnEnded/EOF fixture | passed-local | Core regression locked |
| Usage/cache emitted once at final turn | integration + real-smoke | cumulative SDK usage fixture and cache live probe | passed-live | Intermediate usage deferred; Claude cache creation and reads observed from SDK usage |
| Credential identity cannot cross sessions | integration | two-key fingerprint fixture without real keys | passed-local | Isolation regression covered |
| Default logs contain no secrets/tool payloads | local + real-smoke | log capture, secret canary scanner and redacted receipt scan | passed-live | Three isolated receipts contained no credential, Bearer token, home path or personal identity |
| Client disconnect cancels or retains by contract | integration | abort-before-output and abort-after-tool fixtures | passed-local | Each path deterministic |
| Graceful shutdown drains active sessions | integration | controlled signal and active-count harness | passed-local | Includes drain continuation and capacity behavior |
| Hard restart behavior is explicit | real-smoke | kill/restart pending tool test | passed-live | All four required models returned `cursor_session_lost`, never empty success |
| Docker image starts independently | local | Docker build/run, HEALTHCHECK and health readback | passed-local | Clean-checkout rebuild remains a release gate; no external bind mount |
| Claude Code Fable 5 passes | real-smoke | isolated real client transcript receipt | passed-live | No raw prompts/tool results retained |
| OpenAI Chat compatibility passes | real-smoke | v0.2 client matrix | pending | Local Chat contract suite exists; live Chat matrix is not claimed |
| OpenAI Responses compatibility passes | real-smoke | v0.2 Codex/OpenCode matrix | pending | Local Responses contract suite exists; live Codex/OpenCode is not claimed and is not substituted by curl fixtures |
| new-api optional channel passes upstream checks | dev | upstream targeted/full tests and PR review | pending | Phase 4 only |

## 19. Live Model Matrix

Live acceptance uses a dedicated test credential; it must never query an arbitrary production user token.

| Model | Text | Stream | Thinking | Single Tool | Parallel Tool | Multi-round | Replay |
|---|---|---|---|---|---|---|---|
| `claude-sonnet-4-6` | required | required | required | required | required | required | required |
| `claude-fable-5` | required | required | required | required | required | required | required |
| `grok-4.6` with highest supported effort | required | required | if exposed | required | required | required | required |
| `composer-2.5` | required | required | if exposed | required | required | required | required |

Model names are refreshed from live catalog before the matrix; renamed/retired models are recorded as catalog drift, not silently aliased.

### 2026-08-15 Isolated Live Receipt

- Catalog authentication passed and resolved all four exact model IDs; Grok 4.6 was invoked with explicit `effort=xhigh` while preserving its public model ID.
- Grok 4.6 xhigh passed text, SSE, single tool, multi-round tools, duplicate-result replay, pending-restart failure semantics, and completed-agent resume. Same-turn parallel was observed in one dedicated live run but selected only one tool in a later combined run, so repeatability remains open.
- Composer 2.5 passed the same required matrix.
- Sonnet 4.6 and Fable 5 passed the full required host matrix through the explicit dual proxy path (`agent_transport=http1-proxy`, `fetch_transport=undici-proxy`), including same-turn two-tool continuation, restart semantics and completed resume.
- The immutable Node 22.19 image passed authenticated catalog/account and real Claude text/tool traffic through the configured proxy. An unreachable-proxy control made catalog/account/Agent fail, proving neither SDK data plane silently escaped to a direct connection. Fable container parallel selection/upstream success was not perfectly repeatable and remains recorded as model/upstream variance rather than a green container matrix.
- Claude Code-shaped Fable 5 passed. No private protocol or model alias fallback was used.
- An earlier unproxied child-run `403 region_unsupported` conclusion is superseded; the live-smoke launcher had stripped standard proxy variables.
- Redacted public summary: `docs/evidence/2026-08-15-live-smoke.md`; full machine receipts remain private and outside git.

## 20. CI And Release Gates

### Pull Request CI

- install from lockfile。
- typecheck。
- unit + contract tests。
- build。
- Docker build。
- no live credentials in public CI。

### Release Candidate

- clean checkout build。
- isolated Docker acceptance。
- opt-in live model matrix using a dedicated test credential。
- independent security/protocol review for v0.1。
- changelog and compatibility matrix updated。
- artifact SBOM、image digest and provenance receipt。

### Release Actions

Separate release decisions are required for:

1. run credentialed live smoke。
2. publish npm package。
3. push GHCR image。
4. create GitHub Release/tag。
5. submit upstream new-api PR。

## 21. Observability And Privacy

Default structured logs may include:

- request correlation ID generated by gateway。
- model ID、stream flag、status、duration bucket。
- safe tool call count and pending count。
- session state transition and opaque session/worker fingerprint。
- usage numeric totals after final turn。

Default logs must not include:

- API Key、Authorization header、Cookie。
- raw prompt、system、assistant text、thinking。
- tool schema、args、result、stdout/stderr。
- file path、repository content、Cursor account email。
- full upstream error body if it may echo request data。

Debug mode is explicit opt-in, allowlisted and still redacted；README 必须警告不要在共享环境开启 payload logging。

## 22. Risk Register

| Risk | Impact | Mitigation | Release consequence |
|---|---|---|---|
| SDK API/version drift | build or runtime break | exact pin, types inspection, full matrix on upgrade | block upgrade release |
| SDK all-rights-reserved/Terms change | distribution risk | dependency only, current Terms review, partner/legal confirmation | block public release if unresolved |
| Pending callback lost on crash | broken tool continuation | drain, explicit session_lost, restart acceptance, later durable broker | no HA claim until passed |
| Duplicate tool result | repeated external side effect | digest idempotency and one resolve | block v0.1 |
| Mixed credentials or tenants | privacy/correctness incident | fingerprint binding, negative tests and owner lease | block v0.1 |
| Empty SDK terminal | false success and wrong billing | semantic output gate | block v0.1 |
| Cumulative usage double counted | user overcharge | defer intermediate usage, final once, replay same usage | block gateway billing integrations |
| Ambient Cursor tools execute | unexpected filesystem/network mutation | API Profile tool denylist + empty workspace/settings | block v0.1 |
| Model catalog rename | clients break | exact live catalog, no guessed aliases, drift diagnostics | document and version compatibility |
| Public CI leaks credential | credential compromise | no live secrets in PR CI, manual protected smoke | rotate and stop release |
| Upstream PR rejected | no native new-api channel | standalone gateway remains fully usable | not a product blocker |

## 23. Documentation Deliverables

- `README.md`: English-first positioning, quick start, API examples, boundaries and non-official disclaimer。
- `README.zh-CN.md`: Chinese usage and architecture summary。
- `ARCHITECTURE.md`: Run/session/tool/event ownership。
- `PROTOCOL_COMPATIBILITY.md`: endpoint/block/event support matrix。
- `SECURITY.md`: credentials, logging, threat model and disclosure。
- `DEPLOYMENT.md`: local, Docker, BYOK, managed key, drain and upgrade。
- `NEW_API_INTEGRATION.md`: external gateway config and future PR link。
- `CONTRIBUTING.md`: test layers, no-secret fixtures and live-smoke gate。
- `CHANGELOG.md`: semantic versions and protocol compatibility changes。

## 24. Implementation Handoff

### Recommended First Vertical Slice

1. Bootstrap TypeScript package and CI locally。
2. Implement `/health` with runtime capability source。
3. Implement authenticated `/v1/models`。
4. Implement non-stream Messages text via one Agent/Run。
5. Add streaming text using the single event pump。
6. Add one custom tool callback and result resume。
7. Generalize to parallel tool Map and replay。
8. Add thinking/images/usage/cache。
9. Add Store/resume and restart semantics。
10. Package Docker and run isolated matrix。

Each step must extend the same vertical path; do not build OpenAI translators before Messages tool continuation is real-smoke verified。

## 25. Current Delivery Gate

截至 2026-08-15，Sonnet 4.6 与 Fable 5 已通过宿主机完整 18-case 验收，包含并行工具、缓存读写、completed resume 和 Fable Claude Code shape；Node 22 不可变镜像已用成功/死代理对照证明 Agent 与 fetch 两条 SDK 数据通路均受代理控制，并完成真实 Claude 文本与工具调用。Fable 容器 parallel/upstream 仍有非确定性，因此没有被包装成全绿容器矩阵。Composer 2.5 已通过完整 v0.1 live matrix；Grok 4.6 xhigh 除同轮 parallel 选择可重复性外均通过。`/v1/responses` 已有本地 contract 测试（文本、SSE 生命周期、reasoning、图片、function tools、并行、`function_call_output` 续轮、replay、usage、fail-closed 错误），不是 Codex/OpenCode live smoke。下一道模型技术 gate 是定义 parallel repeatability threshold；npm/GHCR 发布、生产部署和 upstream PR 仍是独立后续步骤。

协议范围、credential modes、默认工具权限、公开许可、repository ownership 或 release path 的实质变化，应在本路线图中明确记录。
