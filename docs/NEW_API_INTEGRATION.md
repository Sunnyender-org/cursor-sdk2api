# new-api integration

`cursor-sdk2api` is an external provider for new-api. It does not patch new-api,
run inside the new-api process, or add the Cursor SDK to the new-api image. Both
services use ordinary Anthropic/OpenAI-compatible HTTP on one Docker network.

This guide was checked against QuantumNous/new-api main
`e2c7aa7b102c2075eae2377df3508658d45e88dc` (2026-08-15). new-api already has
the two required generic channel types, so no adaptor is necessary:

| new-api channel | Type | Gateway endpoint | Recommended models |
|---|---:|---|---|
| Anthropic | 14 | `/v1/messages` | `claude-sonnet-4-6` |
| OpenAI | 1 | `/v1/chat/completions`, `/v1/responses` | `grok-4.6`, `composer-2.5` |

Use two channels. The Anthropic channel keeps Claude Messages and tool-result
continuation in their native shape. The OpenAI channel keeps OpenAI function
calls, parallel-tool fields, and Responses on their native paths.

## Start both services

```bash
cd integrations/new-api
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000`, complete new-api's normal first-run setup, and
open `http://localhost:8080/console/` to import one or more Cursor accounts.
Then create a new-api user token for client requests. The compose file does not
create an administrator, token, or channel, and it contains no working secret.
For a private local smoke, choose new-api's **self-use** mode; current new-api
accepts otherwise-unpriced model IDs in that mode. In operation mode, add
explicit model ratios/prices for `claude-sonnet-4-6`, `grok-4.6`, and
`composer-2.5` before testing. Do not use a fallback ratio as a customer billing
contract.

For an immutable deployment, set `CURSOR_SDK2API_IMAGE` to a released digest:

```dotenv
CURSOR_SDK2API_IMAGE=ghcr.io/sunnyender-org/cursor-sdk2api@sha256:<release-digest>
```

The release workflow records the exact digest in `image-digest.txt`. A mutable
tag is convenient for evaluation but is not an immutable production pin.

## Configure channels

In **Channels > Add channel**, create:

1. **Anthropic**: Base URL `http://gateway:8080`, model
   `claude-sonnet-4-6`.
2. **OpenAI**: Base URL `http://gateway:8080`, models
   `grok-4.6,composer-2.5`.

Use the same `GATEWAY_ACCESS_KEY` for both channels. new-api never stores a
Cursor account key. The gateway chooses a compatible account from its
persistent pool for each new session and keeps tool continuation and resume on
that same account.

The JSON files under `integrations/new-api/channel.*.template.json` document
the current API fields. They intentionally contain a non-working placeholder;
replace it only in a local protected copy or use the UI. Do not commit the
rendered channel payload.

new-api clients authenticate with a **new-api user token** at port 3000. They
must never receive a Cursor account key or the gateway-to-new-api key.

Channel availability and billing are separate settings in new-api. Saving the
two channels with placeholder keys proves only the schema. A user request also
needs the model enabled for that user's group and either self-use mode or an
explicit operator-approved model ratio/price.

## Verification layers

Infrastructure-only, no Cursor credential:

```bash
bash integrations/new-api/compose-e2e.sh
```

This builds a clean local gateway image, starts new-api with a fresh SQLite
volume, proves both health endpoints, and proves new-api's Docker network can
reach `gateway:8080`. It does not create a channel or claim a model response.

After channel setup, run the credentialed acceptance matrix through new-api:

```bash
export NEW_API_BASE_URL=http://127.0.0.1:3000
export NEW_API_TOKEN='local-new-api-user-token'
npm run new-api:smoke
```

The script runs three repeatable cases:

1. OpenAI-compatible text.
2. Sonnet 4.6 named tool call plus `tool_result` continuation via Messages.
3. Grok 4.6 xhigh two-tool parallel call plus both tool results.

Model selection is nondeterministic upstream behavior. A run passes only when
the exact required tool batch appears; the script does not downgrade a missed
parallel call into success. Override `TEXT_MODEL`, `SONNET_MODEL`, or
`GROK_MODEL` only with exact IDs returned by the gateway catalog.

## Boundaries and failure semantics

- Placeholder-key channel creation proves configuration shape only.
- Deterministic tests validate request construction and ID preservation, not a
  live Cursor model.
- Credentialed smoke is a dated acceptance for one account, region, model
  catalog, new-api build, and gateway image. It is not a universal guarantee.
- Tool IDs are sufficient for pending continuation; the gateway resolves them
  against its process-local session registry. Keep sticky instance ownership
  and drain before replacing a live gateway.
- Quota/account lookup may degrade to `partial` when the Dashboard control
  plane is unavailable. Inference and usage reporting remain separate.
- Keep `/console/` and new-api administration behind trusted-network controls.

QuantumNous/new-api PR #6869 was closed by a maintainer with “无计划”. This
repository does not reopen it, copy its embedded implementation, or claim that
new-api officially supports a dedicated Cursor channel.
