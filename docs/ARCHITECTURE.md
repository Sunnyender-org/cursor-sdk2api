# Architecture

## Ownership

One live SDK Run has one owner process and one event-pump consumer.

```
HTTP /v1/messages | /v1/chat/completions | /v1/responses
  -> protocol parse (Chat/Responses convert to canonical ParsedMessages)
  -> RunCoordinator
       -> SessionRegistry (fingerprint, model, tool_use_id, TTL)
       -> ToolBridge (request tools -> local.customTools)
       -> EventPump (single run.stream() consumer for tool/status/terminal)
       -> protocol writer seam (Anthropic SSE, OpenAI Chat data chunks, or Responses events)
       -> SdkRuntime (injected; production adapter wraps @cursor/sdk)
```

`/v1/chat/completions` and `/v1/responses` do not own a second session or continuation engine. They reuse the same RunCoordinator, pending-tool Map, replay, and identity binding. Only the request parser and HTTP writer differ.

Responses continuation is not `previous_response_id` reconstruction. Pending tool turns resume when the latest input items are only `function_call_output` and `call_id` matches the live `tool_use_id`. Completed follow-up still uses `x-cursor-session-id` exactly as Messages/Chat. `previous_response_id`, `store=true`, background, conversation, include expansions, and hosted built-in tools fail closed.

Text/thinking streaming uses official `SendOptions.onDelta` (`text-delta` / `thinking-delta`). Early deltas that arrive before `send()` resolves are buffered, then ingested into the pump. When onDelta is active, `run.stream()` assistant/thinking snapshots are not forwarded again.

`customTool.execute` is the authority for client-visible `tool_use`. SDK `tool_call` stream events are diagnostic and are de-duplicated by call id.

## Network transport

Direct local SDK runs retain the official HTTP/2 transport. Node does not apply
standard proxy environment variables to that transport automatically. When an
HTTP(S) proxy is configured, startup switches Agent traffic to HTTP/1.1 and
installs `proxy-agent` as the Node HTTP/HTTPS global agent. SDK fetch traffic
(`models.list` and account lookup) separately uses Undici's
`EnvHttpProxyAgent`; both paths honor `NO_PROXY`. SOCKS/PAC is rejected instead
of allowing one SDK path to bypass the proxy. The gateway never stores or
returns proxy URLs; health reports only the active Agent and fetch modes.

## State machine

`Creating -> Running -> AwaitingToolResults -> Resuming -> Running -> ... -> Completed`

Any active state can go to `Failed` or `Cancelled`, then `Closed`.

Pending calls live in a `Map<toolUseId, PendingCall>`. There is no single-pending shortcut.

## Restart

SDK Agent history lives in credential-partitioned `$STATE_DIR/sdk-store/<fingerprint>` directories via the official `JsonlLocalAgentStore`. Each credential also receives a private empty-workspace partition. Gateway lineage (`$STATE_DIR/lineage`) keeps only resume metadata: session id, SDK agent id, credential fingerprint, model and explicit model parameters, state, pending tool ids, optional result digest, and timestamps.

Completed follow-up with `x-cursor-session-id` looks up lineage, checks fingerprint/model, then `Agent.resume` + `send` on that same store. Pending tool callbacks are ordinary in-memory Promises and are not serialized. After owner death they stay `409 cursor_session_lost` until the pending record expires. Assistant replay bodies are not persisted, so duplicate-same after restart is also `session_lost`.

## Injection

Production uses `createCursorRuntime({ stateDir })` and passes the matching credential-partitioned `JsonlLocalAgentStore` and workspace to every `Agent.create` and `Agent.resume`. Tests inject `FakeSdk`. The HTTP layer never imports `@cursor/sdk` directly except through that adapter.

Gateway lineage is a separate JSON file store under `STATE_DIR/lineage`. It recovers **completed** Agent ids only. Pending tool callbacks are not serialized.
