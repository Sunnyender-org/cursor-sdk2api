---
half_life: 7d
archive_at: 2026-09-08
artifact_mode: delivery-doc
scope_type: version
scope_name: cursor-sdk2api-v0.4-full-type62-sync
coverage: cursor-sdk2api 从 v0.3.1 同步到 BeefAPI 2026-09-01 type62 可观察执行能力的完整版本计划，包含 Issue #25 热修、Sand、耐久运行账本、协议兼容、控制台、new-api 集成与真实验收
not_complete_for: 实际代码实现、PR 合并、真实凭据使用、npm 或镜像发布、BeefAPI 生产变更、type64 私有协议
verification_level: real-smoke
real_smoke_status: requires_approval
review_status: reviewed
reviewer: codex
review_command: python3 /Users/sunny/.agents/skills/delivery-planner/scripts/check_delivery_doc.py docs/TYPE62_FULL_SYNC_PLAN.md
review_notes: 基于 cursor-sdk2api v0.3.1、Issue #25/PR #26、BeefAPI type62 当前源码、生产 A/B 与仓库门禁进行自审
review_owner: Ender
review_due: 2026-09-08
execution_backend: direct
lead_agent: current
peer_agents: none
builder_agent: none
verifier_agent: none
verification_independence: self_checked
cwf_decision: not_needed
cwf_trigger_boundary: none
goal_handoff: skipped
acceptance_contract_status: proposed
memory_required: false
memory_space: beefapi
acceptance_memory_id: none
memory_asserted_by: none
memory_confirmed_by: none
memory_intended_for: cursor-sdk2api-maintainer,beefapi-cursor-maintainer
memory_validity: proposed
memory_valid_from: 2026-09-01
memory_review_due: 2026-09-08
---

# cursor-sdk2api v0.4 完整同步 BeefAPI type62 落地计划

## 1. Alignment Snapshot

这份计划帮助 `cursor-sdk2api` 维护者把独立网关同步到 BeefAPI 最新 type62 的可观察能力，同时保留独立 MIT 网关的单进程、无钱包、无 BeefAPI 用户系统边界。

### 要建设

- 先发布 `v0.3.2`，修复 GitHub Issue #25 的 Anthropic SSE 中途错误终止问题。
- 发布 `v0.4.0`，补齐 `sdk` / `sand` runtime profile、Grok Bot 权限与额度、隔离运行目录、耐久 Agent/Run/Interaction/receipt、Responses Compact/opaque continuation、受控 hosted search、断线后台收敛、控制台与 new-api 集成。
- 建立一份可执行的 type62 parity matrix，让后续同步不再依赖人工记忆。

### 不建设

- 不移植 BeefAPI 用户、Token、钱包、充值、渠道调度、全站限流或运营后台。
- 不引入 type64 Agent v1 私有协议，也不把 type64 Sand endpoint 的失败行为混入 type62。
- 不提供 xAI 原生 `x_search`，不开放 Cursor ambient shell/read/edit/task。
- 不自动在 SDK 额度耗尽后切换 Sand；profile 必须由管理员显式选择并绑定到整个 Run。
- 不在本计划中执行 npm、GHCR、生产部署或真实凭据 smoke；这些是独立 G3-A Owner gate。

### 当前真相

- `cursor-sdk2api`：`v0.3.1` / `1e18349f556efde716634f6368fe8bd9532e06eb`，`@cursor/sdk 1.0.30`，236 个测试、typecheck、build 通过。
- 当前仓库直接 secret scan 会命中忽略目录中的本地 `.env`、`_temp` 和 SDK store；干净 `git archive` 扫描为零泄漏。
- BeefAPI type62：生产 commit `9b1a65a6d71a18d75e95847f2740ba8e347824ff`；channel 271 的 sdk run 1332 与 sand run 1333/1334 均 finished，profile 和 receipt 可读回，测试后恢复 sdk。
- Issue #25 已有外部 PR #26，但没有 CI receipt，不能按提交者勾选项直接视为已验收。

## 2. Work Contract

```yaml
outcome: cursor-sdk2api v0.4 在独立网关边界内覆盖 BeefAPI 最新 type62 的可观察执行能力，并先以 v0.3.2 关闭 Issue #25
known_and_fixed:
  - official @cursor/sdk 仍是唯一 Cursor 推理引擎
  - sdk 是默认 profile；sand 只能显式选择且不得静默互退
  - client tools 仍由调用端工作区执行
  - BeefAPI 平台账本语义要适配为独立网关运行账本，不能复制钱包或用户系统
material_assumptions:
  - @cursor/sdk 1.0.30 的 Sand bundle 形状需要重新审计，不能沿用 1.0.28 hash
  - Node 22 运行环境允许使用本地 SQLite；若部署环境不满足，停止在 S1，不以 JSON 多源状态替代
boundaries:
  allowed:
    - src tests docs web integrations package manifests
    - 本地 fixture、fault injection、临时状态目录和干净源码扫描
  forbidden:
    - 未批准的真实 Cursor 凭据、Dashboard 调用、npm/GHCR 发布、生产部署
    - 浏览器 Cookie、Cursor 私有 HTTP transport、BeefAPI 用户 token
    - 为通过测试而削弱 profile、credential、tool id 或 receipt fence
success_and_evidence:
  - 所有 P0/P1 acceptance 通过确定性测试
  - 真实 SDK/Sand、Claude Code、Codex/new-api smoke 在单独批准后通过
  - 每个真实 Run 只有一个 provider Send、一个 terminal usage 和一个 receipt
decision_state: assumption-bounded
owner_gate: Sand 公共发布和真实凭据 smoke 分别单独批准；未批准时只完成本地实现与 fixture
route: skill:delivery-planner
stop_conditions:
  - 1.0.30 bundle hash 或替换计数不能稳定锁定
  - Sand Terms/产品边界未获 Owner 批准却进入默认或公开发布路径
  - 终态 usage 或单次 receipt 无法可靠归属
  - Issue #25 的终止序列在真实 Claude Code 中被证明会把失败误判为成功
modules:
  - src/core
  - src/sdk
  - src/protocols
  - src/account
  - src/server
  - web
  - integrations/new-api
  - tests
```

### G3 边界

```yaml
g3:
  class: both
  risk_and_blast_radius: 凭据隔离、持久化恢复、幂等 receipt、Sand 源码加载与真实上游额度均属敏感面；发布会影响所有独立网关客户端
  design_boundary: 本地可实现和测试；profile、账本与迁移必须 fail closed
  action_boundary: 真实凭据、外部 PR 合并、npm/GHCR 与生产部署分别授权
  data_and_permission_boundary: 不保存 Dashboard access token；User API Key 仍只在 owner-only account store；运行账本不得包含 prompt、thinking、tool args/result
  observability: request id、profile、run/agent/receipt 短 ID、状态、数值 usage；不记录内容和凭据
  rollback: v0.3.2 可独立回退；v0.4 保留 LEDGER_V2=0、HOSTED_SEARCH_MODE=off 和默认 sdk；旧 lineage 只读保留
  owner_gate: Sand 公开发布、真实额度 smoke、外部 PR 合并和正式 release
  release_gate: CI 全绿 + structural/security review + real-smoke receipt + clean archive secret scan
  stop_conditions: 任一身份 fence、重复 Send、重复 receipt、迁移破坏或凭据泄漏
```

## 3. 产品与架构决策

### 3.1 “完整同步”的定义

完整同步不等于逐文件复制 BeefAPI。完成标准是：BeefAPI type62 的每个对独立网关有意义的可观察能力都被分类为 `port`、`adapt` 或 `skip`，且 P0/P1 项有可执行验收。没有未分类能力。

```text
API clients
  ├─ /v1/messages
  ├─ /v1/chat/completions
  └─ /v1/responses + /v1/responses/compact
          │
          ▼
  CursorAgentTurn + protocol policy
          │
          ▼
  DurableRunCoordinator
    ├─ RuntimeProfile: sdk | sand
    ├─ Agent / Run / Interaction ledger
    ├─ Provider receipt + terminal usage
    ├─ Tool callback / replay / recovery
    └─ Disconnect observer + drain
          │
          ▼
  ProfiledSdkRuntime
    ├─ sdk: official @cursor/sdk 1.0.30
    └─ sand: hash-guarded loader + isolated store/workspace
```

### 3.2 独立网关适配原则

- BeefAPI 的 PostgreSQL/GORM、tenant/user/token/channel 维度不进入本仓库。
- 独立网关使用 SQLite WAL 作为唯一运行账本，账户仍由现有 owner-only JSON store 管理。
- provider receipt 用于幂等、审计和 new-api 对接，不负责人民币或美元钱包扣费。
- managed account pool 仍是路由 owner；profile 是 account/default/request policy，不创建第二个账户池实现。
- v0.4 不以升级 SDK 包冒充同步；1.0.30 需独立通过所有新 contract 和 live gate。

## 4. 完整能力同步矩阵

| 能力 | 当前 v0.3.1 | v0.4 决策 | 优先级 | 验收所有者 |
|---|---|---|---|---|
| Messages/Chat/Responses 单协调器 | 已有 | preserve | P0 | contract tests |
| Issue #25 中途 SSE 错误终止 | 缺陷 | port/fix，先发 v0.3.2 | P0 | Claude Code fixture + real negative |
| sdk/sand runtime profile | 无 | port | P0 | runtime/profile tests |
| Sand access/usage RPC | 无 | port | P0 | Dashboard fixture + live readback |
| Sand store/workspace 隔离 | 无 | port | P0 | filesystem isolation tests |
| Sand 1.0.30 bundle hash guard | 无 | adapt | P0 | exact hash/replacement tests |
| profile 绑定 Agent/Run/续接 | 无 | port | P0 | conflict/restart tests |
| Agent/Run/Interaction durable ledger | JSON lineage | adapt 为 SQLite | P0 | migration/recovery tests |
| claim generation 与重复 owner fence | 部分 singleflight | port | P0 | race/fault tests |
| provider receipt 唯一性 | 无平台 receipt | adapt | P0 | receipt idempotency tests |
| terminal usage snapshot | 内存响应 | port | P0 | restart replay tests |
| 下游断线后后台 Observe/Finalize | 部分 session 保留 | port | P0 | disconnect replay tests |
| Responses compaction_trigger | 无 | port | P1 | Codex fixture/live smoke |
| `/responses/compact` | 无 | port | P1 | compact contract tests |
| opaque continuation anchor | 无 | adapt 为本地签名 anchor | P1 | tamper/cross-account tests |
| base64 图片 | 已有 | preserve | P1 | three-protocol tests |
| hosted webSearch/webFetch | 禁用 | opt-in port，默认 off | P1 | search policy matrix |
| xAI native x_search | 禁用 | skip | P1 | fail-closed tests |
| document/audio/video | 无 | skip，稳定 4xx | P1 | negative tests |
| true parallel provider execution | tool batch 有 | preserve 当前语义，不额外宣称 | P1 | existing parallel tests |
| account pool model-aware routing | 已有 | preserve + profile-aware | P1 | managed pool tests |
| account/Grok Bot console | 无 | port | P1 | desktop + 390px browser |
| new-api channel integration | 基础 | port profile/receipt/compact | P1 | compose E2E |
| BeefAPI 钱包/用户/渠道调度 | 无 | skip | 非目标 | boundary tests/docs |
| type64 private Agent v1 | 无 | skip | 非目标 | dependency denylist |

## 5. Issue #25 / PR #26 热修计划（v0.3.2）

### 5.1 当前问题

Anthropic streaming 在已经发送 `message_start` 或 content delta 后遇到 terminal error，handler 直接输出 SSE `error` 并结束连接，缺少完整的 block/message 终止序列。Claude Code 报“response stopped arriving”。

### 5.2 PR #26 处理方式

不直接盲合并 `79c6396760211dc5ce66e72450dfd00b626444c5`。先在隔离分支复核并按以下合同修正：

1. `RunCoordinator.applyBoundary()` 只能让 writer 处理一次 terminal failure；HTTP handler 不得再写第二个 error。
2. `AnthropicTurnWriter.fail()` 在 headers 已发送时：
   - 关闭所有已开启 content blocks；
   - 输出 `message_delta` 和 `message_stop`；
   - 再输出带 request id 且已脱敏的 `error`；
   - 幂等地结束 response。
3. headers 未发送时保持现有 JSON error，不伪造 SSE 成功生命周期。
4. Chat/Responses writer 行为保持不变，但补回归证明没有双终止。
5. 真实 Claude Code 负向验收必须证明：客户端不再报传输中断，同时仍能识别请求失败，不能把 partial response 当成功。

### 5.3 v0.3.2 验收

- Fixture 顺序：`message_start -> content_block_delta -> content_block_stop -> message_delta -> message_stop -> error`。
- `writer.fail()`、handler catch 和 `res.end()` 各只执行一次。
- error body 使用 `toPublicErrorBody()`，不含上游 raw message、凭据或 tool payload。
- 现有 236 测试加新增 regression 全绿。
- GLM-5.2 或 fault-injected Claude Code real negative 通过后才关闭 Issue #25。
- v0.3.2 独立发布，不等待 v0.4.0。

## 6. v0.4 技术合同

### 6.1 Runtime profile

```ts
type RuntimeProfile = "sdk" | "sand";

interface RuntimePolicy {
  defaultProfile: RuntimeProfile;       // 默认 sdk
  allowRequestOverride: boolean;        // 默认 false
  hostedSearchMode: "off" | "auto";   // 默认 off
}
```

- managed mode：账号可配置 `default_profile`；管理端变更只影响新 session。
- BYOK：默认 sdk；只有 `ALLOW_REQUEST_RUNTIME_PROFILE=true` 时接受 `x-cursor-runtime-profile`。
- session policy digest 必须包含 profile；同一 session 改 profile 返回 `409 cursor_session_conflict`。
- Sand profile 必须先通过 `GetSandAccessStatus=GRANTED`；结果缓存最多 10 分钟，拒绝和权限撤销 fail closed。
- sdk 与 sand 使用不同 workspace、SDK store、runtime capacity key 和 health 状态。
- 禁止 SDK 失败后自动切 Sand，禁止 Sand 额度耗尽后自动切 SDK。

### 6.2 Sand loader

- 以安装后的 `@cursor/sdk 1.0.30` 为输入，生成临时 profile-specific loader，不 vendor 或提交修改后的 SDK bundle。
- 固定允许修改的 ESM 文件、原始 SHA256、目标 SHA256、替换字符串和精确替换次数。
- 任一 hash、文件数或替换次数不匹配，进程拒绝启动 Sand runtime。
- loader 只修改 client-type 必要位置；Statsig/遥测身份变化必须单列 review，默认禁止超出 BeefAPI 已验证的最小集合。
- `/health` 只返回 profile、SDK version、patch contract version 和是否 ready，不返回本地路径或凭据。

### 6.3 SQLite 运行账本

SQLite 使用 WAL、foreign keys 和原子事务；`STATE_DIR/runtime.db` 权限为 `0600`。

```text
runtime_agents
  id, credential_fingerprint, runtime_profile, sdk_agent_id,
  model, policy_digest, generation, state, created_at, updated_at

runtime_runs
  id, agent_id, logical_key, runtime_profile, sdk_run_id,
  state, observe_offset, usage_json, receipt_id,
  terminal_digest, generation, started_at, terminal_at

runtime_interactions
  run_id, tool_call_id, tool_name, args_digest,
  result_digest, state, delivered_at, acknowledged_at

provider_receipts
  receipt_id, run_id, state, usage_json, finalized_at
```

约束：

- `(credential_fingerprint, runtime_profile, sdk_agent_id)` 唯一。
- logical request 只能有一个 active owner；generation CAS 防迟到进程覆盖。
- receipt id 唯一；重连、Observe、SubmitResult 不创建第二条。
- usage、terminal snapshot 与 receipt finalization 在同一事务收敛。
- 表中禁止 prompt、thinking、tool schema/args/result、API Key、Dashboard token。

### 6.4 迁移和回滚

- 首次启动只读扫描现有 lineage v2 和 ordinary-turn journal；兼容记录导入 SQLite，原文件不删除。
- 不完整、过期或 policy digest 不匹配记录进入 quarantine，不猜测恢复。
- `RUNTIME_LEDGER_V2=0` 可回到 v0.3.2；v0.4 写入期间旧引擎只读，禁止双写成两个 truth source。
- 完成一个发布周期和 migration receipt 后，另开版本删除 legacy reader；不在 v0.4 首发删除。

### 6.5 Protocol parity

- 保留三协议同一 `CursorAgentTurn` 与 RunCoordinator。
- `compaction_trigger` 和 `/responses/compact` 返回唯一 opaque compaction item，不创建重复 inference。
- standalone anchor 使用 gateway-local HMAC 签名和 account/profile/policy binding；格式使用独立命名空间，不冒充 BeefAPI `v3.*`。
- tampered、跨 account、跨 profile、跨 model/tool policy anchor 一律 409/422。
- hosted search 只在 `HOSTED_SEARCH_MODE=auto` 且客户端选择 live+auto 语义时进入官方 `webSearch/webFetch`；filters、required、named 或 Chat `web_search_options` 保持 fail closed。
- `x_search` 始终不是本通路能力。

### 6.6 Disconnect、drain 与 receipt

- 客户端断线只关闭 writer；已绑定 Run 继续后台 Observe 到 terminal/failure，再 final usage 和 receipt。
- 相同 logical request 重试 attach/replay，不第二次 Send。
- 进程 shutdown 在 1 秒内拒绝新 session；awaiting tool result 继续接受结果；已有 Run 在配置的 grace 内收敛。
- grace 到期且无法恢复的 Run 标记 `runtime_lost`，receipt 保留 provisional/floor 语义但不伪造最终 usage。
- standalone 不执行钱包退款；把 receipt 状态和 authoritative usage 暴露给上层 new-api adapter。

### 6.7 Console 与账户 API

账户页保持 utility-first：

```text
┌ Account / Model catalog ─────────────────────────────┐
│ account hint   plan   SDK 1.0.30   status            │
│ Runtime: [SDK] [Sand]   Sand access: Granted         │
├ Cursor period ──────────┬ Grok Bot weekly period ────┤
│ used / remaining        │ used / remaining / reset   │
├ Runtime health ─────────┴─────────────────────────────┤
│ sdk ready · sand ready · active runs · drain state   │
└───────────────────────────────────────────────────────┘
```

- Cursor 普通额度与 Grok Bot 周额度必须独立进度条，不合并百分比。
- Sand 按钮只在 grant、loader ready 和 SDK catalog 三项通过时可选。
- profile 变更文案明确“仅影响新会话”。
- management API 仍只允许 loopback/受认证反代；不新增公网管理 token 旁路。
- desktop 与 390px mobile 无横向溢出，长 modal 可滚动，light/dark 都验证。

### 6.8 new-api 集成

- channel template 增加 profile/default、Grok Bot quota 和 receipt capability，不加入 BeefAPI 私有 token。
- new-api 可通过受控 header 或管理配置设置 profile；默认 sdk。
- Responses Compact、Chat、Messages 和 streamed error contract 做 compose E2E。
- 上层如要计费，只采 terminal usage + provider receipt；不从 HTTP 重试次数推断消费。

## 7. 分阶段落地

### S0 — v0.3.2 Issue #25 热修

交付：复核/修正 PR #26、确定性回归、真实 Claude Code 负向 smoke、独立 tag。

退出条件：Issue #25 关闭；partial error 既完整终止 SSE，又保持失败语义；clean archive scan 通过。

### S1 — Parity inventory 与 profile skeleton

交付：`docs/TYPE62_PARITY_MATRIX.md`、profile types/config、session policy binding、SDK/Sand runtime registry、1.0.30 patch contract fixture。

退出条件：默认 sdk 零行为变化；Sand hash mismatch fail closed；所有能力有 port/adapt/skip 分类。

### S2 — Sand 额度与控制台 vertical slice

交付：Dashboard access/usage、account profile、隔离 store/workspace、console 独立进度条、health。

退出条件：fixture 覆盖 grant/revoke/zero/quota reset；浏览器 desktop/390px；无真实凭据时不宣称 live。

### S3 — Durable Native V2 standalone ledger

交付：SQLite schema/migration、Agent/Run/Interaction、generation claim、terminal snapshot、provider receipt、disconnect observer、drain。

退出条件：kill/restart、duplicate、disconnect、late owner、tool result 和 receipt race 全部确定性通过；structural/security review 无 P1/P2 未解决项。

### S4 — Protocol parity

交付：Compact、opaque anchor、search policy、Messages/Chat/Responses error/finalization、new-api adapter。

退出条件：三协议共享一个 Run；Compact exactly-one；search 正负矩阵；unsupported surface 稳定 4xx。

### S5 — Real-smoke 与 v0.4 release candidate

交付：SDK/Sand A/B、Claude Code/Codex/new-api、Dashboard usage attribution、migration/rollback、SBOM/provenance、release notes。

退出条件：所有 P0/P1 real-smoke 通过；profile restored to sdk；真实凭据和机器 receipt 不进入仓库；Owner 批准后才发布。

## 8. 验收矩阵

| Criterion | Evidence level | Test or manual evidence | Status | Notes |
|---|---|---|---|---|
| Issue #25 partial SSE error 完整终止且保持失败语义 | fixture | 新 Messages contract test + handler double-write negative | pending | v0.3.2 P0 |
| Claude Code 不再报告 response stopped arriving | real-smoke | fault injection 或 GLM-5.2 负向 smoke | requires approval | 不以 HTTP 200 代替客户端终态 |
| 默认 SDK 行为与 v0.3.1 无回归 | local | 现有 236 tests + SDK A/B | pending | v0.4 P0 |
| Sand 1.0.30 loader 精确且 fail closed | fixture | hash/file/replacement contract tests | pending | 不复用 1.0.28 hash |
| sdk/sand session 互不 attach | local | profile conflict/restart tests | pending | profile 进入 policy digest |
| Sand 权限撤销即时阻断新 Run | fixture + real-smoke | Dashboard grant/revoke fixture；真实 readback | requires approval | 已有 Run 不改 profile |
| SDK 与 Sand 各一条真实 Run 成功 | real-smoke | exact marker + persisted receipt | requires approval | 测试后恢复 sdk |
| Grok Bot 使用归因可读 | real-smoke | before/after usage 或 Cursor usage event | requires approval | 允许上游延迟观察窗口 |
| logical request 不重复 Send/receipt | local | duplicate/reconnect/race tests | pending | 关键 P0 |
| 断线后 terminal usage 与 receipt 收敛 | local + real-smoke | disconnect retry + ledger readback | requires approval | 客户端断线不取消 owner |
| restart 不盲重发已绑定 Run | local | kill/restart/runtime_lost tests | pending | authoritative usage 不明时不伪 final |
| Compact exactly-one 且下一轮可继续 | local + real-smoke | `/compact` + compaction_trigger + Codex | requires approval | 不冒充 OpenAI store |
| Hosted search 正负矩阵正确 | local + real-smoke | auto/live pass；required/filter/Chat options 4xx | requires approval | 默认 off |
| Console 独立额度和 profile 可用 | browser | desktop + 390px light/dark screenshots | pending | 无合并进度条 |
| new-api compose E2E | dev | Messages/Chat/Responses/Compact/profile/receipt | pending | 不需要 BeefAPI 生产凭据 |
| tracked source 无 secret | local + CI | clean git archive gitleaks | pass | 当前源码已通过 |
| 本地 live state 不被误扫为源码泄漏 | local | scan docs/runbook 明确 clean-tree 与 workspace 两种模式 | pending | `.env/_temp/STATE_DIR` 仍是敏感数据 |
| v0.4 rollback 可恢复 v0.3.2 | local + dev | migration dry-run + LEDGER_V2=0 | pending | 原 lineage 不删除 |

## 9. 性能与可靠性目标

- 不含 Cursor 上游时间的请求解析和 policy 选择 p95 小于 25ms。
- SQLite 单次状态事务 p95 小于 20ms；busy timeout 明确，不能静默丢写。
- profile/Dashboard grant cache hit p95 小于 10ms；TTL 不超过 10 分钟。
- streamed text 首个本地 SSE write 在收到 SDK delta 后 50ms 内完成。
- SSE idle keepalive 15 秒；连接结束不得存在重复 terminal event。
- shutdown 1 秒内停止接收新 session；已有 Run 按配置 grace 收敛。
- 同一 logical request 在任意重试/断线/恢复路径中 provider Send count = 1、receipt count = 1。

## 10. Review 与发布门禁

### 每阶段必过

```bash
npm run typecheck
npm test
npm run build
npm run secret:scan
```

`secret:scan` 的发布证据必须来自 clean clone 或 clean `git archive`；workspace 扫描命中 `.env/_temp/STATE_DIR` 时按本地敏感状态处理，不得删除证据或把规则放宽到忽略真实源码泄漏。

### S3 后结构门禁

- 对 SQLite ledger、recovery、generation CAS、disconnect observer 和 receipt 做 `structural-review`。
- Builder 不能同时作为独立 Verifier；release candidate 需要独立安全/恢复审查。
- 不接受第二个 run coordinator、第二个 account pool 或 JSON+SQLite 双 truth source。

### Release Owner gates

1. 合并外部 PR #26 或其修正版。
2. 使用真实 Cursor API Key 执行 SDK/Sand/Dashboard smoke。
3. 将 Sand 作为 public v0.4 capability 发布，并同步修改 BFLABS/README/SECURITY 的公开边界。
4. npm、GHCR、GitHub Release 和任意生产部署。

## 11. Stop / Pause 条件

- Issue #25 的 `message_stop -> error` 顺序导致 Claude Code 把失败判为成功：暂停 v0.3.2，重新定义 terminal error contract。
- SDK 1.0.30 Sand patch 需要修改未知文件、遥测身份或不稳定动态代码：停止 Sand promotion，保留 sdk-only。
- SQLite 迁移无法在不删除原 lineage 的情况下回滚：停止 S3。
- 真实 Run 不能证明唯一 Send、terminal usage 和 receipt：不得进入 S5。
- Cursor 撤销 Sand grant、Terms 或产品权限：Sand 保持本地实验且不公开发布。
- hosted search 无法保留客户端语义：保持默认 off，并对不忠实请求稳定 4xx。

## 12. 开发者交接

下一位实现者从 S0 开始，不得先做 Sand UI：

1. 基于 main 建独立 hotfix 分支，复核 PR #26 的双写、脱敏和真实客户端失败语义。
2. v0.3.2 合并/发布门禁完成后，再为 v0.4 建长期分支。
3. 先提交 parity matrix 和 profile types，再做一条 `sdk -> sand fixture -> sdk restore` vertical slice。
4. 在 UI 前完成 profile/session binding 和 hash-guarded loader。
5. 在 Compact/search 前完成 SQLite ledger、claim generation、receipt 和断线收敛。
6. 每个阶段只在自己的 acceptance 全绿后进入下一阶段；不得用后续大重构掩盖 Issue #25 热修。

Goal Mode 当前跳过：本文件先作为 proposed canonical plan。Ender 确认 Sand public boundary 和分阶段验收后，再从本文件生成实现 `/goal`，不在未确认状态下自动启动长期执行。
