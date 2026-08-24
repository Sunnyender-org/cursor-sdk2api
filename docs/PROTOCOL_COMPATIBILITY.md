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
| `GET /console/` | optional | Static BF Labs Operator Console served by the gateway. It manages the persistent Cursor account pool but does not add billing, users, or a second production process. |
| `POST /v1/messages` non-stream text | yes | Native Anthropic `user`/`assistant` plus sub2api compatibility roles. `system`/`developer` preserve transcript order. Historical `tool`/`function` output is retained; a trailing compatibility tool result needs `tool_call_id`, `call_id`, or `id`. |
| SSE text / thinking | yes | Incremental forwarding via official `SendOptions.onDelta` (`text-delta` / `thinking-delta`). `run.stream()` is reserved for tool/status/terminal. Live model granularity is unverified. |
| images (base64) | yes | Mapped to SDK `images` |
| client tools | yes | `local.customTools` |
| parallel tools | yes | One assistant batch |
| tool continuation | yes | Latest user turn must be only `tool_result` |
| mixed text + tool_result | no | `422 invalid_request` |
| usage / cache | pass-through | Final-only cumulative; omit missing fields |
| ordinary next turn without session header | yes | Exact transcript lineage reuses the Agent and sends only the current user turn. Unknown, forked, compacted, or mismatched requests cold-rebuild. `ORDINARY_TURN_COORDINATOR=0` disables this. |
| completed `x-cursor-session-id` follow-up | yes | Store + `Agent.resume` within TTL |
| pending tool restart | yes | Exact credential/model/tool batch resumes with persisted SDK Agent lineage and `local.force=true` |
| expired/moved tool continuation | yes | A complete transcript whose latest assistant tool batch exactly matches the submitted results can cold-branch to a new SDK Agent; recorded identical tools replay internally |
| duplicate-same after restart | no | Digest only; no persisted assistant replay |
| `/v1/models` | yes | BYOK returns one account catalog. Managed mode returns the union of exact catalog ids across the pool. |
| `/v1/account` | yes | BYOK returns one account. Managed mode returns every pooled identity and real Cursor Dashboard period usage without exposing raw keys. |
| `/v1/messages/count_tokens` | estimated | Conservative local context-sizing estimate for Claude Code; response header marks it estimated and final SDK usage remains authoritative |
| `/v1/chat/completions` | yes | Protocol adapter over the same Messages run engine. Contract-tested: non-stream text, OpenAI SSE `data:` chunks + `[DONE]`, `reasoning_content`, function tools, single/parallel continuation, duplicate-same replay, deferred/final cache-aware usage, `stream_options.include_usage`, `reasoning_effort` / `cursor_model_params`, base64 `image_url`, `n=1` only, unknown tool IDs fail closed, and OpenAI error shapes before and after stream start. Remote `image_url` URLs are `422`. Live Chat model matrix is not claimed. |
| `/v1/responses` | yes | Protocol adapter over the same Messages run engine. Contract-tested: non-stream text; Responses SSE lifecycle (`response.created` → deltas → `response.completed`); reasoning summary events; base64 `input_image`; top-level and `additional_tools` client function declarations; custom/freeform tools with native `custom_tool_call` events; namespace tool qualification to SDK-safe names and identity restoration on output; top-level-authoritative Responses Lite dedupe; same-turn parallel calls; full-history `function_call_output` / `custom_tool_call_output` continuation by the latest trailing `call_id` batch; duplicate-same replay; deferred/final cache-aware usage; `reasoning`/`reasoning_effort` / `cursor_model_params`; unknown/mixed/missing `call_id` fail closed; OpenAI REST errors before stream start and a Responses `error` event after stream start. `text.format.type=json_schema` is forwarded as a prompt-level output contract because the official Cursor SDK has no structured-output enforcement surface; callers must validate strict schemas. Tool outputs accept a string or text-content array; image/file tool-output parts are `422` until native SDK mapping is implemented. `previous_response_id`, `store=true`, background, conversation, remote image URLs, and provider-hosted tools fail closed. The known optional `reasoning.encrypted_content` include is accepted but omitted; unknown include expansions fail closed. Completed Responses `usage` always includes cache and reasoning detail objects. Grok 4.6 Responses named-tool, same-turn parallel, client-workspace file tool, and kill/restart recovery have live acceptance evidence. |
| `max_tokens` | accepted | Anthropic-required field is parsed/accepted so Claude Code requests work. The SDK Harness has no precise max-token enforcement; the gateway does not emulate one. |
| `temperature` / `top_p` / `stop_sequences` | advisory / unsupported | Accepted but **not mapped** to `@cursor/sdk`. v0.1 does not claim equivalent sampling behavior. |
| `tool_choice` | protocol-specific | Messages maps `auto` / `any` / named `tool`; Chat and Responses map `auto` / `required` / named `function` to Harness directives. `parallel_tool_calls=false` and Anthropic `disable_parallel_tool_use` request serial execution. `none` remains fail closed. |
| `reasoning_effort` | extension | Preserves the public model ID and maps the value to the official SDK `effort` model parameter. The live matrix uses `grok-4.6` plus `reasoning_effort: "xhigh"`; it does not invent an alias model name. |
| `cursor_model_params` | extension | Exact validated `{id,value}` pairs passed to the official SDK model selection. Explicit parameters are bound to the session and persisted for completed `Agent.resume`; an explicit change on the same session is `409 cursor_session_conflict`. |

Completed follow-up and persisted `Agent.resume` consume the same global / per-credential active-run limits as `create`. Awaiting `tool_result` continuation does not.

Managed mode follows CPA's separation of proxy client keys from upstream
credentials. A valid `GATEWAY_ACCESS_KEY` selects compatible accounts with
round-robin for new sessions. Pending tool IDs and `x-cursor-session-id` bind
continuation to the original account, including persisted restart recovery.

## Responses continuation identity

The gateway does not implement OpenAI `previous_response_id` reconstruction, `store=true`, or conversation objects. Identity stays the existing Messages engine:

| Client action | How this gateway resumes | What is not a session key |
|---|---|---|
| Pending tool turn | Latest `input` items must be only `function_call_output`. Each `call_id` is the live `tool_use_id`. | `previous_response_id`, response `id`, output item `id` |
| Same outputs again | Request/result digest replay. No second `resolve`. | A new Agent/Run |
| Completed follow-up | `x-cursor-session-id` on a new `input` that is not a tool-output suffix, same credential/model/params | `previous_response_id` |
| After process restart, still awaiting tools | Resume the persisted SDK Agent with the exact credential/model/tool-id batch and `local.force=true` | Missing catalog or an incomplete result batch |
| SDK session/account no longer attachable | Cold-branch from the complete transcript and replay completed tool signatures internally | Missing assistant calls, missing catalog, or results that do not exactly match the latest tool batch |

`function_call_output` mixed with a later user/message item is `422`. Missing required `call_id`s, unknown ids, and mixed-session ids fail closed the same way as Messages `tool_result`.

Live catalog/text/tool/restart matrix is an opt-in runner (`npm run live:smoke`), not default CI. Catalog-missing required model names fail closed; they are not green skips. This file does not record live model results.

Runtime discovery exposes `transcript_tool_recovery`, `stale_auth_recovery`, and `managed_account_failover` in `/health`. The last capability applies only to managed mode, only before an HTTP response has begun, and only before the turn has produced output. Managed clients authenticate with the gateway key, so a Cursor credential failure that survives every compatible account, or that is unresolved when the failover admission window closes, is reported as `cursor_upstream_error`; a definitively invalid, revoked, or expired credential keeps `authentication_error`.

## Error types

`invalid_request`, `authentication_error`, `forbidden`, `cursor_session_conflict`, `cursor_session_lost`, `rate_limited`, `cursor_empty_turn`, `cursor_upstream_error`, `cursor_timeout`.
