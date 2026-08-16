# Live Smoke Receipt — 2026-08-15

This is a redacted public summary produced from opt-in, loopback-only runs of `tests/live-smoke` using official `@cursor/sdk` 1.0.28. It contains no API key, account identity, prompt, assistant text, tool arguments, tool results, home path, or browser data. The full machine receipts remain private artifacts outside git.

Environment: gateway `0.1.0`, Node `v26.0.0`, macOS arm64, child-process mode. The authenticated catalog returned 36 models and resolved the requested IDs exactly.

## Current-code working-model run

Window: `2026-08-15T06:40:53.341Z` to `2026-08-15T06:43:13.299Z`.

| Model / case | Result | HTTP | Structural evidence |
|---|---:|---:|---|
| Grok 4.6 xhigh text | pass | 200 | opaque marker observed |
| Grok 4.6 xhigh SSE | pass | 200 | start/delta/stop; no SSE errors |
| Grok 4.6 xhigh single tool | pass | 200 | 1 `tool_use` |
| Grok 4.6 xhigh parallel tools | fail | 200 | model selected 1 of 2 requested tools |
| Grok 4.6 xhigh multi-round | pass | 200 | tool batch counts `1,1` |
| Grok 4.6 xhigh duplicate replay | pass | 200 | one continuation result |
| Grok 4.6 xhigh pending restart | pass | 409 | `cursor_session_lost` |
| Grok 4.6 xhigh completed resume | pass | 200 | completed Agent resumed |
| Composer 2.5 text + SSE | pass | 200 | opaque marker and incremental SSE observed |
| Composer 2.5 single tool | pass | 200 | 1 `tool_use` |
| Composer 2.5 parallel tools | pass | 200 | 2 `tool_use` blocks in one assistant batch |
| Composer 2.5 multi-round | pass | 200 | tool batch counts `1,1` |
| Composer 2.5 duplicate replay | pass | 200 | one continuation result |
| Composer 2.5 pending restart | pass | 409 | `cursor_session_lost` |
| Composer 2.5 completed resume | pass | 200 | completed Agent resumed |

Grok parallel selection is model-nondeterministic in this local sample: a dedicated earlier run on the same day returned two calls and passed, while the current-code combined run returned one call. The gateway's batch bridge is independently covered by deterministic parallel and 50 ms staggered-callback tests, and Composer returned two live calls. Do not represent Grok parallel selection as guaranteed until a repeatability threshold is defined and met.

## Current-code Claude proxy run

Final current-code host window: `2026-08-15T07:55:08.989Z` to `2026-08-15T08:00:36.030Z`.

- Catalog authentication passed and resolved `claude-sonnet-4-6` and `claude-fable-5` exactly.
- `/health` confirmed `proxy_configured=true`, `agent_transport=http1-proxy`, and `fetch_transport=undici-proxy`; no proxy URL or credential was retained.
- All 18 required catalog/Sonnet/Fable cases passed with zero required failures and zero region-blocked cases.
- Both models passed text, incremental SSE, single tool, two-tool same-turn parallel continuation, two-round tools, duplicate-same replay, explicit pending-restart `cursor_session_lost`, and completed Agent resume.
- The Claude Code-shaped Fable request passed.
- Cache creation and cache read tokens were both observed from official SDK usage. The gateway did not synthesize cache fields.
- Before the final run, direct SDK timing probes observed the second parallel custom-tool callback 318–697ms after the first for Sonnet and 713–1189ms for Fable. Raising the debounce from 100ms to 1500ms produced 4/4 two-tool continuation passes per model, followed by the full green matrix.

## Proxy data-plane and container checks

- Deterministic tests install the actual Node Agent and Undici dispatchers, send a fetch through an `HTTP_PROXY`-only local proxy, and prove `NO_PROXY` bypasses that proxy. Separate HTTP and HTTPS proxy URLs remain distinct; a single configured URL safely covers both SDK paths.
- Immutable image `sha256:a5b7ce38d7c8f7a4bf47db5f91c9722e07199d9d221c6da459b0e1620c1a84e0` runs Node `v22.19.0`. With the configured proxy, its authenticated catalog returned 36 models, `/v1/account` returned an identity, Sonnet passed every attach-mode executable case, and Fable passed text/SSE/single/multi-round/replay plus at least one live parallel continuation and Claude Code-shaped request.
- A fresh container using a deliberately unreachable proxy could not access either SDK path: catalog became `status=unavailable` with zero models, account returned no identity, and Sonnet Agent creation returned 502. The same calls succeeded through the configured proxy. This is the direct/no-direct escape discriminator; health flags alone were not treated as proof.
- Fable was not perfectly deterministic across container attach runs: one parallel continuation received an SDK upstream 502, and a later run selected fewer than two calls while three immediate targeted repeats each returned two calls. The host child-mode acceptance remained 18/18. These observations are recorded as upstream/model repeatability, not converted into a green container matrix.

An earlier same-day run that omitted proxy variables from the spawned gateway returned `403 region_unsupported`. That result is superseded: it proved missing proxy propagation, not a valid regional capability boundary. The gateway now explicitly routes both local Agent and SDK fetch traffic whenever an HTTP(S) proxy variable is configured.

## Interpretation

- Proven live on current code: model catalog; the full host Sonnet 4.6 and Fable 5 required matrices including parallel tools and Fable Claude Code shape; Node 22 container proxy routing for both SDK data planes plus real Claude Agent/tool calls; Grok 4.6 xhigh text/SSE/single/multi-round/replay/restart/completed-resume; and the full Composer 2.5 required matrix.
- Observed but not repeatably proven: Grok 4.6 same-turn parallel selection.
- Runtime `/health` intentionally keeps `verification.live_smoke=false`; a binary cannot infer that a different deployment, credential, region, or build inherited this receipt.
