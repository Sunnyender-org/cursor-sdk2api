# Architecture

## Ownership

One live SDK Run has one owner process and one event-pump consumer.

```
HTTP /v1/messages | /v1/chat/completions | /v1/responses
  -> protocol parse (Chat/Responses convert to canonical ParsedMessages)
  -> CursorAgentTurn (protocol-neutral ordinary-turn IR)
  -> RunCoordinator
       -> SdkRunDriver (the only create/resume/send/pump wiring)
       -> tool_result: existing ATTACH / lineage resume / transcript recovery
       -> exact successor: Agent.resume/send(current turn text+images only)
       -> unknown/fork/compact: cold rebuild with full transcript fallback
       -> SessionRegistry (fingerprint, model, tool_use_id, TTL)
       -> ToolBridge (request tools -> local.customTools)
       -> EventPump (single run.stream() consumer for tool/status/terminal)
       -> protocol writer seam (Anthropic SSE, OpenAI Chat data chunks, or Responses events)
       -> SdkRuntime (injected; production adapter wraps @cursor/sdk)
```

`/v1/chat/completions` and `/v1/responses` do not own a second session or continuation engine. They reuse the same RunCoordinator, pending-tool Map, replay, and identity binding. Only the request parser and HTTP writer differ.

Responses continuation is not `previous_response_id` reconstruction. The parser accepts a full Responses transcript and treats only the latest trailing `function_call_output` batch as the continuation. Completed follow-up still uses `x-cursor-session-id` exactly as Messages/Chat. `previous_response_id`, `store=true`, background, conversation, and hosted built-in tools fail closed. The known optional `reasoning.encrypted_content` include is accepted but omitted; unknown expansions fail closed.

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

SDK Agent history lives in credential-partitioned `$STATE_DIR/sdk-store/<fingerprint>` directories via the official `JsonlLocalAgentStore`. Each credential also receives a private empty-workspace partition. Gateway lineage (`$STATE_DIR/lineage`) keeps only resume metadata: session id, SDK agent id, credential fingerprint, model and explicit model parameters, canonical session-policy and executable-tool-catalog digests, state, pending tool ids, optional result digest, and timestamps. Lineage schema v2 fails closed and quarantines older/incomplete records instead of silently resuming them.

Ordinary multi-turn requests without `x-cursor-session-id` use a credential-free journal of digests (`STATE_DIR/ordinary-turns.json`). Exact linear successors reuse the same Agent and `send()` only the latest user text/images. Forks, compact/missing anchors, model/effort/tool-catalog mismatches, and credential rotation cold-rebuild. Identical request digests replay in-process; after a process restart they fail closed because assistant bodies are not persisted.

Completed follow-up with `x-cursor-session-id` looks up lineage, checks credential/model/session policy, then `Agent.resume` + `send` on that same store. `ORDINARY_TURN_COORDINATOR=0` restores the previous flatten-every-turn path. Pending callback Promises are not serialized; the lineage stores only tool ids, names, and policy digests. After owner death, an exact credential/model/tool-catalog/tool-id batch resumes the persisted Agent and sends a synthetic host-recovery turn with `local.force=true`. Concurrent duplicate-same recovery is singleflight. Assistant replay bodies are not persisted, so duplicate-same after a later process restart still has no persisted response body.

When no exact live or persisted owner can attach, tool continuation may cold-branch only from a self-contained transcript. The latest assistant tool batch must exactly match the submitted result ids and every call must exist in the request catalog. Historical completed calls are indexed by stable tool-name/input signature; if the recovered Harness requests one again, the gateway returns the recorded result internally rather than exposing the same side effect to the client twice. Identical recovery requests are singleflight and replayable for the normal replay TTL.

Before any semantic response is emitted, a generic SDK authentication-session failure is checked with an official `Cursor.me` credential probe. A still-valid key receives one same-credential Agent rebuild; an invalid key fails immediately. Managed mode may then try one different compatible account for authentication, permission, rate-limit, timeout, or upstream failures. No retry occurs after response headers/deltas begin.

## Injection

Production uses `createCursorRuntime({ stateDir })` and passes the matching credential-partitioned `JsonlLocalAgentStore` and workspace to every `Agent.create` and `Agent.resume`. Tests inject `FakeSdk`. The HTTP layer never imports `@cursor/sdk` directly except through that adapter.

Gateway lineage is a separate JSON file store under `STATE_DIR/lineage`. It recovers completed Agent ids and exact pending-tool metadata; pending callback Promises themselves are never serialized.
