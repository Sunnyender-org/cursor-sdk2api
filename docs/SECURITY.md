# Security

## Credentials

- Default BYOK: the request bearer/`x-api-key` is the Cursor key.
- Managed mode uses one distinct gateway access key in front of a persistent Cursor account pool. The gateway key must not equal a seeded Cursor key.
- Runtime keys are fingerprinted with SHA-256 and never written to logs, replay records, gateway lineage files, or error bodies. When Operator Console account persistence is enabled, the explicitly added raw Cursor keys are stored in owner-only JSON files under `STATE_DIR/auths`. The official `@cursor/sdk` `JsonlLocalAgentStore` also persists Agent conversation/checkpoints in its own format under credential-fingerprint partitions in `STATE_DIR/sdk-store`; each credential gets a private empty-workspace partition. The entire state volume is sensitive.

## Tool isolation

The API Compatibility Profile does not grant Cursor ambient filesystem or shell tools. Workspace is an empty directory owned by this process. `settingSources` is empty.

## Operator console

`/console/` is a static UI served by the same process as the API. Its v0.1 account-management endpoint has no separate access key. A raw Cursor key is sent only once when an operator imports it; list, probe, and playground responses return an account id and masked hint, never the stored key. Account JSON files remain plaintext secrets protected by `0700`/`0600` filesystem permissions. The management API can add/remove pool credentials and run a probe, so the supplied compose files bind the console to `127.0.0.1` only. Prefer an encrypted state volume. An Internet-facing reverse proxy must authenticate and restrict `/console/` and `/v0/management/*`. If `CONSOLE_DIR` is overridden, keep it pointed at a dedicated, trusted build tree.

## Logging

Default structured logs may include request id, model id, stream flag, status, pending count, and final numeric usage. They must not include API keys, cookies, prompts, thinking, tool schemas, tool arguments, or tool results.

Proxy URLs can contain credentials and are therefore secrets. They remain in
the process environment only, are never copied into runtime config or health,
and URL userinfo is redacted if an upstream error includes it. Do not enable
dependency-wide debug output such as `DEBUG=*` or `DEBUG=proxy-agent` on a
shared host: third-party transport diagnostics can print proxy configuration
before gateway redaction. Prefer a credential-free loopback proxy URL or a
separately protected environment secret.

## Threat notes

- Managed requests authenticate with the gateway key, but SDK sessions bind to the selected Cursor credential fingerprint and model. Continuation cannot rotate to another account.
- SDK stores and empty workspaces are partitioned by credential fingerprint with owner-only directories; a tenant never receives another tenant's partition path or Agent ID through the HTTP API.
- Duplicate different tool results fail closed to avoid a second side effect.
- After restart, pending continuations prefer persisted SDK Agent lineage with an exact credential, model, tool catalog, and pending tool-id batch. A cold branch is allowed only when the client supplies a complete transcript whose latest assistant tool batch exactly matches the submitted results; otherwise it fails closed.
- Cold recovery never blindly re-executes a completed external tool. Historical results are replayed only for the same stable tool-name/input signature, in transcript order; genuinely new calls still return to the client.
- Completed resume is bound to credential fingerprint + canonical model/tool/session policy. Mismatch is `409 cursor_session_conflict`.
- Gateway lineage files are owner-only (`0700`/`0600`) and contain only resume metadata, including non-secret model parameters; they omit API keys, prompts, system text, tool schemas/args/results, and assistant replay bodies. Corrupt records are quarantined and ignored. Optional `lastResultDigest` is a hash, not a payload.
- `STATE_DIR` is sensitive local state: lineage metadata plus the official SDK store (conversation/checkpoint payloads). Treat it as owner-only. Prefer an encrypted volume and `0700` access; do not share or backup the directory as if it were anonymous cache.
