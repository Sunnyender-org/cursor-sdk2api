# Protocol compatibility

Canonical internal contract is Anthropic Messages.

| Surface | v0.1 | Notes |
|---|---|---|
| `GET /console/` | optional | Static BF Labs Operator Console served by the gateway. It does not add billing, users, channel pools, credential persistence, or a second production process. |
| `POST /v1/messages` non-stream text | yes | |
| SSE text / thinking | yes | Incremental forwarding via official `SendOptions.onDelta` (`text-delta` / `thinking-delta`). `run.stream()` is reserved for tool/status/terminal. Live model granularity is unverified. |
| images (base64) | yes | Mapped to SDK `images` |
| client tools | yes | `local.customTools` |
| parallel tools | yes | One assistant batch |
| tool continuation | yes | Latest user turn must be only `tool_result` |
| mixed text + tool_result | no | `422 invalid_request` |
| usage / cache | pass-through | Final-only cumulative; omit missing fields |
| completed `x-cursor-session-id` follow-up | yes | Store + `Agent.resume` within TTL |
| pending tool restart | no | `409 cursor_session_lost` |
| duplicate-same after restart | no | Digest only; no persisted assistant replay |
| `/v1/models` | yes | Exact catalog ids or honest empty |
| `/v1/account` | partial | No fabricated spending |
| `/v1/chat/completions` | yes | Protocol adapter over the same Messages run engine. Contract-tested: non-stream text, OpenAI SSE `data:` chunks + `[DONE]`, `reasoning_content`, function tools, single/parallel continuation, duplicate-same replay, deferred/final cache-aware usage, `stream_options.include_usage`, `reasoning_effort` / `cursor_model_params`, base64 `image_url`, `n=1` only, unknown tool IDs fail closed, and OpenAI error shapes before and after stream start. Remote `image_url` URLs are `422`. Live Chat model matrix is not claimed. |
| `/v1/responses` | no | Not implemented |
| `max_tokens` | accepted | Anthropic-required field is parsed/accepted so Claude Code requests work. The SDK Harness has no precise max-token enforcement; the gateway does not emulate one. |
| `temperature` / `top_p` / `stop_sequences` | advisory / unsupported | Accepted but **not mapped** to `@cursor/sdk`. v0.1 does not claim equivalent sampling behavior. |
| `tool_choice` | protocol-specific | Messages accepts but does not map it. Chat allows only `auto` or omission; `required`, `none`, and named-function forms fail closed with `422`. |
| `reasoning_effort` | extension | Preserves the public model ID and maps the value to the official SDK `effort` model parameter. The live matrix uses `grok-4.6` plus `reasoning_effort: "xhigh"`; it does not invent an alias model name. |
| `cursor_model_params` | extension | Exact validated `{id,value}` pairs passed to the official SDK model selection. Explicit parameters are bound to the session and persisted for completed `Agent.resume`; an explicit change on the same session is `409 cursor_session_conflict`. |

Completed follow-up and persisted `Agent.resume` consume the same global / per-credential active-run limits as `create`. Awaiting `tool_result` continuation does not.

Live catalog/text/tool/restart matrix is an opt-in runner (`npm run live:smoke`), not default CI. Catalog-missing required model names fail closed; they are not green skips. This file does not record live model results.

## Error types

`invalid_request`, `authentication_error`, `forbidden`, `cursor_session_conflict`, `cursor_session_lost`, `rate_limited`, `cursor_empty_turn`, `cursor_upstream_error`, `cursor_timeout`.
