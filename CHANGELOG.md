# Changelog

## Unreleased

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
