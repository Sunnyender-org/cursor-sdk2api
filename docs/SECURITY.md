# Security

## Credentials

- Default BYOK: the request bearer/`x-api-key` is the Cursor key.
- Managed mode uses a distinct gateway access key. The two secrets must not be equal.
- Keys are fingerprinted with SHA-256 and never written to logs, replay records, **gateway** lineage files, or error bodies. The official `@cursor/sdk` `JsonlLocalAgentStore` persists Agent conversation/checkpoints in its own format under credential-fingerprint partitions in `STATE_DIR/sdk-store`; each credential also gets a private empty-workspace partition. This gateway does not audit or redact SDK-owned checkpoint contents, so the entire state volume remains sensitive.

## Tool isolation

The API Compatibility Profile does not grant Cursor ambient filesystem or shell tools. Workspace is an empty directory owned by this process. `settingSources` is empty.

## Operator console

`/console/` is an unauthenticated static UI served by the same process as the API. Keys remain in React memory only and are not stored in browser storage, cookies, URLs, or server configuration. Do not publish port `8080` without TLS and an authentication proxy. If `CONSOLE_DIR` is overridden, keep it pointed at a dedicated, trusted build tree rather than a writable or shared directory.

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

- Cross-tenant continuation is rejected by credential fingerprint and model binding.
- SDK stores and empty workspaces are partitioned by credential fingerprint with owner-only directories; a tenant never receives another tenant's partition path or Agent ID through the HTTP API.
- Duplicate different tool results fail closed to avoid a second side effect.
- After restart, pending continuations are `cursor_session_lost` rather than a silent new Agent.
- Completed resume is bound to credential fingerprint + model. Mismatch is `409 cursor_session_conflict`.
- Gateway lineage files are owner-only (`0700`/`0600`) and contain only resume metadata, including non-secret model parameters; they omit API keys, prompts, system text, tool schemas/args/results, and assistant replay bodies. Corrupt records are quarantined and ignored. Optional `lastResultDigest` is a hash, not a payload.
- `STATE_DIR` is sensitive local state: lineage metadata plus the official SDK store (conversation/checkpoint payloads). Treat it as owner-only. Prefer an encrypted volume and `0700` access; do not share or backup the directory as if it were anonymous cache.
