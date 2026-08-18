# Native compatibility live smoke — 2026-08-18

This is the redacted public summary of an opt-in local live run against the official Cursor SDK. The machine receipt remains outside git and contains no prompt, tool payload, account identity, or credential.

## Result

- Gateway: current `main` plus the pending-restart acceptance correction
- Models: exact catalog IDs `claude-sonnet-4-6` and `grok-4.6`
- Grok effort: explicit `xhigh`
- Result: `ok=true`, `incomplete=false`, `required_failures=0`

| Case | Sonnet 4.6 | Grok 4.6 |
|---|---:|---:|
| non-stream text | pass, 9.1s | pass, 6.1s |
| incremental SSE | pass, 7.5s | pass, 6.3s |
| single tool continuation | pass, 14.3s | pass, 12.5s |
| same-turn parallel tools | pass, 15.4s | pass, 20.6s |
| multi-round tools | pass, 22.4s | pass, 16.1s |
| duplicate-same replay | pass, 77.3s | pass, 11.9s |
| pending tool recovery after hard restart | pass, 23.4s | pass, 19.7s |
| completed Agent resume after restart | pass, 18.1s | pass, 16.9s |

The hard-restart case opens a real tool call, terminates and restarts the gateway process, resends the original tool catalog and exact pending tool result, then requires the opaque result marker in the final model answer. A 200 response without that marker does not pass.

Grok thinking was skipped because the authenticated Cursor catalog did not expose that capability for this model. It is not counted as a required failure.
