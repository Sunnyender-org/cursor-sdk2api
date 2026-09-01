# cursor-sdk2api Repository Rules

## Product contract

This is a public MIT gateway built on the official `@cursor/sdk`. Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses must share one coordinator/session/replay engine through protocol-specific adapters.

- Cursor SDK is the only Cursor execution engine.
- The default runtime profile is `sdk`. `sand` is an explicit public v0.4 profile: it requires Grok Bot grant, a hash-guarded 1.0.30 loader, and isolated store/workspace. There is no SDK↔Sand auto-fallback.
- Cursor ambient shell, read, edit, and task remain disabled.
- Hosted `webSearch` / `webFetch` stay off unless `HOSTED_SEARCH_MODE=auto` and the client sends a bare live web_search tool. Filters, required/named choice, Chat `web_search_options`, and `x_search` stay fail closed.
- Client tools map to SDK custom tools/MCP and execute in the client workspace.
- Cursor and Grok Build are separate provider routes; do not claim native xAI `x_search` on this path.
- Unsupported hosted tools, stored responses, or continuation features must fail closed rather than lose semantics.

## Continuation and isolation invariants

- Sessions bind to the exact credential fingerprint, model, tool catalog, and pending tool-id batch.
- Duplicate different tool results fail closed.
- Cold recovery requires a complete transcript whose latest assistant tool batch matches the submitted results.
- Never blindly re-execute a completed external tool.
- The gateway is a trusted single-process sidecar, not a multi-tenant control plane.

## Security

Read `docs/SECURITY.md` before changing credentials, account pooling, state, logging, console, proxy, or continuation behavior.

- Never log API keys, cookies, prompts, thinking, tool schemas, arguments, or results.
- `STATE_DIR` is sensitive owner-only state.
- The management API and console must remain loopback-only unless an authenticated reverse proxy is explicitly designed and approved.
- Browser cookies, private Cursor HTTP protocols, and BeefAPI user tokens are forbidden.

## Source and verification

Use `README.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL_COMPATIBILITY.md`, `docs/SECURITY.md`, and the nearest tests.

```bash
npm run typecheck
npm test
npm run build
npm run secret:scan
```

Live Cursor credentials, deployment, npm/GHCR publication, release, and production changes require separate authorization. Local contract tests do not prove live model behavior.

