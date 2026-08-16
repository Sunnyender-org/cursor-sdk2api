# Live smoke

Opt-in credentialed matrix against a real Cursor catalog. Default CI must not set `CURSOR_LIVE_SMOKE=1`.

The runner never reads `.env`, browser cookies, or files from other projects. It only uses process environment that **you** export in the current shell.

## Invoke

```bash
npm run build
export CURSOR_LIVE_SMOKE=1
export CURSOR_API_KEY=...   # do not commit; do not paste into chat
npm run live:smoke
```

Optional:

- `GATEWAY_BASE_URL` — attach to an already running gateway instead of spawning `dist/index.js` on `127.0.0.1`. Restart cases are `not_run` and the process exits `2` (incomplete), not green.
- `LIVE_SMOKE_MODELS` — comma list; default `claude-sonnet-4-6,claude-fable-5,grok-4.6,composer-2.5`.
- `LIVE_SMOKE_OUTPUT` — receipt path. Default is a temp file, not the repository.
- `LIVE_SMOKE_TIMEOUT_MS` — per-request timeout (default 180000).

Child mode binds **127.0.0.1** on a free port, uses isolated temp `STATE_DIR` / workspace, SIGTERM on exit, then deletes the temp dirs.

## What it checks

Per resolved catalog id: authenticated `/v1/models`, non-stream text, SSE shape, single tool continuation, parallel two-tool batch, multi-round two batches, in-process duplicate-same replay, pending `tool_result` after hard restart (`cursor_session_lost`), completed `x-cursor-session-id` resume after restart. Fable also sends a Claude Code-style Messages header/body shape.

Catalog-missing required names are `catalog_missing` failures, not skips. Capability skips happen only when the live catalog lists parameters and omits that capability.

Stdout is pass/fail/timings/model/status/error type only. Receipts are redacted JSON. The runner does not call `/v1/account` and does not keep prompt/tool/assistant bodies.

## Not claimed

This document does not record any live model result. Running the script requires an explicitly supplied test credential.
