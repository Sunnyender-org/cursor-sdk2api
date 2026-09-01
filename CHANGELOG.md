# Changelog

## 0.4.0

- Fix GitHub Issue #25: Anthropic SSE in-stream errors now close open blocks, emit `message_delta` + `message_stop`, then one public `error`, without a second handler write.
- Add explicit `sdk` / `sand` runtime profiles. Default remains `sdk`. Sand requires Grok Bot grant, a hash-guarded `@cursor/sdk` 1.0.30 loader, and isolated store/workspace. Changing profile on an existing session is `409`.
- Add optional SQLite WAL runtime ledger (`RUNTIME_LEDGER_V2`, default off): one logical claim, disconnect observer, and a single provider receipt with numeric token usage only.
- Console and `/v1/account` keep Cursor period quota and Grok Bot weekly quota as separate progress. Runtime SDK|Sand applies to new sessions only.
- Add `POST /v1/responses/compact` and `compaction_trigger` with gateway-local HMAC anchors prefixed `csgw1.`. Tamper/cross-binding fails closed. Compact does not call Cursor Send.
- Hosted `web_search` is opt-in via `HOSTED_SEARCH_MODE=auto` for a bare live tool. Filters, required/named choice, Chat `web_search_options`, and `x_search` stay 4xx.
- `/health` reports default/sdk/sand readiness, SDK version, and patch contract version without filesystem paths.
- new-api channel templates document profile, compact, and receipt billing. Gateway version now follows `package.json`.

## Unreleased

- Ordinary turns now follow BeefAPI's Cursor Agent contract: a typed turn IR, exact-lineage Agent reuse, and `send(current turn)` instead of flattening the whole transcript on every request. Tool continuation, `x-cursor-session-id` follow-up, and cold rebuild remain. Disable with `ORDINARY_TURN_COORDINATOR=0`.

- `/v1/messages` accepts sub2api compatibility roles without flattening the transcript: `system`/`developer` remain in order, historical `tool`/`function` output stays visible to the Harness, and a trailing tool result requires a real call id before entering continuation lookup.
- `/v1/responses` accepts `text.format.type=json_schema` as an explicit Harness output contract instead of silently dropping it. Client-executed function, custom/freeform, and namespace declarations inside `input[].type=additional_tools` join the real MCP tool catalog; a same-name top-level declaration is authoritative, matching Codex Responses Lite. Custom calls use native `custom_tool_call` events and namespace identities are restored on output. Conflicts within one additional catalog and provider-hosted tool shapes still fail closed.
- `/v1/account` now reads current-period spending, remaining included usage, model-family percentages, plan metadata, and limits through Cursor Dashboard using the same User API Key, without Cookie or Team Admin credentials. Missing usage remains a partial response rather than a fabricated zero quota.
- Added authenticated `/v1/messages/count_tokens` as an explicitly marked local estimate for Claude Code context management; it never starts an SDK run or participates in billing.

- Operator Console now uses BF Labs UI tokens, Button/Tabs/Notice/Reveal motion (entry, hover lift, orange progress pulse) with reduced-motion support. Console density is preserved; marketing-card invert is not used.
- Console motion follow-through: overview CountUp, copy toast plus button flash, and a sliding rail indicator that follows the current page.
- Failed requests now log the concrete `invalid_request` reason (redacted) next to `error_type`.
- Operator Console and README pin client-to-endpoint recipes: Claude Code → Messages, Grok Build → Responses, OpenAI SDK → Chat. Console documents that outer-agent file tools stay local.
- Responses `include` is accepted and not expanded so Grok Build's Responses backend can connect. `previous_response_id`, `store=true`, conversation, and hosted tools still fail closed.
- Responses usage always includes `input_tokens_details` and `output_tokens_details` so strict clients (Grok Build) can deserialize the object.
- Responses now accepts Grok's named-function/required tool choice, preserves full-history tool continuation, reports SDK reasoning usage, and keeps client-side tool paths anchored to the caller workspace instead of the internal SDK cwd.
- Pending tool turns can recover after a gateway crash through persisted Agent lineage + `Agent.resume` + `local.force=true`; exact identity/catalog/result-batch checks and duplicate-same singleflight remain fail closed on conflict.
- `/v1/chat/completions` protocol adapter over the existing Anthropic `ParsedMessages` run engine. Contract-tested text, OpenAI SSE, function tools, continuation, replay, deferred and cache-aware usage, images, and OpenAI error shapes.
- `/v1/responses` protocol adapter over the same run engine. Contract-tested non-stream text, Responses SSE lifecycle, reasoning, base64 `input_image`, function tools, same-turn parallel calls, `function_call_output` continuation by `call_id`, duplicate-same replay, deferred/final cache-aware usage, `reasoning_effort` / `cursor_model_params`, and Responses-shaped errors. `previous_response_id`, `store=true`, background, conversation, include expansions, and hosted built-in tools fail closed. Operator Console includes a Responses playground tab.
- Optional BF Labs Operator Console at `/console/`, bundled as static Vite assets and served by the existing Node process. It includes health, model/account reads, Messages/Chat/Responses playground, connection snippets, English/Chinese, and light/dark modes. Keys remain in page memory only.

## 0.1.0

- Standard HTTP(S) `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` support for both official SDK data planes. Proxied Agent runs switch to HTTP/1.1 through `proxy-agent`; catalog/account fetches use Undici's environment dispatcher; direct runs retain HTTP/2. SOCKS/PAC fails closed. Health exposes only the boolean plus Agent/fetch transport modes.
- Claude tool-batch debounce raised from 100ms to 1500ms after live callback timing showed same-turn callbacks up to 1189ms apart. Sonnet 4.6 and Fable 5 then passed the full 18-case proxied matrix, including parallel tools, cache reads/writes, completed resume, and Fable Claude Code shape.
- Review fixes: empty-turn only after `run.wait()`, strict SSE block order, per-boundary delta replay, native `isError` tool results, bounded expired tool IDs with periodic sweep, follow-up toolIndex reset.
- Streaming uses official `SendOptions.onDelta` (`text-delta` / `thinking-delta`); `run.stream()` stays single-consumer for tool/status/terminal.
- Completed Agent lineage on credential-partitioned official `JsonlLocalAgentStore` directories (`STATE_DIR/sdk-store/<fingerprint>`) plus owner-only lineage metadata. Health reports `agent_resume=true`, `pending_tool_restart_resume=false`, `store_backend=jsonl`. Duplicate-same after restart is `session_lost` (digest only).
- Active-run limits apply to create, completed follow-up, and persisted resume. Drain still accepts awaiting `tool_result`.

- Repository bootstrap and MIT license.
- `/health`, `/v1/models`, `/v1/account`, `/v1/messages`.
- Anthropic non-stream and SSE text.
- In-process session broker for single, parallel, and multi-round client tools.
- Honest models/account degradation and final-only usage confirmation.
