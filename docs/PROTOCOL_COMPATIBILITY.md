# Protocol compatibility

Canonical internal contract is Anthropic Messages.

## Client routing

| Client | Endpoint | Notes |
|---|---|---|
| Claude Code | `POST /v1/messages` | `ANTHROPIC_BASE_URL` at the gateway origin. Chat Completions is the wrong shape. |
| Grok Build | `POST /v1/responses` | Custom model `api_backend = "responses"`. Grok's optional `reasoning.encrypted_content` include is accepted but omitted. This adapter still rejects `previous_response_id`, `store=true`, conversation objects, unknown include expansions, and hosted tools. |
| OpenAI SDK | `POST /v1/chat/completions` | `base_url` ends with `/v1`. |
| new-api | Messages or Chat | Match the upstream type. Do not mix both on one channel. |

Outer agents (Claude Code, Grok Build) execute their own local file tools in the user's project. The gateway API Profile still uses an empty Cursor SDK workspace. Failed Chat/Responses requests log the concrete `invalid_request` reason (field/rule), not only `error_type`.

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
| pending tool restart | yes | Exact credential/model/tool batch resumes with persisted SDK Agent lineage and `local.force=true` |
| duplicate-same after restart | no | Digest only; no persisted assistant replay |
| `/v1/models` | yes | Exact catalog ids or honest empty |
| `/v1/account` | partial | No fabricated spending |
| `/v1/chat/completions` | yes | Protocol adapter over the same Messages run engine. Contract-tested: non-stream text, OpenAI SSE `data:` chunks + `[DONE]`, `reasoning_content`, function tools, single/parallel continuation, duplicate-same replay, deferred/final cache-aware usage, `stream_options.include_usage`, `reasoning_effort` / `cursor_model_params`, base64 `image_url`, `n=1` only, unknown tool IDs fail closed, and OpenAI error shapes before and after stream start. Remote `image_url` URLs are `422`. Live Chat model matrix is not claimed. |
| `/v1/responses` | yes | Protocol adapter over the same Messages run engine. Contract-tested: non-stream text; Responses SSE lifecycle (`response.created` → deltas → `response.completed`); reasoning summary events; base64 `input_image`; `tools` `type=function`; same-turn parallel `function_call` items; full-history `function_call_output` continuation by the latest trailing `call_id` batch; duplicate-same replay; deferred/final cache-aware usage; `reasoning`/`reasoning_effort` / `cursor_model_params`; unknown/mixed/missing `call_id` fail closed; OpenAI REST errors before stream start and a Responses `error` event after stream start. Tool outputs accept a string or text-content array; image/file tool-output parts are `422` until native SDK mapping is implemented. `previous_response_id`, `store=true`, background, conversation, remote image URLs, and hosted tools fail closed. The known optional `reasoning.encrypted_content` include is accepted but omitted; unknown include expansions fail closed. Completed Responses `usage` always includes cache and reasoning detail objects. Grok 4.6 Responses named-tool, same-turn parallel, client-workspace file tool, and kill/restart recovery have live acceptance evidence. |
| `max_tokens` | accepted | Anthropic-required field is parsed/accepted so Claude Code requests work. The SDK Harness has no precise max-token enforcement; the gateway does not emulate one. |
| `temperature` / `top_p` / `stop_sequences` | advisory / unsupported | Accepted but **not mapped** to `@cursor/sdk`. v0.1 does not claim equivalent sampling behavior. |
| `tool_choice` | protocol-specific | Messages maps `auto` / `any` / named `tool`; Chat and Responses map `auto` / `required` / named `function` to Harness directives. `parallel_tool_calls=false` and Anthropic `disable_parallel_tool_use` request serial execution. `none` remains fail closed. |
| `reasoning_effort` | extension | Preserves the public model ID and maps the value to the official SDK `effort` model parameter. The live matrix uses `grok-4.6` plus `reasoning_effort: "xhigh"`; it does not invent an alias model name. |
| `cursor_model_params` | extension | Exact validated `{id,value}` pairs passed to the official SDK model selection. Explicit parameters are bound to the session and persisted for completed `Agent.resume`; an explicit change on the same session is `409 cursor_session_conflict`. |

Completed follow-up and persisted `Agent.resume` consume the same global / per-credential active-run limits as `create`. Awaiting `tool_result` continuation does not.

## Responses continuation identity

The gateway does not implement OpenAI `previous_response_id` reconstruction, `store=true`, or conversation objects. Identity stays the existing Messages engine:

| Client action | How this gateway resumes | What is not a session key |
|---|---|---|
| Pending tool turn | Latest `input` items must be only `function_call_output`. Each `call_id` is the live `tool_use_id`. | `previous_response_id`, response `id`, output item `id` |
| Same outputs again | Request/result digest replay. No second `resolve`. | A new Agent/Run |
| Completed follow-up | `x-cursor-session-id` on a new `input` that is not a tool-output suffix, same credential/model/params | `previous_response_id` |
| After process restart, still awaiting tools | Resume the persisted SDK Agent with the exact credential/model/tool-id batch and `local.force=true` | Missing catalog, mismatched identity, or a different result batch |

`function_call_output` mixed with a later user/message item is `422`. Missing required `call_id`s, unknown ids, and mixed-session ids fail closed the same way as Messages `tool_result`.

Live catalog/text/tool/restart matrix is an opt-in runner (`npm run live:smoke`), not default CI. Catalog-missing required model names fail closed; they are not green skips. This file does not record live model results.

## Error types

`invalid_request`, `authentication_error`, `forbidden`, `cursor_session_conflict`, `cursor_session_lost`, `rate_limited`, `cursor_empty_turn`, `cursor_upstream_error`, `cursor_timeout`.
