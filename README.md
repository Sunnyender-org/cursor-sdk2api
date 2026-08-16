# cursor-sdk2api

[简体中文](README.zh-CN.md)

Independent MIT gateway that exposes the official Cursor TypeScript SDK (`@cursor/sdk`) as Anthropic- and OpenAI-compatible HTTP APIs.

This is **not** an official Cursor or Anysphere product. Model execution does not reverse private Cursor transports, cookies, Desktop/CLI stores, or IDE sessions; the only execution engine is the published `@cursor/sdk` package. Account usage optionally calls the Cursor Dashboard control plane with the same User API Key, as documented below. Users must supply a legally obtained Cursor API key and comply with Cursor Terms of Service.

**v0.1 is Anthropic Messages-first.** `/v1/chat/completions` and `/v1/responses` are protocol adapters over that same run engine (contract-tested, not live-model certified).

## What v0.1 includes

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/console/` | none to load | Optional BF Labs Operator Console. API calls from the page still require a key, which stays in the current browser tab's React memory only. |
| `GET` | `/health` | none | Build, SDK version, readiness, **implemented** capability bits, network transport modes, and a separate `verification` object. Capability `true` means the gateway implements the path; it is not a live-model acceptance claim. `/health` never includes account data, keys, or proxy URLs. |
| `GET` | `/v1/models` | required | Live `Cursor.models.list()` catalog with exact public IDs. Empty list plus an explicit reason when unavailable. |
| `GET` | `/v1/account` | required | Identity from `Cursor.me()` plus current billing-cycle usage from Cursor Dashboard using the same User API Key. No Cookie, Team Admin key, or OAuth token is required. |
| `POST` | `/v1/messages/count_tokens` | required | Local conservative estimate for Claude Code context sizing. Marked by `x-cursor-sdk2api-token-count: estimated`; never used for billing. |
| `POST` | `/v1/messages` | required | Anthropic Messages text, SSE, client tools, same-turn parallel tools, multi-round continuation, and in-process replay. |
| `POST` | `/v1/chat/completions` | required | OpenAI Chat Completions adapter: text, `data:` SSE + `[DONE]`, function tools, continuation, `reasoning_content`, base64 `image_url`. Same session/run engine as Messages. |
| `POST` | `/v1/responses` | required | OpenAI Responses adapter: `input` string or items, Responses SSE + `response.completed`, reasoning, base64 `input_image`, `type=function` tools, `function_call_output` continuation by `call_id`. Same session/run engine as Messages. `previous_response_id` / hosted tools / `store=true` fail closed. The Console playground supports Responses directly. |

Default **API Compatibility Profile**:

- Request `tools[]` map to SDK `local.customTools`.
- Built-in allowlist is `["mcp"]` when client tools exist, otherwise `[]`.
- Ambient Cursor capabilities (`shell`, `read`, `edit`, `task`, `webSearch`, `webFetch`) are denied.
- `settingSources: []` and an empty workspace. The caller's repo is never implied.

## Quick start

Requires Node.js 22.19 or newer.

```bash
npm ci
npm run build
export AUTH_MODE=byok
node dist/index.js
```

Open `http://localhost:8080/console/` for the optional Operator Console. It reads
health without a key, then uses a key held only in page memory for model, account,
and playground requests. Reloading or closing the tab clears it.

```bash
curl -s localhost:8080/health
curl -s localhost:8080/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

Docker:

```bash
docker build -t cursor-sdk2api:local .
docker run --rm -p 8080:8080 -e AUTH_MODE=byok cursor-sdk2api:local
```

`docker-compose.yml` is a single-service wrapper. It defaults `STATE_DIR` to `/data` on a named volume and does not ship secrets.

Copy [`.env.example`](.env.example) for the full configuration surface. Never commit real keys.

## Outbound proxy

The official SDK does not automatically inherit the host proxy. When a supported proxy variable is set, the gateway routes **both** SDK data planes:

- local Agent runs switch to HTTP/1.1 through `proxy-agent`
- catalog, account, and Cursor Dashboard usage fetches use Undici's environment proxy dispatcher

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are accepted in uppercase or lowercase. Proxy URLs must use `http://` or `https://`. SOCKS and PAC fail closed, because the two SDK data planes cannot support them consistently. Direct (unproxied) Agent runs keep the official HTTP/2 transport.

`/health` reports only `network.proxy_configured`, `network.agent_transport`, and `network.fetch_transport`. Proxy URLs and credentials are never returned.

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=127.0.0.1,localhost
node dist/index.js
```

Inside Docker Desktop, a proxy running on the host is `host.docker.internal`, not `127.0.0.1` inside the container:

```bash
docker run --rm -p 8080:8080 \
  -e AUTH_MODE=byok \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e NO_PROXY=127.0.0.1,localhost \
  cursor-sdk2api:local
```

Do not put proxy userinfo in compose files or docs. Prefer a credential-free loopback URL, or keep credentials in a separately protected environment.

## Authentication

**BYOK (default).** Each request sends a Cursor API key as `Authorization: Bearer` or `x-api-key`. The process keeps the key in memory only and isolates sessions by an irreversible fingerprint.

**Managed (optional).** The process holds `CURSOR_API_KEY`. Clients send a different `GATEWAY_ACCESS_KEY`. Health does not expose the managed Cursor identity.

Forbidden: browser cookies, Desktop/CLI private stores, email/password login, refresh-token import, and putting keys in URLs, model names, or tool IDs.

## API examples

Non-stream Messages returns an assistant message plus `cursor_session_id` (`ses_...`). Use that value as `x-cursor-session-id` for a completed follow-up:

```bash
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -H "x-cursor-session-id: ses_replace_me" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"continue"}]}'
```

Chat Completions uses the same session header. Non-stream returns `cursor_session_id` and `x-cursor-session-id`. Trailing `role:tool` messages continue the pending SDK run:

```bash
curl -s localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","messages":[{"role":"user","content":"hello"}]}'
```

`n` must be `1` or omitted. Remote `image_url` URLs are rejected (`422`); send a base64 data URL. Stream frames are OpenAI `data:` chunks with a blank line after each frame (no Anthropic event names) and end with `data: [DONE]`. `stream_options.include_usage=true` adds a `choices=[]` usage chunk before `[DONE]`.

`/v1/responses` uses the same run engine. Completed follow-up still takes `x-cursor-session-id`. Pending tools resume only when the latest `input` items are `function_call_output` and `call_id` matches the live tool id. `previous_response_id` is rejected; this is not a stateless OpenAI store.

```bash
curl -s localhost:8080/v1/responses \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","input":"hello"}'
```

Stream events use Responses names (`response.created` … `response.completed`). On error the stream emits a Responses `error` event and does not emit `response.completed`. Hosted tools, `store=true`, background, conversation, and unknown include expansions fail closed. Grok's optional `reasoning.encrypted_content` include is accepted but omitted.

`function_call_output.output` accepts a string or an array of text content parts. Image/file tool-output parts fail closed with `422` until they can be mapped to the SDK without semantic loss.

Keep the public catalog model ID unchanged. For Grok 4.6 xhigh:

```json
{
  "model": "grok-4.6",
  "reasoning_effort": "xhigh",
  "max_tokens": 64,
  "messages": [{ "role": "user", "content": "hello" }]
}
```

Advanced callers may pass validated official SDK pairs in `cursor_model_params`. An explicit parameter change on the same session is `409 cursor_session_conflict`.

Tool continuation uses the same process-local Agent/Run. The latest user turn must contain only `tool_result` blocks:

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

For `/v1/messages`, `max_tokens` is accepted so Claude Code-shaped requests parse. The SDK harness has no precise max-token enforcement, and the gateway does not emulate one. Tool choice is mapped into Harness directives: Messages supports `auto` / `any` / named `tool`; Chat and Responses support `auto` / `required` / named `function`. Serial-tool flags are honored; `tool_choice=none` remains fail closed.

Errors:

```json
{
  "type": "error",
  "error": { "type": "invalid_request", "message": "..." },
  "request_id": "req_..."
}
```

Public error types: `invalid_request`, `authentication_error`, `forbidden`, `cursor_session_conflict`, `cursor_session_lost`, `rate_limited`, `cursor_empty_turn`, `cursor_upstream_error`, `cursor_timeout`.

## Native tool loop

The broker holds one SDK Agent/Run in process.

1. The first request may return N `tool_use` blocks from the same assistant turn.
2. The next request must send only `tool_result` blocks in the latest user turn.
3. Results are matched by `tool_use_id`. Order is not authoritative.
4. Wrong, missing, mixed-session, or duplicate-different IDs fail closed.
5. Duplicate-same results replay the stored turn and do not resolve again.
6. The HTTP sink is attached before deferred tool promises resolve.
7. `run.stream()` has a single consumer.

The default tool-batch debounce is 1500ms from the latest callback (`TOOL_BATCH_SETTLE_MS`). Live SDK probes observed Claude callbacks more than one second apart in one assistant turn; publishing on the first callback would hide later pending calls.

Pending callbacks are ordinary in-memory Promises. They cannot be serialized across processes.

## Usage and cache

- Intermediate tool turns return zero usage with `usage_deferred: true`.
- Cumulative SDK usage is confirmed once on the final turn via `run.wait()`.
- Cache fields appear only when the SDK reports them. Missing fields are omitted, never invented.

## State, resume, and multi-instance

MVP owns live runs in the process that created them.

- Blue/green and multi-instance deploys need connection draining and sticky ownership of a session.
- After a process restart, an unfinished tool continuation can resume when credential, model, model params, complete tool-id batch, and tool catalog match the owner-only lineage record.
- The gateway will not create a new Agent to pretend the original pending Run was recovered.

Completed follow-up with `x-cursor-session-id` can `Agent.resume` within `SESSION_TTL_MS` when credential, model, and explicit model parameters match. Pending tool recovery uses the same SDK store plus `local.force=true`; health reports `pending_tool_restart_resume=true` after a real kill/restart acceptance.

`STATE_DIR` holds:

- official JSONL SDK store at `$STATE_DIR/sdk-store/<credential-fingerprint>`
- owner-only lineage metadata at `$STATE_DIR/lineage` (`0700` / `0600`)

Host/dev default is `$TMPDIR/cursor-sdk2api/state`. The image and compose default is `/data`. Lineage stores resume metadata only (session id, SDK agent id, fingerprint, model, explicit params, state, pending tool ids/names, optional result digest, timestamps). It does not store API keys, prompts, tool inputs, or tool results. Assistant replay bodies are not persisted.

BYOK credentials share process capacity limits, but official SDK stores and empty workspaces are partitioned by credential fingerprint. That is process-local tenant isolation, not a claim of hardened hostile multi-tenant hosting.

Development defaults: 4 global active runs, 2 per credential, 30 minute session TTL, 10 minute replay TTL, 60 minute run deadline. Active-run limits apply to create, completed follow-up, and persisted resume. Drain still accepts awaiting `tool_result`.

## Status and evidence

v0.1 implements Messages text/SSE, client customTools/MCP, same-turn parallel tools, multi-round continuation, in-process replay, tenant/model isolation, completed Agent resume, and exact pending-tool restart recovery. Chat Completions and Responses are protocol adapters on the same coordinator. The Operator Console playground can exercise all three protocols.

A sanitized, non-secret acceptance summary is in [`docs/evidence/2026-08-15-live-smoke.md`](docs/evidence/2026-08-15-live-smoke.md). That receipt is a dated local sample, not a guarantee for every credential, region, or image:

- Host Claude Sonnet 4.6 and Fable 5 passed the required proxied matrix, including parallel tools and a Claude Code-shaped Fable request.
- Composer 2.5 passed the required host matrix, including same-turn parallel selection.
- Grok 4.6 xhigh Responses passed named-tool continuation, full-history continuation, same-turn two-tool parallel selection, cache-aware usage, local client-workspace file edits, and forced kill/restart pending-tool recovery.
- A Node 22 container proved both SDK data planes honor a configured HTTP(S) proxy, and fail when that proxy is unreachable. Fable container parallel/upstream success was **not** perfectly repeatable and is **not** marketed as a fully green container matrix.
- Runtime `/health.verification.live_smoke` stays `false`. A binary cannot infer that a different deployment inherited this receipt.

Thinking and image blocks are implemented and contract-tested. Live thinking/image granularity remains a separate model gate.

## Known limitations

- Official `@cursor/sdk` is required at runtime. Its own license and Cursor Terms apply. See [NOTICE.md](NOTICE.md).
- Production `npm audit --omit=dev` (2026-08-15) reports 3 transitive findings in the SDK tree: `undici` (high) and `@connectrpc/connect-node` / `@cursor/sdk` (moderate). `fixAvailable` is false. Do not run a destructive `npm audit fix`.
- Cursor Dashboard usage is queried by exchanging the supplied User API Key for a short-lived dashboard access token, then calling `GetCurrentPeriodUsage` and `GetPlanInfo`. If that control plane is unavailable, identity still returns and `/v1/account` degrades to `partial` with an explicit reason.
- `count_tokens` is an estimate because `@cursor/sdk` has no tokenizer preflight API. Final SDK usage remains authoritative for accounting.
- Cross-machine recovery still requires the same persisted SDK/lineage state; a stateless replica without that state fails closed.
- Credentialed live-model tests are opt-in and are not part of default CI.

Not implemented:

- Responses `previous_response_id` reconstruction, `store=true`, background mode, conversation objects, `include` expansions, or hosted built-in tools (`web_search`, `file_search`, `computer`, `shell`, `apply_patch`)
- Cursor Agent Profile (`/v1/agents`, native shell/edit, plan mode)
- distributed session ownership / Redis / Postgres

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run dev` builds the console once and starts the gateway. For isolated UI
iteration, run `npm run dev:web`; Vite serves the frontend while API requests can
be proxied only when explicitly configured by the developer.

Tests inject a deterministic fake SDK. They never read real Cursor credentials. GitHub Actions CI in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck, tests, build, and `docker build`.

Opt-in live matrix (not default CI, not run by `npm test`):

```bash
npm run build
CURSOR_LIVE_SMOKE=1 CURSOR_API_KEY=... npm run live:smoke
```

The runner binds loopback only, writes a redacted receipt under temp, and never logs keys, prompts, or tool payloads. See [`scripts/live-smoke/README.md`](scripts/live-smoke/README.md).

## Docs

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Run ownership, proxy transports, restart semantics |
| [docs/PROTOCOL_COMPATIBILITY.md](docs/PROTOCOL_COMPATIBILITY.md) | Endpoint and block support matrix |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local, Docker, drain, and upgrade |
| [docs/SECURITY.md](docs/SECURITY.md) | Credentials, logging, and threat notes |
| [docs/NEW_API_INTEGRATION.md](docs/NEW_API_INTEGRATION.md) | Using the gateway as a generic Anthropic upstream |
| [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md) | Public roadmap and later phases |
| [CHANGELOG.md](CHANGELOG.md) | v0.1 notes |

Until a published image digest exists, point Claude Code, OpenCode, or a generic Anthropic client at `http://<gateway-host>:8080` with the Cursor key (BYOK) or gateway access key (managed). Do not embed `@cursor/sdk` inside another gateway process.

### Client to endpoint

| Client | Use | Do not |
|---|---|---|
| Claude Code | `ANTHROPIC_BASE_URL` → `POST /v1/messages` | Chat Completions |
| Grok Build | custom model `api_backend = "responses"` → `POST /v1/responses` | Messages. If the client sends `previous_response_id`, this gateway returns 422; fall back to `chat_completions`. |
| OpenAI SDK / generic Chat | `base_url` `…/v1` → `POST /v1/chat/completions` | Messages unless the client is Anthropic-shaped |
| new-api | Anthropic upstream = Messages; OpenAI upstream = Chat | Mixing the two on one channel |

Grok Build and Claude Code edit **your local project** with their own tools. The gateway only runs the model. Cursor SDK `cwd` is an empty per-credential directory, so the model may emit that absolute path. Relative paths or your project paths write local files. A BeefAPI Cursor channel is the same split.

## Security

- Do not enable payload logging on a shared host.
- Do not set `DEBUG=*` or `DEBUG=proxy-agent` on a shared host; third-party transport logs can print proxy configuration.
- Treat `STATE_DIR` as owner-only sensitive state. The official SDK store may contain conversation and checkpoint data; this gateway does not audit those files.
- Public Internet deployment still requires TLS, access controls, encrypted state, monitoring, and an explicit operator threat model.
- Default logs may include request id, model id, stream flag, status, pending count, and final numeric usage. They must not include keys, cookies, prompts, thinking, tool schemas, tool arguments, or tool results.

## License and contributing

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Deterministic contract tests first; isolated Docker build second; live smoke only with an explicitly supplied test credential.
