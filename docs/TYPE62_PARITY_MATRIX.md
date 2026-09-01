# Type62 parity matrix

Inventory of BeefAPI type62 *observable* execution capabilities for this independent MIT gateway (`cursor-sdk2api` v0.3.1 / `1e18349`, `@cursor/sdk` 1.0.30).

This is a maintainer classification, not a public product claim. The default runtime profile remains `sdk`. Sand and hosted search are not default-on. Wallet, BeefAPI users/tokens/channel scheduling, and type64 Agent v1 are out of scope.

Classification:

- `port` — bring the observable behavior over, preserving independent-gateway boundaries
- `adapt` — same observable contract, different storage/identity (no BeefAPI platform types)
- `skip` — will not ship on this path

| Capability | v0.3.1 status | Decision | v0.4 owner |
|---|---|---|---|
| Messages/Chat/Responses single coordinator | Present (`RunCoordinator` + protocol adapters) | port | Existing core; Issue #25 worker must keep one coordinator |
| Issue #25 SSE | Defect: mid-stream Anthropic error can omit the terminal SSE sequence | port | Issue #25 worker (in-progress) |
| sdk/sand profile | Absent; S1 lands types, env, and session-policy digest only | port | S1 skeleton here; RunCoordinator/HTTP wiring is later |
| Sand access/usage RPC | Absent | port | Dashboard Sand RPC worker (`src/account/cursor-dashboard.ts`) |
| Sand store/workspace isolation | Absent | port | Sand loader + S2 isolation |
| Sand 1.0.30 hash guard | Absent; must not reuse 1.0.28 hashes | adapt | Sand loader worker (`src/sdk/sand-loader.ts`, `sand-patch-contract.ts`) |
| profile bound to Agent/Run | Digest now includes `runtimeProfile` (default `sdk`); coordinator not yet enforcing | port | S1 digest here; Agent/Run bind follows ledger + coordinator workers |
| Agent/Run/Interaction SQLite ledger | JSON lineage / ordinary-turn journal only | adapt | SQLite ledger worker (`src/core/runtime-ledger*.ts`) |
| claim generation | Partial in-process singleflight | port | SQLite ledger worker |
| provider receipt uniqueness | No platform receipt | adapt | SQLite ledger worker |
| terminal usage snapshot | In-memory response fields | port | SQLite ledger worker |
| disconnect Observe/Finalize | Partial session retain; no background finalize/receipt | port | SQLite ledger worker |
| Responses compaction_trigger | Absent | port | S4 protocol parity |
| /responses/compact | Absent | port | S4 protocol parity |
| opaque continuation anchor | Absent | adapt | S4 protocol parity (gateway-local HMAC, not BeefAPI `v3.*`) |
| base64 images | Present on Messages/Chat/Responses | port | Existing protocol adapters |
| hosted webSearch/webFetch | Disabled; ambient hosted tools fail closed | port | S4; `HOSTED_SEARCH_MODE` default `off` (opt-in `auto` only) |
| xAI x_search | Not a Cursor SDK path capability | skip | None; keep fail-closed |
| document/audio/video | Absent | skip | None; stable 4xx |
| true parallel provider execution | Client tool batches exist; no extra parallel-provider claim | port | Existing core; preserve current semantics |
| account pool model-aware routing | Present in managed mode | port | Existing account pool; later profile-aware, not a second pool |
| account/Grok Bot console | Operator console exists; no Grok Bot quota/profile controls | port | S2 console (Dashboard usage + profile) |
| new-api integration | Basic external-gateway channel | port | S4 (profile/receipt/compact; no BeefAPI tokens) |
| BeefAPI wallet/user/channel | Absent by design | skip | None; boundary tests/docs only |
| type64 private Agent v1 | Absent by design | skip | None; do not mix type64 Sand failure behavior into type62 |

## S1 notes

- Default profile is `sdk`. Invalid `DEFAULT_RUNTIME_PROFILE` / `HOSTED_SEARCH_MODE` strings fail closed; they are not coerced to `sdk` / `off`.
- There is no automatic SDK↔Sand fallback.
- `sessionPolicyFingerprint` includes `runtimeProfile`. Omitting the field is the same digest as explicit `sdk`. A later same-session profile change must use existing `409 cursor_session_conflict`.
- `/health` does not advertise Sand or hosted search this round (`src/server/app.ts` is owned by the Issue #25 worker).
- `RUNTIME_LEDGER_V2` is plumbed on `GatewayConfig` (default `false`) for the ledger worker; this slice does not open SQLite.
- Request header `x-cursor-runtime-profile` is not wired into HTTP this round. `resolveRequestProfile` exists as a pure helper: BYOK ignores the header unless `ALLOW_REQUEST_RUNTIME_PROFILE=true`.
