# Deployment

## Local

```bash
cp .env.example .env
npm ci
npm run build
node dist/index.js
```

The immutable build includes the optional BF Labs Operator Console at
`/console/`. It is served by the same Node process from `dist/console`; no
second production service is required. Set `CONSOLE_DIR` only when an operator
intentionally supplies a different prebuilt static bundle.

Loading the page is unauthenticated. Models, account, Messages, and Chat calls
still use the normal gateway authentication. The bundled console keeps the key
in React memory only and never writes browser storage, cookies, URLs, or server
configuration.

## Docker

```bash
docker build -t cursor-sdk2api:local .
docker run --rm -p 8080:8080 -e AUTH_MODE=byok cursor-sdk2api:local
```

`docker-compose.yml` is a single-service wrapper. It does not mount files from other projects and does not ship secrets.

## GHCR releases

An approved `v<package-version>` tag runs the release workflow. It re-runs the
deterministic gate, secret scan, and critical-image vulnerability scan, then
publishes `linux/amd64` and `linux/arm64` images with OCI provenance and SBOM
attestations. The generated GitHub Release includes `image-digest.txt` so an
operator can deploy an immutable reference:

The runtime stage is a pinned non-root distroless Node 22 / Debian 13 image. It contains no
shell, package manager, or npm CLI; production dependencies are pruned in the
build stage and copied into the runtime image.

```bash
docker pull ghcr.io/sunnyender-org/cursor-sdk2api@sha256:<digest>
docker run --rm -p 8080:8080 \
  ghcr.io/sunnyender-org/cursor-sdk2api@sha256:<digest>
```

Source changes and a green workflow do not mean an image exists. Creating the
tag and GitHub Release remains a separate maintainer action.

The existing `v0.1.0` source Release predates this GHCR workflow and has no
container asset. Before a later approved release, bump `package.json`, create
the matching new tag, verify the GHCR package is public, and prove an
unauthenticated pull by digest.

For a two-service new-api example, see
[`NEW_API_INTEGRATION.md`](NEW_API_INTEGRATION.md).

## Outbound proxy

The official SDK does not automatically inherit the host proxy. When
`HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` is present (uppercase or lowercase),
the gateway routes both SDK data planes: Agent runs switch to HTTP/1.1 through
`proxy-agent`, and catalog/account fetches use Undici's environment proxy
dispatcher. `NO_PROXY` is honored. Only `http://` and `https://` proxy URLs are
accepted; SOCKS/PAC configurations fail closed. Health reports only
`proxy_configured`, `agent_transport`, and `fetch_transport`; URLs and
credentials are never exposed.

For Docker Desktop, point at a host proxy with `host.docker.internal`, for
example `HTTPS_PROXY=http://host.docker.internal:7890`. `127.0.0.1` inside the
container is the container itself.

## State directory

Set `STATE_DIR` for:

- official `@cursor/sdk` `JsonlLocalAgentStore` (`$STATE_DIR/sdk-store/<credential-fingerprint>`)
- gateway lineage metadata (`$STATE_DIR/lineage`, mode `0700` / files `0600`)

Host / local-dev default (no `STATE_DIR`) is a process temp path: `$TMPDIR/cursor-sdk2api/state`. The container **image** and `docker-compose.yml` default `STATE_DIR` to `/data` and compose declares a named volume. A bare `docker run` without `-e STATE_DIR` still gets `/data` from the image `ENV`.

Lineage stores only session id, SDK agent id, credential fingerprint, model and explicit model parameters, state, pending tool ids, optional result digest, and timestamps. It does not store API keys, prompts, or tool args/results. Assistant replay bodies are **not** persisted; in-process duplicate-same still works, but after a restart a tool-result replay is `409 cursor_session_lost`.

Session/registry TTL and the periodic sweep share the same clock. Completed lineage expires with `SESSION_TTL_MS` (default 30 minutes). Pending records stay until that TTL so a restart `tool_result` is a deterministic `cursor_session_lost`, then they are deleted. Graceful shutdown does not delete recoverable completed lineage.

Completed follow-up with `x-cursor-session-id` can `Agent.resume` within the session TTL if credential and model match. Pending tool callbacks are never restored.

## BYOK vs managed

- BYOK: clients send a Cursor API key. Suitable for a trusted local sidecar.
- Managed: set `AUTH_MODE=managed`, `CURSOR_API_KEY`, and a different `GATEWAY_ACCESS_KEY`.

BYOK credentials share the gateway process and capacity limits, but their official SDK stores and empty workspace directories are separated by credential fingerprint. This is process-local tenant isolation, not a claim of hardened hostile multi-tenant hosting; public Internet deployment still requires TLS, access controls, encrypted state, monitoring, and an explicit operator threat model.

## Drain and upgrade

In-process SDK Run handles and pending tool Promises cannot move to another process.

1. Stop sending new sessions to the old instance (`SIGTERM` starts drain).
2. Keep routing existing tool-result traffic to the same instance (sticky ownership).
3. Wait until active sessions reach zero or the drain deadline.
4. Then replace the process. Completed lineage under `STATE_DIR` survives; pending tool turns do not.

A load balancer that retries a pending continuation onto a new replica will see `409 cursor_session_lost`. That is the correct failure, not a successful empty turn.

Completed follow-up after restart requires the same `STATE_DIR` volume, `x-cursor-session-id`, and matching credential/model.

## Resource defaults

Development defaults: 4 global active runs, 2 per credential, 30 minute awaiting TTL, 10 minute replay TTL, 60 minute run deadline.
