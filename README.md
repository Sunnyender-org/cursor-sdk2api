<p align="center">
  <img src=".github/logo.svg" width="96" alt="cursor-sdk2api logo">
</p>

<h1 align="center">cursor-sdk2api</h1>

<p align="center">
  The official Cursor SDK, on the APIs your agents already speak.
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="https://github.com/Sunnyender-org/cursor-sdk2api/actions/workflows/ci.yml">CI</a> ·
  <a href="LICENSE">MIT</a>
</p>

`cursor-sdk2api` turns the published [`@cursor/sdk`](https://www.npmjs.com/package/@cursor/sdk) into Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses APIs. It uses the official Cursor Agent harness, not browser cookies, private transports, or CLI session scraping.

<p align="center">
  <img src="docs/assets/console-accounts.jpg" alt="cursor-sdk2api multi-account operator console">
</p>

## Highlights

- **Claude Code** via `/v1/messages`: SSE, tools, parallel and multi-round continuation, cache usage, resume, token estimate.
- **Grok Build** via `/v1/responses`: streaming, function tools, continuation, reasoning usage.
- **Codex / Responses clients** via `/v1/responses`: Responses contract, function tools, streaming.
- **OpenAI SDK** via `/v1/chat/completions`: chat, streaming, tools.

- **Claude 1M mode:** when Cursor's live catalog exposes `context=1m`, including on Sonnet 4.6 and Fable 5, the official SDK parameter is forwarded unchanged.
- **Native client tools:** filesystem, shell, web, and network tools stay in Claude Code, Grok, or Codex and run in your local workspace.
- **One tool engine:** all three protocols share the same Cursor SDK run, parallel-tool, continuation, replay, and session coordinator.
- **One gateway key, many accounts:** persistent Cursor account pool, model-aware round-robin, stale SDK-auth recovery, pre-semantic account failover, Dashboard quota, web console, and Docker.
- **Cold continuation recovery:** a complete client transcript can rebuild an expired or moved tool turn while replaying already-completed tools locally instead of executing their side effects twice.
- **new-api integrated:** ready-made external deployment, channel templates, compose E2E, and acceptance smoke. [Open the new-api guide](docs/NEW_API_INTEGRATION.md).

> Cursor-routed Grok does not provide xAI-native `x_search`. Client-owned web and network tools still work as normal function tools.

## Quick start

Requires Node.js 22.19 or newer, one gateway key, and at least one Cursor User API Key to import.

```bash
git clone https://github.com/Sunnyender-org/cursor-sdk2api.git
cd cursor-sdk2api
npm ci
npm run build
AUTH_MODE=managed GATEWAY_ACCESS_KEY='replace-me' node dist/index.js
```

Open [http://localhost:8080/console/](http://localhost:8080/console/), import one or more Cursor accounts, then call every account through the same gateway key:

```bash
curl http://localhost:8080/v1/models \
  -H "Authorization: Bearer $GATEWAY_ACCESS_KEY"
```

Docker:

```bash
docker compose up --build
```

If Cursor needs a proxy, set `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`. The gateway applies them to both SDK data planes. SOCKS and PAC URLs fail closed.

## Client setup

### Claude Code

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_AUTH_TOKEN="$GATEWAY_ACCESS_KEY"
export ANTHROPIC_MODEL=claude-sonnet-4-6
claude
```

### Grok Build

```toml
[model.cursor]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
api_key = "<gateway-key>"
model = "grok-4.6"
api_backend = "responses"
```

### Codex

```toml
model = "composer-2.5"
model_provider = "cursor-sdk2api"

[model_providers.cursor-sdk2api]
name = "cursor-sdk2api"
base_url = "http://127.0.0.1:8080/v1"
wire_api = "responses"
env_key = "GATEWAY_ACCESS_KEY"
```

Responses clients that require `previous_response_id`, stored response objects, or hosted OpenAI tools are not supported yet.

## Tools and search

Client tools are converted to SDK `local.customTools` through MCP. The model chooses tools through Cursor's harness, while the outer client executes them in its own workspace.

- Supported: Claude Code, Grok, and Codex local tools, including client-owned web or network search.
- Disabled: Cursor ambient shell, read, edit, task, `webSearch`, and `webFetch`.
- Not available on this route: xAI `x_search`.
- Not implemented: hosted OpenAI `web_search`, `file_search`, and `computer`.

## Operations

- `/console/`: local operator console
- `/v1/models`: live Cursor model catalog
- `/v1/account`: pooled Cursor identities and current Dashboard usage in managed mode
- `/health`: capabilities, SDK version, and proxy transport mode
- `STATE_DIR`: account, SDK store, and resume state

Managed mode follows CPA's split between client keys and upstream credentials: clients receive only `GATEWAY_ACCESS_KEY`; imported Cursor keys stay in the gateway account store. New sessions use model-aware round-robin. Continuations stay pinned when the original account is healthy; before semantic output, one alternate managed account may be tried. If the original account/session is gone, an exact full transcript can cold-branch safely. BYOK remains available for a trusted single-user sidecar.

`v0.1` is a trusted single-process sidecar. The management account endpoint has no separate authentication. Imported Cursor keys are stored in owner-only state files and are never returned to the browser after import. The supplied compose files bind the console to loopback; authenticate and restrict `/console/` plus `/v0/management/*` at any Internet-facing proxy.

## Verification

The deterministic suite contains 189 tests. The latest redacted receipt proves persisted and full-transcript recovery on Sonnet 4.6 and Grok 4.6 xhigh: [recovery live smoke](docs/evidence/2026-08-19-beefapi-sync-live-smoke.md). The earlier four-model receipt also covers Fable 5 and Composer 2.5: [four-model evidence](docs/evidence/2026-08-15-live-smoke.md).

```bash
npm run typecheck
npm test
npm run build
```

## Documentation

- [Protocol compatibility](docs/PROTOCOL_COMPATIBILITY.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [new-api integration](docs/NEW_API_INTEGRATION.md)

MIT licensed. `@cursor/sdk` remains subject to its own license and Cursor's Terms. This project is not affiliated with Cursor or Anysphere.
