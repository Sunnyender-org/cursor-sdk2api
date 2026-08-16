# cursor-sdk2api

[简体中文](README.zh-CN.md)

Independent MIT gateway that turns the official published Cursor TypeScript SDK (`@cursor/sdk`) into three HTTP dialects: Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses.

**Claude Code-first. Grok Build-ready. Codex/Responses-compatible.** The tested Claude path covers streaming, multi-round and same-turn parallel client tools, cache-aware usage, completed-session resume, and Claude Code context sizing. When Cursor's live catalog exposes `context=1m`, the gateway forwards that official model parameter unchanged to `@cursor/sdk`.

This is **not** a Cursor or Anysphere product. It does not reverse private Cursor transports, cookies, Desktop/CLI stores, or browser sessions. The only model execution engine is the published `@cursor/sdk` package. You supply a legally obtained Cursor User API Key (or Service Account key) and stay inside Cursor's Terms of Service.

[![CI](https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml/badge.svg)](https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19-339933)](package.json)
[![@cursor/sdk](https://img.shields.io/badge/%40cursor%2Fsdk-1.0.28-111111)](https://www.npmjs.com/package/@cursor/sdk)

**v0.1 is a single-process trusted sidecar.** `/v0/management/accounts` has no access key and returns raw Cursor keys to the same-origin Operator Console. Keep it on a trusted local network, or put TLS and your own auth proxy in front.

## Why this exists

Most "CLI to API" gateways wrap Claude Code, Codex, or Grok login state. This one does the opposite.

You already have a Cursor API key. Cursor already publishes `@cursor/sdk`. Coding agents already speak Messages or Responses. `cursor-sdk2api` is the missing HTTP edge: one process, one run coordinator, three protocol adapters, no second Cursor runtime hidden in cookies.

What works today:

- Claude Code over **Messages**, including SSE, client tool loops, same-turn parallel tools, cache usage, completed-session resume, and `count_tokens` as a marked local estimate
- Grok Build over **Responses**, including Grok's named-function tool choice and the optional `reasoning.encrypted_content` include (accepted, then omitted)
- OpenAI SDK / generic Chat clients over **Chat Completions**
- Codex and other Responses clients over **Responses**, where they do not require `previous_response_id`, `store=true`, or hosted tools
- Caller-owned tools (Claude Code / Grok / Codex local tools, including that client's own web or network search if it exposes one)
- Same-turn parallel tool callbacks, multi-round continuation, streaming, base64 images, and thinking/reasoning blocks (implemented and contract-tested; live thinking granularity is still unverified)
- Live `GET /v1/models` catalog with exact public IDs
- `GET /v1/account` identity plus Cursor Dashboard quota from the same User API Key
- Optional Operator Console at `/console/`
- Outbound HTTP(S) proxy for both SDK data planes

What this is not:

- Not a drop-in Anthropic, OpenAI, or xAI replacement
- Not a reverse-engineered Cursor IDE proxy
- Not an xAI-native Grok endpoint (`x_search` is not here)
- Not a multi-instance high-availability cluster

## Client compatibility

Point each client at the protocol it already speaks. Mixing them on one channel is the usual way to get a 422.

| Client | Use | Do not |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL` = gateway origin → `POST /v1/messages` | Chat Completions. Claude Code needs Messages, including `max_tokens` and `count_tokens`. |
| **Grok Build** | custom model `api_backend = "responses"` → `POST /v1/responses` | Messages. If the client later sends `previous_response_id`, this gateway returns 422; switch that model to `chat_completions`. |
| **Codex / OpenAI Responses** | `base_url` `…/v1`, `wire_api = "responses"` → `POST /v1/responses` | Assume OpenAI store semantics. `previous_response_id`, `store=true`, conversation objects, and hosted tools fail closed. |
| **OpenAI SDK / generic Chat** | `base_url` `…/v1` → `POST /v1/chat/completions` | Messages unless the client is Anthropic-shaped. |
| **new-api / one-api** | Anthropic upstream = origin (Messages); OpenAI upstream = `origin/v1` (Chat) | Mix both on one channel. There is no official new-api channel PR yet; configure a generic sidecar. |

Claude Code, Grok Build, and Codex edit **your local project** with **their** tools. The gateway only runs the model. Cursor SDK `cwd` is an empty per-credential directory, so the model may emit that absolute path. Prefer relative paths, or your real project path.

**Claude 1M context.** Cursor's live catalog currently exposes `context=1m` for models including Claude Sonnet 4.6 and Fable 5. This gateway preserves the exact public model ID and forwards the official SDK `{id,value}` parameter unchanged. It does not invent a context window or emulate Anthropic long-context billing. The 1M catalog path is verified; a synthetic one-million-token payload benchmark is not part of the published receipt.

**Web / network search.** Client-owned search tools stay on the client. If Claude Code, Grok Build, or Codex expose a local web or network search tool, the gateway maps it like any other caller tool and returns the client's result. Cursor ambient `webSearch` / `webFetch` are denied. Hosted OpenAI `web_search` is rejected. **Cursor-routed Grok does not expose xAI-native `x_search`.** That tool exists on xAI's own API, not on this Cursor SDK path.

Compatibility evidence:

- Claude Code: the full host Sonnet 4.6 and Fable 5 Messages matrix passed, including text, SSE, single/parallel/multi-round tools, replay, cache reads/writes, and completed resume. A Claude Code-shaped Fable 5 request passed the published matrix; a later real Claude Code operator probe completed against Sonnet 4.6 and used local workspace tools.
- Grok Build: Responses adapter is contract-tested for Grok's named tool choice, usage detail objects, and the known encrypted-reasoning include. A local operator probe completed a real Grok Build Responses session and wrote a workspace marker. Same limit: connect + local-tool evidence.
- Codex: Responses contract suite exists. No Codex live-client receipt is in this repository.

## Capability matrix

`GET /health` capabilities mean the gateway implements the path. They are not a live-model acceptance stamp. `verification.live_smoke` stays `false` in the binary.

| Capability | Status | Boundary |
|---|---|---|
| Anthropic Messages text + SSE | Implemented; live-sampled on Sonnet 4.6, Fable 5, Composer 2.5, Grok 4.6 xhigh | Dated host receipt: [docs/evidence/2026-08-15-live-smoke.md](docs/evidence/2026-08-15-live-smoke.md) |
| OpenAI Chat Completions | Protocol adapter; contract-tested | Health marks `contract_tested_unverified_live`. No live Chat matrix. |
| OpenAI Responses | Protocol adapter; contract-tested | Same health mark. Grok Build connect is locally probed. Codex is not live-certified. |
| Claude `count_tokens` | Local conservative estimate | Header `x-cursor-sdk2api-token-count: estimated`. Never starts an SDK run. Never used for billing. |
| Claude 1M context | Catalog / param passthrough | Exact Cursor IDs and official SDK params only. No 1M-token acceptance in this repo. |
| Thinking / reasoning | Implemented; contract-tested | Live thinking granularity is still a separate model gate. Grok encrypted reasoning include is accepted and omitted. |
| Images | Implemented; contract-tested | Base64 only. Remote `image_url` is `422`. |
| Caller tools via custom MCP | Implemented | Request `tools[]` → SDK `local.customTools`. Allowlist is `["mcp"]` when caller tools exist, else `[]`. |
| Same-turn parallel tools | Implemented; live-sampled on Claude / Composer | Grok same-turn two-tool selection was **not repeatable** in the published receipt. Do not treat it as guaranteed. |
| Multi-round tool continuation | Implemented; live-sampled | Latest user turn must be only `tool_result` / `function_call_output`. Mixed text + results is `422`. |
| Client web / network search | Only if the **client** owns the tool | Mapped as a normal caller tool. Not granted by the gateway. |
| Cursor ambient `shell` / `read` / `edit` / `task` / `webSearch` / `webFetch` | Denied | Empty workspace. `settingSources: []`. |
| xAI `x_search` | **Not available** | Cursor-routed Grok is still Cursor. Use an xAI-native API if you need `x_search`. |
| Hosted OpenAI tools (`web_search`, `file_search`, `computer`, `shell`, `apply_patch`) | Fail closed | `422` |
| Responses `previous_response_id` / `store=true` / conversation | Fail closed | Continuation is `function_call_output.call_id` or `x-cursor-session-id`. |
| In-process live tool continuation | Process-local Promises | One owner process. Pending callbacks cannot be serialized as-is. |
| Pending-tool restart recovery | Implemented; fake-SDK integration-tested | Exact credential / model / params / tool-id batch / catalog, then `Agent.resume` + `local.force=true`. The published 2026-08-15 live smoke still recorded `409 cursor_session_lost` (that runner expected the old fail-closed path). |
| Completed follow-up resume | Implemented; live-sampled | `x-cursor-session-id` within `SESSION_TTL_MS`. |
| Cursor Dashboard quota | Implemented | Same User API Key. No Cookie, Team Admin key, or OAuth import. Missing usage is `partial`, never a fake zero. |
| Outbound HTTP(S) proxy | Implemented; container-probed | Both SDK data planes. SOCKS / PAC fail closed. |

## Quick start

Requires Node.js 22.19 or newer.

```bash
git clone https://github.com/Sunnyender-org/cursor-sdk2api.git
cd cursor-sdk2api
npm ci
npm run build
export AUTH_MODE=byok
node dist/index.js
```

Open [http://localhost:8080/console/](http://localhost:8080/console/). Add a Cursor API key there, or send it on every request.

```bash
curl -s localhost:8080/health
curl -s localhost:8080/v1/models \
  -H "Authorization: Bearer $CURSOR_API_KEY"
curl -s localhost:8080/v1/messages \
  -H "Authorization: Bearer $CURSOR_API_KEY" \
  -H "content-type: application/json" \
  -d '{"model":"composer-2.5","max_tokens":64,"messages":[{"role":"user","content":"hello"}]}'
```

### Docker

```bash
docker build -t cursor-sdk2api:local .
docker run --rm -p 8080:8080 -e AUTH_MODE=byok cursor-sdk2api:local
```

`docker-compose.yml` is a single-service wrapper. It defaults `STATE_DIR` to `/data` on a named volume and does not ship secrets.

Copy [`.env.example`](.env.example) for the full configuration surface. Never commit real keys.

### Outbound proxy

The official SDK does not inherit the host proxy by itself. When a supported proxy variable is set, the gateway routes **both** SDK data planes:

- local Agent runs switch to HTTP/1.1 through `proxy-agent`
- catalog, account, and Cursor Dashboard fetches use Undici's environment proxy dispatcher

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are accepted in uppercase or lowercase. Proxy URLs must be `http://` or `https://`. SOCKS and PAC fail closed. Direct Agent runs keep the official HTTP/2 transport.

`/health` reports only `network.proxy_configured`, `network.agent_transport`, and `network.fetch_transport`. Proxy URLs and credentials are never returned.

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=127.0.0.1,localhost
node dist/index.js
```

Inside Docker Desktop, a proxy on the host is `host.docker.internal`, not `127.0.0.1` inside the container:

```bash
docker run --rm -p 8080:8080 \
  -e AUTH_MODE=byok \
  -e HTTPS_PROXY=http://host.docker.internal:7890 \
  -e HTTP_PROXY=http://host.docker.internal:7890 \
  -e NO_PROXY=127.0.0.1,localhost \
  cursor-sdk2api:local
```

Do not put proxy userinfo in compose files or docs.

## Client configuration

Replace the origin if the gateway is not on loopback. In BYOK mode the key is the Cursor API key. In managed mode it is `GATEWAY_ACCESS_KEY`.

### Claude Code → Messages

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN="$CURSOR_API_KEY"
export ANTHROPIC_MODEL=claude-sonnet-4-6
claude
```

Claude Code sends `x-api-key`. The gateway accepts that or `Authorization: Bearer`. Keep `ANTHROPIC_BASE_URL` at the origin (no `/v1`); Claude Code appends `/v1/messages`.

Fable 5 may be missing from Privacy Mode or Team catalogs until you approve Fable 5 data retention in the [Cursor Dashboard](https://cursor.com/dashboard/restricted_models/claude-fable-5).

### Grok Build → Responses

```toml
[models]
default = "cursor-gw"

[model.cursor-gw]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
api_key = "<cursor-api-key>"
model = "grok-4.6"
api_backend = "responses"
```

Grok's local `web_search` / `web_fetch` (if you leave them enabled) run **in Grok**, then come back as ordinary function results. They are not Cursor ambient tools and they are not xAI `x_search`.

### Codex / OpenAI Responses

```toml
model = "composer-2.5"
model_provider = "cursor-sdk2api"

[model_providers.cursor-sdk2api]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "CURSOR_API_KEY"
```

Or with the OpenAI SDK:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=CURSOR_API_KEY)
client.responses.create(model="composer-2.5", input="hello")
```

Do not send `previous_response_id`. Pending tools resume with trailing `function_call_output` items whose `call_id` matches the live tool id. Completed follow-up uses `x-cursor-session-id`. If your Codex build insists on stored-response IDs, this gateway will 422; use Chat Completions instead.

### OpenAI Chat Completions

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=CURSOR_API_KEY)
client.chat.completions.create(
    model="composer-2.5",
    messages=[{"role": "user", "content": "hello"}],
)
```

### new-api / generic SDK sidecar

```text
Base URL (Anthropic upstream):  http://<gateway-host>:8080
Base URL (OpenAI upstream):     http://<gateway-host>:8080/v1
API key:                        Cursor key (BYOK) or GATEWAY_ACCESS_KEY (managed)
Model discovery:                GET /v1/models
```

Do not embed `@cursor/sdk` inside another gateway process. This process stays a sidecar.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/console/` | none to load the page | Optional BF Labs Operator Console. |
| `GET` / `POST` / `DELETE` | `/v0/management/accounts` | **none in v0.1** | Lists, adds, and deletes persisted Cursor keys. Returns the raw key. Trusted network or auth proxy only. |
| `GET` | `/health` | none | Build, SDK version, readiness, capability bits, transport modes, `verification`. Never includes account data, keys, or proxy URLs. |
| `GET` | `/v1/models` | required | Live `Cursor.models.list()` with exact public IDs. Empty list plus a reason when unavailable. |
| `GET` | `/v1/account` | required | `Cursor.me()` identity plus current-period Dashboard usage from the same User API Key. |
| `POST` | `/v1/messages/count_tokens` | required | Local estimate for Claude Code context sizing. |
| `POST` | `/v1/messages` | required | Anthropic Messages text, SSE, caller tools, parallel tools, multi-round continuation, in-process replay. |
| `POST` | `/v1/chat/completions` | required | OpenAI Chat adapter on the same run engine. |
| `POST` | `/v1/responses` | required | OpenAI Responses adapter on the same run engine. |

Default **API Compatibility Profile** (all three inference endpoints):

- Request `tools[]` map to SDK `local.customTools`
- Built-in allowlist is `["mcp"]` when caller tools exist, otherwise `[]`
- Ambient Cursor capabilities (`shell`, `read`, `edit`, `task`, `webSearch`, `webFetch`) are denied
- `settingSources: []` and an empty workspace. The caller's repo is never implied

## Authentication

**BYOK (default).** Each request sends a Cursor API key as `Authorization: Bearer` or `x-api-key`. The process keeps the key in memory and isolates sessions by an irreversible fingerprint.

**Managed (optional).** The process holds `CURSOR_API_KEY`. Clients send a different `GATEWAY_ACCESS_KEY`. Health does not expose the managed Cursor identity.

**Console accounts.** The console writes Cursor account files under `STATE_DIR/auths` (`0700` directory, `0600` files, plaintext secrets). Reloading the page reloads those keys from `/v0/management/accounts`. That management route has no separate access key.

Forbidden: browser cookies, Desktop/CLI private stores, email/password login, refresh-token import, and putting keys in URLs, model names, or tool IDs.

## Operator Console and quota

`/console/` is static Vite assets served by the same Node process. No second production service.

- Overview: health, SDK version, transport mode
- Accounts: add / list / remove persisted Cursor keys
- Quota: current-period spend, remaining included usage, plan metadata, model-family percentages when Dashboard returns them
- Playground: Messages, Chat Completions, and Responses
- Connect: the same client recipes as this README
- English / Chinese, light / dark

`/v1/account` uses the User API Key twice: official `Cursor.me()` for identity, then a short-lived Dashboard access token for `GetCurrentPeriodUsage` and `GetPlanInfo`. No Cookie, Team Admin key, or OAuth token. If Dashboard is down, identity can still return and the body is `status: partial` with an explicit reason. Missing usage is omitted, never invented as zero.

## Architecture and tool ownership

```
Claude Code | Grok Build | Codex | OpenAI SDK | new-api | curl
        |
        v
HTTP /v1/messages | /v1/chat/completions | /v1/responses
        |
        v
protocol parse (Chat / Responses -> canonical ParsedMessages)
        |
        v
RunCoordinator
  SessionRegistry   (fingerprint, model, tool_use_id, TTL)
  ToolBridge        (caller tools -> local.customTools)
  EventPump         (one run.stream() consumer)
  protocol writer   (Anthropic SSE | Chat data: | Responses events)
        |
        v
official @cursor/sdk  (Agent / Run / Jsonl store / models.list / me)
```

Chat Completions and Responses do not own a second session engine. Only the parser and HTTP writer differ.

Two different "tools" exist. Mixing them up is how people invent `x_search` and silent shell access.

| Owner | What runs | Where it runs |
|---|---|---|
| Claude Code / Grok / Codex | Their local tools: read, edit, shell, and that client's web/network search if enabled | Your project directory, in the client process |
| This gateway | Model inference + tool *selection* | `@cursor/sdk` Agent with an empty cwd |
| Cursor ambient tools | `shell`, `read`, `edit`, `task`, `webSearch`, `webFetch` | **Denied** |
| xAI | `x_search` and other xAI-native hosted tools | **Not on this path** |

When caller tools are present, the prompt tells the model that custom MCP tools execute in the API caller's environment and that the SDK cwd is not authoritative.

## Protocol notes

Non-stream Messages returns an assistant message plus `cursor_session_id` (`ses_...`). Send that value as `x-cursor-session-id` for a completed follow-up.

Tool continuation uses the same process-local Agent/Run. The latest user turn must contain only `tool_result` blocks, matched by `tool_use_id` (order is not authoritative).

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

Chat Completions uses the same session header. Trailing `role:tool` messages continue the pending run. `n` must be `1` or omitted. Stream frames are OpenAI `data:` chunks ending with `data: [DONE]`.

Responses pending tools resume only when the latest `input` items are `function_call_output` and each `call_id` matches a live tool id. `function_call_output.output` accepts a string or text parts. Image or file tool-output parts are `422` until they can be mapped to the SDK without loss. Stream events use Responses names (`response.created` … `response.completed`). On error the stream emits a Responses `error` event and does not emit `response.completed`.

Keep the public catalog model ID unchanged. For Grok 4.6 xhigh:

```json
{
  "model": "grok-4.6",
  "reasoning_effort": "xhigh",
  "max_tokens": 64,
  "messages": [{ "role": "user", "content": "hello" }]
}
```

Advanced callers may pass validated official SDK pairs in `cursor_model_params`. Changing explicit parameters on the same session is `409 cursor_session_conflict`.

`max_tokens` is accepted so Claude Code-shaped requests parse. The SDK harness has no precise max-token enforcement, and the gateway does not emulate one. Tool choice maps into Harness directives: Messages supports `auto` / `any` / named `tool`; Chat and Responses support `auto` / `required` / named `function`. Serial-tool flags are honored. `tool_choice=none` fails closed.

`temperature`, `top_p`, and `stop_sequences` are accepted and **not mapped** to `@cursor/sdk`.

Default tool-batch debounce is 1500ms from the latest callback (`TOOL_BATCH_SETTLE_MS`). Live SDK probes saw Claude callbacks more than one second apart in one assistant turn.

Usage: intermediate tool turns return zero usage with `usage_deferred: true`. Cumulative SDK usage is confirmed once on the final turn via `run.wait()`. Cache and reasoning fields appear only when the SDK reports them.

Public error types: `invalid_request`, `authentication_error`, `forbidden`, `cursor_session_conflict`, `cursor_session_lost`, `rate_limited`, `cursor_empty_turn`, `cursor_upstream_error`, `cursor_timeout`.

## Security and limitations

Treat v0.1 as a trusted local sidecar.

- `/v0/management/accounts` has no access key and returns raw Cursor keys.
- Account JSON under `STATE_DIR/auths` is plaintext. Prefer an encrypted volume.
- `STATE_DIR/sdk-store` is the official SDK conversation/checkpoint store. This gateway does not audit those files.
- Lineage under `STATE_DIR/lineage` stores resume metadata only (session id, agent id, fingerprint, model, params, pending tool ids/names, optional result digest). No API keys, prompts, or tool payloads.
- Live tool callbacks are in-memory Promises. Multi-instance and blue/green deploys need drain plus sticky ownership.
- After a crash, pending recovery requires the same `STATE_DIR` and an exact identity/catalog/result-batch match. A mismatch is `409`, not a silent new Agent. Duplicate-same after restart has no persisted assistant body.
- Do not enable payload logging, `DEBUG=*`, or `DEBUG=proxy-agent` on a shared host.
- Public Internet still needs TLS, an auth proxy, encrypted state, monitoring, and an explicit threat model. Process-local fingerprint isolation is not hostile multi-tenant hosting.
- Official `@cursor/sdk` license and Cursor Terms still apply. See [NOTICE.md](NOTICE.md).
- Production `npm audit --omit=dev` (2026-08-15) reports 3 transitive findings in the SDK tree (`undici` high; `@connectrpc/connect-node` / `@cursor/sdk` moderate). `fixAvailable` is false. Do not run a destructive `npm audit fix`.

Not implemented:

- Responses `previous_response_id` reconstruction, `store=true`, background mode, conversation objects, unknown `include` expansions, hosted built-in tools
- xAI-native `x_search`
- Cursor Agent Profile (`/v1/agents`, native shell/edit, plan mode)
- Distributed session ownership / Redis / Postgres
- An official new-api channel type

Development defaults: 4 global active runs, 2 per credential, 30 minute session TTL, 10 minute replay TTL, 60 minute run deadline. Drain still accepts awaiting `tool_result`. Host default `STATE_DIR` is `$TMPDIR/cursor-sdk2api/state`. Image and compose default is `/data`.

## Testing, evidence, status

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run dev` builds the console once and starts the gateway. `npm run dev:web` is UI-only.

Tests inject a deterministic fake SDK. They never read real Cursor credentials. CI in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs typecheck, tests, build, and `docker build`.

Opt-in live matrix (not default CI, not `npm test`):

```bash
npm run build
CURSOR_LIVE_SMOKE=1 CURSOR_API_KEY=... npm run live:smoke
```

The runner binds loopback only and writes a redacted receipt. See [`scripts/live-smoke/README.md`](scripts/live-smoke/README.md).

Published sample: [`docs/evidence/2026-08-15-live-smoke.md`](docs/evidence/2026-08-15-live-smoke.md). Dated, credential-specific, not inherited by a different binary.

- Host Claude Sonnet 4.6 and Fable 5 passed the required proxied Messages matrix, including parallel tools and a Claude Code-shaped Fable request.
- Composer 2.5 passed that host matrix, including same-turn parallel selection.
- Grok 4.6 xhigh passed text, SSE, single tool, multi-round, replay, pending-restart fail-closed (then `409`), and completed resume. Same-turn parallel was observed once and missed later; do not market it as guaranteed.
- A Node 22 container proved both SDK data planes honor a configured HTTP(S) proxy and fail when that proxy is unreachable. Fable container parallel/upstream success was not fully repeatable.
- Later local operator probes (not published receipts) connected real Claude Code (Sonnet 4.6) and Grok Build (Responses, Grok 4.6) and confirmed those clients executed their own workspace file tools.

v0.1. Chat Completions and Responses are adapters on the Messages run engine. npm publish, GHCR digest, and a new-api upstream PR are separate later decisions.

## Docs

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Run ownership, proxy transports, restart semantics |
| [docs/PROTOCOL_COMPATIBILITY.md](docs/PROTOCOL_COMPATIBILITY.md) | Endpoint and block support matrix |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Local, Docker, drain, and upgrade |
| [docs/SECURITY.md](docs/SECURITY.md) | Credentials, logging, and threat notes |
| [docs/NEW_API_INTEGRATION.md](docs/NEW_API_INTEGRATION.md) | Generic Anthropic / OpenAI sidecar |
| [docs/DELIVERY_PLAN.md](docs/DELIVERY_PLAN.md) | Public roadmap |
| [CHANGELOG.md](CHANGELOG.md) | v0.1 notes |

## License and contributing

MIT. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md).

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Deterministic contract tests first; isolated Docker build second; live smoke only with an explicitly supplied test credential.
