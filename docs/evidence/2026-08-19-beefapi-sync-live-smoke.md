# Cursor recovery sync live smoke — 2026-08-19

Redacted public summary of an opt-in local run against the official Cursor SDK. The private machine receipt stays outside git and contains no credential, account identity, prompt, tool payload, or workspace path.

## Result

- Models: exact Cursor catalog IDs `claude-sonnet-4-6` and `grok-4.6`
- Grok effort: explicit `xhigh`
- Result: `ok=true`, `incomplete=false`, `required_failures=0`
- Deterministic suite: 189/189

| Case | Sonnet 4.6 | Grok 4.6 xhigh |
|---|---:|---:|
| non-stream text | pass, 8.3s | pass, 5.7s |
| incremental SSE | pass, 5.6s | pass, 5.9s |
| single tool continuation | pass, 15.8s | pass, 11.5s |
| same-turn parallel tools | pass, 16.2s | pass, 24.8s |
| multi-round tools | pass, 20.1s | pass, 20.2s |
| duplicate-same replay | pass, 13.7s | pass, 15.0s |
| persisted pending recovery after restart | pass, 23.0s | pass, 20.8s |
| full-transcript cold recovery without lineage | pass, 23.0s | pass, 22.0s |
| completed Agent resume after restart | pass, 19.4s | pass, 19.6s |

The cold-recovery case opens a real external tool turn, stops the gateway, deletes only the runner-owned lineage directory, restarts the process, and resubmits a complete transcript. The final answer must contain a new opaque result marker. Empty HTTP 200, a repeated client-facing tool call, or a missing marker fails the case.

Managed multi-account pre-semantic failover and stale-auth credential probing use deterministic integration tests because the live runner intentionally uses BYOK and cannot safely force a real account outage.
