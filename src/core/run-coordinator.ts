import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "../clock.js";
import type { GatewayConfig } from "../config.js";
import type { AuthContext } from "../auth/credentials.js";
import { digestJson } from "../digest.js";
import {
  invalidRequest,
  sdkFailure,
  sessionConflict,
  sessionLost,
} from "../errors.js";
import type { Logger } from "../log.js";
import type { ParsedMessages, ParsedToolResult } from "../protocols/anthropic/types.js";
import { renderPrompt } from "../protocols/anthropic/parse.js";
import { createAnthropicWriter } from "../protocols/anthropic/writer.js";
import type { SdkDeltaUpdate, SdkRuntime } from "../sdk/port.js";
import { EventPump, type PumpBoundary } from "./event-pump.js";
import { Session } from "./session.js";
import { SessionRegistry } from "./session-registry.js";
import { batchDigest, mapClientTools } from "./tool-bridge.js";
import type { LineageRecord, LineageStore } from "./lineage-store.js";
import type { TurnWriter, TurnWriterFactory } from "./turn-writer.js";

export interface CoordinatorDeps {
  config: GatewayConfig;
  sdk: SdkRuntime;
  registry: SessionRegistry;
  clock: Clock;
  logger: Logger;
  workspaceDir: string;
  lineage?: LineageStore;
  /** Test-only gate between waitForBoundary and state transition. */
  beforeApplyBoundary?: (boundary: PumpBoundary) => Promise<void>;
}

function boundaryIdentity(boundary: PumpBoundary): string {
  if (boundary.type === "error") {
    const message = boundary.error instanceof Error ? boundary.error.message : String(boundary.error);
    return `error:${message}`;
  }
  return `${boundary.type}:${boundary.turn.messageId}`;
}

function sameModelParams(
  left: Array<{ id: string; value: string }>,
  right: Array<{ id: string; value: string }>,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((item, index) => item.id === right[index]?.id && item.value === right[index]?.value);
}

function createDeltaBridge() {
  const early: SdkDeltaUpdate[] = [];
  let pump: EventPump | undefined;
  const ingest = (update: SdkDeltaUpdate) => {
    early.push(update);
    flush();
  };
  const flush = () => {
    if (!pump) return;
    while (early.length > 0) {
      const next = early.shift();
      if (next) pump.ingestDelta(next);
    }
  };
  return {
    ingest,
    attach(next: EventPump) {
      pump = next;
      flush();
    },
  };
}

export class RunCoordinator {
  private readonly pendingRecoveries = new Map<
    string,
    { digest: string; promise: Promise<{ session: Session; pump: EventPump }> }
  >();

  constructor(private readonly deps: CoordinatorDeps) {}

  async handleMessages(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    requestId: string,
    sessionHint?: string,
    writerFactory: TurnWriterFactory = createAnthropicWriter,
  ): Promise<void> {
    this.deps.registry.sweep();
    if (parsed.continuation) {
      await this.continueTurn(req, res, auth, parsed, parsed.continuation, requestId, writerFactory);
      return;
    }
    if (sessionHint) {
      const existing = this.deps.registry.get(sessionHint);
      if (existing) {
        await this.followUp(req, res, auth, parsed, existing, requestId, writerFactory);
        return;
      }
      await this.resumeCompletedLineage(req, res, auth, parsed, sessionHint, requestId, writerFactory);
      return;
    }
    await this.startTurn(req, res, auth, parsed, requestId, writerFactory);
  }

  private async startTurn(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    const session = this.deps.registry.create({
      credentialFingerprint: auth.fingerprint,
      modelId: parsed.model,
      modelParams: parsed.modelParams,
    });
    const customTools = mapClientTools(parsed.tools, session, this.deps.clock, () => undefined);
    try {
      const agent = await this.deps.sdk.createAgent({
        apiKey: auth.cursorApiKey,
        modelId: parsed.model,
        modelParams: session.modelParams,
        workspaceDir: this.deps.workspaceDir,
        clientToolNames: parsed.tools.map((tool) => tool.name),
        customTools,
      });
      session.agent = agent;
      session.sdkAgentId = agent.agentId;
      session.state = "running";
      const prompt = renderPrompt(parsed);
      const deltas = createDeltaBridge();
      const run = await agent.send({
        text: prompt.text,
        images: prompt.images,
        customTools,
        onDelta: deltas.ingest,
      });
      session.run = run;
      const pump = new EventPump(
        session,
        run,
        this.deps.clock,
        this.deps.config.toolBatchSettleMs,
        this.deps.config.firstEventTimeoutMs,
      );
      session.pump = pump;
      deltas.attach(pump);
      pump.ingestEarly(session.earlyCalls.splice(0));
      await this.drive(req, res, session, pump, parsed.stream, requestId, writerFactory);
    } catch (error) {
      if (!res.headersSent && session.state !== "awaiting_tool_results") {
        this.deps.registry.forget(session, "start_failed");
      }
      throw sdkFailure(error);
    }
  }

  private async followUp(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    session: Session,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    this.assertIdentity(session, auth, parsed.model, parsed.modelParams);
    if (!session.agent) {
      throw sessionLost("Session cannot accept a follow-up send");
    }
    if (session.state !== "completed" && session.state !== "creating") {
      throw sessionLost("Session cannot accept a follow-up send");
    }
    this.deps.registry.activateRun(session, "running");
    session.touch(this.deps.clock);
    session.usageConfirmed = false;
    session.hasSemanticOutput = false;
    session.sawToolBatch = false;
    for (const id of session.pending.keys()) {
      this.deps.registry.unindexTool(id);
    }
    session.pending.clear();
    session.earlyCalls.length = 0;
    session.lastResultDigest = undefined;
    session.replay = undefined;
    session.appliedBoundaryId = undefined;
    const customTools = mapClientTools(parsed.tools, session, this.deps.clock, () => undefined);
    const prompt = renderPrompt(parsed);
    const deltas = createDeltaBridge();
    try {
      const run = await session.agent.send({
        text: prompt.text,
        images: prompt.images,
        customTools,
        onDelta: deltas.ingest,
      });
      session.run = run;
      const pump = new EventPump(
        session,
        run,
        this.deps.clock,
        this.deps.config.toolBatchSettleMs,
        this.deps.config.firstEventTimeoutMs,
      );
      session.pump = pump;
      deltas.attach(pump);
      await this.drive(req, res, session, pump, parsed.stream, requestId, writerFactory);
    } catch (error) {
      if (!res.headersSent) this.deps.registry.forget(session, "follow_up_failed");
      throw sdkFailure(error);
    }
  }

  private async continueTurn(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    const ids = results.map((result) => result.toolUseId);
    if (ids.length === 0) throw invalidRequest("tool_result turn is empty");
    const unique = new Set(ids);
    if (unique.size !== ids.length) {
      throw invalidRequest("duplicate tool_use_id in the same tool_result turn");
    }

    const lookup = this.deps.registry.lookupByToolIds(ids);
    if (lookup.mixed) {
      throw sessionConflict("tool_use_id values belong to different sessions");
    }
    if (!lookup.session) {
      const recorded = this.deps.lineage?.findByToolIds(ids);
      if (recorded) {
        await this.resumePendingLineage(
          req,
          res,
          auth,
          parsed,
          results,
          recorded,
          requestId,
          writerFactory,
        );
        return;
      }
    }
    const session = this.deps.registry.requireLive(lookup.session, ids);
    this.assertIdentity(session, auth, parsed.model, parsed.modelParams);

    if (lookup.missing.length > 0) {
      throw invalidRequest(`unknown tool_use_id: ${lookup.missing.join(",")}`);
    }

    const digest = batchDigest(results);
    if (session.lastResultDigest && session.lastResultDigest !== digest) {
      throw sessionConflict("duplicate tool_use_id with a different result digest");
    }
    if (session.lastResultDigest === digest && session.state === "completed" && session.replay) {
      this.writeReplay(res, session, parsed.stream, requestId, writerFactory);
      return;
    }
    if (session.state === "resuming" && session.lastResultDigest === digest && session.pump) {
      await this.drive(req, res, session, session.pump, parsed.stream, requestId, writerFactory);
      return;
    }

    if (session.state !== "awaiting_tool_results" || !session.pump) {
      throw sessionLost("Session is not waiting for tool results");
    }

    const required = new Set(session.unresolvedIds());
    const provided = new Set(ids);
    const missing = [...required].filter((id) => !provided.has(id));
    const unknown = [...provided].filter((id) => !required.has(id));
    if (unknown.length > 0) throw invalidRequest(`unknown tool_use_id: ${unknown.join(",")}`);
    if (missing.length > 0) throw invalidRequest(`missing tool_result for: ${missing.join(",")}`);

    session.pump.beginNextSegment();
    session.lastResultDigest = digest;
    session.state = "resuming";
    session.touch(this.deps.clock);
    // Attach the HTTP sink before resolving deferreds so second-turn deltas are not lost.
    const drive = this.drive(req, res, session, session.pump, parsed.stream, requestId, writerFactory);
    for (const result of results) {
      const pending = session.pending.get(result.toolUseId);
      if (!pending || pending.resolved) {
        throw sessionConflict(`tool_use_id is not resolvable: ${result.toolUseId}`);
      }
      pending.resolved = true;
      pending.resultDigest = digestJson({
        tool_use_id: result.toolUseId,
        content: result.content,
        is_error: result.isError,
      });
      pending.resolve(
        result.isError
          ? { content: [{ type: "text", text: result.content }], isError: true }
          : result.content,
      );
    }
    await drive;
  }

  private async resumePendingLineage(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    record: LineageRecord,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    if (record.state !== "awaiting_tool_results" || !record.sdkAgentId) {
      throw sessionLost("Stored session is not waiting for tool results");
    }
    if (record.credentialFingerprint !== auth.fingerprint || record.modelId !== parsed.model) {
      throw sessionConflict("credential or model does not match the stored session");
    }
    if (parsed.modelParams.length > 0 && !sameModelParams(record.modelParams ?? [], parsed.modelParams)) {
      throw sessionConflict("model parameters do not match the stored session");
    }
    const requestedIds = results.map((result) => result.toolUseId).sort();
    const persistedIds = [...record.pendingToolIds].sort();
    if (JSON.stringify(requestedIds) !== JSON.stringify(persistedIds)) {
      throw sessionConflict("tool results must exactly match the stored pending batch");
    }
    if (!record.pendingCalls || record.pendingCalls.length !== record.pendingToolIds.length) {
      throw sessionLost("Stored pending session predates restart recovery support");
    }
    const requestToolNames = new Set(parsed.tools.map((tool) => tool.name));
    const missingTools = record.pendingCalls
      .map((call) => call.name)
      .filter((name) => !requestToolNames.has(name));
    if (missingTools.length > 0) {
      throw sessionConflict(`tool catalog is missing recovered tools: ${[...new Set(missingTools)].join(",")}`);
    }

    const digest = batchDigest(results);
    const inFlight = this.pendingRecoveries.get(record.sessionId);
    if (inFlight && inFlight.digest !== digest) {
      throw sessionConflict("conflicting concurrent tool results for the stored session");
    }
    let recovery = inFlight;
    if (!recovery) {
      const promise = this.openPendingLineage(auth, parsed, results, record, digest);
      recovery = { digest, promise };
      this.pendingRecoveries.set(record.sessionId, recovery);
      void promise.finally(() => {
        if (this.pendingRecoveries.get(record.sessionId)?.promise === promise) {
          this.pendingRecoveries.delete(record.sessionId);
        }
      }).catch(() => undefined);
    }
    const { session, pump } = await recovery.promise;
    await this.drive(req, res, session, pump, parsed.stream, requestId, writerFactory);
  }

  private async openPendingLineage(
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    record: LineageRecord,
    digest: string,
  ): Promise<{ session: Session; pump: EventPump }> {
    this.deps.registry.assertCanActivateRun({ credentialFingerprint: record.credentialFingerprint });
    const session = new Session({
      sessionId: record.sessionId,
      credentialFingerprint: record.credentialFingerprint,
      modelId: record.modelId,
      modelParams: record.modelParams,
      instanceId: this.deps.registry.instanceId,
      clock: this.deps.clock,
    });
    session.state = "resuming";
    session.lastResultDigest = digest;
    this.deps.registry.adopt(session);

    const customTools = mapClientTools(parsed.tools, session, this.deps.clock, () => undefined);
    const deltas = createDeltaBridge();
    try {
      const agent = await this.deps.sdk.resumeAgent({
        agentId: record.sdkAgentId,
        apiKey: auth.cursorApiKey,
        modelId: parsed.model,
        modelParams: session.modelParams,
        workspaceDir: this.deps.workspaceDir,
        clientToolNames: parsed.tools.map((tool) => tool.name),
        customTools,
      });
      session.agent = agent;
      session.sdkAgentId = record.sdkAgentId;
      const run = await agent.send({
        text: recoveredToolResultPrompt(record, results),
        customTools,
        force: true,
        onDelta: deltas.ingest,
      });
      session.run = run;
      const pump = new EventPump(
        session,
        run,
        this.deps.clock,
        this.deps.config.toolBatchSettleMs,
        this.deps.config.firstEventTimeoutMs,
      );
      session.pump = pump;
      deltas.attach(pump);
      pump.ingestEarly(session.earlyCalls.splice(0));
      for (const id of record.pendingToolIds) this.deps.registry.indexTool(id, session.sessionId);
      return { session, pump };
    } catch (error) {
      this.deps.registry.forget(session, "pending_resume_failed");
      throw sdkFailure(error);
    }
  }

  private async drive(
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
    pump: EventPump,
    stream: boolean,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    const writer = writerFactory({
      res,
      stream,
      requestId,
      session,
      messageId: pump.currentMessageId(),
    });
    pump.attach(writer);
    pump.start();
    this.watchDisconnect(req, res, session, writer);
    try {
      const boundary = await pump.waitForBoundary();
      if (this.deps.beforeApplyBoundary) {
        await this.deps.beforeApplyBoundary(boundary);
      }
      await this.applyBoundary(res, session, boundary, writer);
    } finally {
      pump.detach(writer);
    }
  }

  private async applyBoundary(
    res: ServerResponse,
    session: Session,
    boundary: PumpBoundary,
    writer: TurnWriter,
  ): Promise<void> {
    const boundaryId = boundaryIdentity(boundary);
    const first = session.appliedBoundaryId !== boundaryId;
    if (first) {
      session.appliedBoundaryId = boundaryId;
      if (boundary.type === "error") {
        session.state = "failed";
      } else {
        session.replay = {
          digest: session.lastResultDigest ?? `turn:${boundary.turn.messageId}`,
          turn: boundary.turn,
          createdAt: this.deps.clock.now(),
        };
        if (boundary.type === "tools") {
          session.state = "awaiting_tool_results";
          session.lastResultDigest = undefined;
          session.touch(this.deps.clock);
          for (const call of session.pending.values()) {
            this.deps.registry.indexTool(call.toolUseId, session.sessionId);
          }
          this.deps.logger.info(
            {
              session_id: session.sessionId,
              pending_count: session.unresolvedIds().length,
              stop_reason: "tool_use",
            },
            "awaiting tool results",
          );
        } else {
          session.state = "completed";
          session.touch(this.deps.clock);
          this.deps.logger.info(
            {
              session_id: session.sessionId,
              stop_reason: "end_turn",
              usage_status: boundary.turn.usage.usage_status,
            },
            "turn completed",
          );
        }
      }
      this.persistLineage(session);
    }
    if (boundary.type === "error") {
      throw boundary.error;
    }
    try {
      writer.finish(boundary.turn);
    } catch {
      // client may already be gone
    }
  }

  private async resumeCompletedLineage(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    sessionHint: string,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    const record = this.deps.lineage?.get(sessionHint);
    if (!record || this.deps.clock.now() >= record.expiresAt) {
      throw sessionLost("No recoverable completed session for this id");
    }
    if (record.credentialFingerprint !== auth.fingerprint || record.modelId !== parsed.model) {
      throw sessionConflict("credential or model does not match the stored session");
    }
    if (parsed.modelParams.length > 0 && !sameModelParams(record.modelParams ?? [], parsed.modelParams)) {
      throw sessionConflict("model parameters do not match the stored session");
    }
    if (record.state !== "completed" || !record.sdkAgentId) {
      throw sessionLost("Session is not a completed Agent lineage");
    }
    this.deps.registry.assertCanActivateRun({
      credentialFingerprint: record.credentialFingerprint,
    });
    const session = new Session({
      sessionId: record.sessionId,
      credentialFingerprint: record.credentialFingerprint,
      modelId: record.modelId,
      modelParams: record.modelParams,
      instanceId: this.deps.registry.instanceId,
      clock: this.deps.clock,
    });
    this.deps.registry.adopt(session);
    try {
      const customTools = mapClientTools(parsed.tools, session, this.deps.clock, () => undefined);
      const agent = await this.deps.sdk.resumeAgent({
        agentId: record.sdkAgentId,
        apiKey: auth.cursorApiKey,
        modelId: parsed.model,
        modelParams: session.modelParams,
        workspaceDir: this.deps.workspaceDir,
        clientToolNames: parsed.tools.map((tool) => tool.name),
        customTools,
      });
      session.agent = agent;
      session.sdkAgentId = record.sdkAgentId;
      await this.followUp(req, res, auth, parsed, session, requestId, writerFactory);
    } catch (error) {
      if (!res.headersSent) {
        this.deps.registry.forget(session, "resume_failed");
      }
      throw sdkFailure(error);
    }
  }

  private persistLineage(session: Session): void {
    if (!this.deps.lineage) return;
    const persistable =
      session.state === "completed" || session.state === "awaiting_tool_results" || session.state === "failed";
    if (!persistable) return;
    const sdkAgentId = session.sdkAgentId ?? session.agent?.agentId;
    if (!sdkAgentId) return;
    const ttl =
      session.state === "failed" ? this.deps.config.replayTtlMs : this.deps.config.sessionTtlMs;
    const record: LineageRecord = {
      version: 1,
      sessionId: session.sessionId,
      sdkAgentId,
      credentialFingerprint: session.credentialFingerprint,
      modelId: session.modelId,
      ...(session.modelParams.length > 0 ? { modelParams: session.modelParams } : {}),
      state: session.state as LineageRecord["state"],
      pendingToolIds:
        session.state === "awaiting_tool_results" ? [...session.pending.keys()] : [],
      ...(session.state === "awaiting_tool_results"
        ? {
            pendingCalls: [...session.pending.values()].map((call) => ({
              toolUseId: call.toolUseId,
              name: call.name,
            })),
          }
        : {}),
      createdAt: session.createdAt,
      lastActivityAt: session.lastActivityAt,
      expiresAt: session.lastActivityAt + ttl,
    };
    // Digest only — never persist assistant/tool payloads. In-process
    // duplicate-same still replays from memory; after restart it is session_lost.
    if (session.lastResultDigest) record.lastResultDigest = session.lastResultDigest;
    try {
      this.deps.lineage.put(record);
    } catch {
      this.deps.logger.warn({ session_id: session.sessionId }, "lineage persist failed");
    }
  }

  private writeReplay(
    res: ServerResponse,
    session: Session,
    stream: boolean,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): void {
    const turn = session.replay?.turn;
    if (!turn) throw sessionLost("Replay record is missing");
    const writer = writerFactory({
      res,
      stream,
      requestId,
      session,
      messageId: turn.messageId,
    });
    writer.finish(turn, { replayed: true });
  }

  private assertIdentity(
    session: Session,
    auth: AuthContext,
    model: string,
    requestedParams: Array<{ id: string; value: string }>,
  ): void {
    if (session.credentialFingerprint !== auth.fingerprint) {
      throw sessionConflict("credential identity does not match the session owner");
    }
    if (session.modelId !== model) {
      throw sessionConflict("model does not match the session owner");
    }
    if (requestedParams.length > 0 && !sameModelParams(session.modelParams, requestedParams)) {
      throw sessionConflict("model parameters do not match the session owner");
    }
    if (session.instanceId !== this.deps.registry.instanceId) {
      throw sessionLost("session instance generation mismatch");
    }
  }

  private watchDisconnect(
    req: IncomingMessage,
    res: ServerResponse,
    session: Session,
    writer: TurnWriter,
  ): void {
    const onClientGone = () => {
      session.pump?.detach(writer);
      if (res.writableEnded) return;
      if (!session.hasSemanticOutput && (session.state === "running" || session.state === "creating")) {
        void this.cancel(session, "client_closed_before_output");
      }
    };
    req.once("aborted", onClientGone);
    req.socket?.once("close", onClientGone);
  }

  private async cancel(session: Session, reason: string): Promise<void> {
    try {
      await session.run?.cancel();
    } catch {
      // ignore cancel races
    }
    this.deps.registry.forget(session, reason);
  }

  async drain(deadlineMs: number): Promise<void> {
    this.deps.registry.beginShutdown();
    const deadline = this.deps.clock.now() + deadlineMs;
    while (this.deps.registry.activeCount() > 0 && this.deps.clock.now() < deadline) {
      await this.deps.clock.sleep(25);
      this.deps.registry.sweep();
    }
    if (this.deps.registry.activeCount() > 0) {
      for (const session of this.deps.registry.sessions.values()) {
        this.deps.registry.forget(session, "drain_deadline");
      }
    }
  }
}

function recoveredToolResultPrompt(record: LineageRecord, results: ParsedToolResult[]): string {
  const names = new Map((record.pendingCalls ?? []).map((call) => [call.toolUseId, call.name]));
  const lines = results.map(
    (result) =>
      `TOOL_RESULT tool_use_id=${result.toolUseId} tool=${names.get(result.toolUseId) ?? "unknown"} is_error=${result.isError} content=${JSON.stringify(result.content)}`,
  );
  return [
    "HOST_RECOVERY:",
    "The host process restarted while your external tool calls were waiting for results.",
    "Continue the same task from the persisted agent checkpoint using these exact results.",
    "Do not repeat the completed tool calls. You may call other tools only if the task still requires them.",
    ...lines,
  ].join("\n");
}
