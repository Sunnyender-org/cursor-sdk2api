import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Clock } from "../clock.js";
import type { GatewayConfig } from "../config.js";
import type { AuthContext } from "../auth/credentials.js";
import { digestJson } from "../digest.js";
import {
  GatewayError,
  invalidRequest,
  sdkFailure,
  sessionConflict,
  sessionLost,
} from "../errors.js";
import type { Logger } from "../log.js";
import type { ParsedMessages, ParsedToolResult } from "../protocols/anthropic/types.js";
import { renderPrompt } from "../protocols/anthropic/parse.js";
import { createAnthropicWriter } from "../protocols/anthropic/writer.js";
import type { SdkRuntime } from "../sdk/port.js";
import {
  currentTurnSendPayload,
  cursorAgentTurnFromParsed,
  cursorAgentTurnLineageKey,
  digestAssistantAnchor,
  nextCursorAgentTurnLineageKey,
  ordinaryReplayKey,
  type CursorAgentTurn,
} from "./cursor-agent-turn.js";
import { EventPump, type PumpBoundary } from "./event-pump.js";
import { decideOrdinaryTurn } from "./ordinary-turn.js";
import type { OrdinaryTurnJournal, OrdinaryTurnRecord } from "./ordinary-turn-journal.js";
import { Session } from "./session.js";
import { SessionRegistry } from "./session-registry.js";
import { SdkRunDriver } from "./sdk-run-driver.js";
import { batchDigest, mapClientTools } from "./tool-bridge.js";
import { buildTranscriptRecovery } from "./transcript-recovery.js";
import type { LineageRecord, LineageStore } from "./lineage-store.js";
import type { TurnWriter, TurnWriterFactory, TurnWriterSession } from "./turn-writer.js";

interface OrdinaryReplayEntry {
  turn: NonNullable<Session["replay"]>["turn"];
  writerSession: TurnWriterSession;
  expiresAt: number;
}

export interface CoordinatorDeps {
  config: GatewayConfig;
  sdk: SdkRuntime;
  registry: SessionRegistry;
  clock: Clock;
  logger: Logger;
  workspaceDir: string;
  lineage?: LineageStore;
  ordinaryJournal?: OrdinaryTurnJournal;
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

export class RunCoordinator {
  private readonly pendingRecoveries = new Map<
    string,
    { digest: string; promise: Promise<{ session: Session; pump: EventPump }> }
  >();
  private readonly transcriptRecoveries = new Map<
    string,
    { expiresAt: number; promise: Promise<{ session: Session; pump: EventPump }> }
  >();
  private readonly ordinaryInflight = new Map<string, Promise<void>>();
  private readonly ordinaryReplay = new Map<string, OrdinaryReplayEntry>();
  private readonly sdkRunDriver: SdkRunDriver;

  constructor(private readonly deps: CoordinatorDeps) {
    this.sdkRunDriver = new SdkRunDriver({
      sdk: deps.sdk,
      clock: deps.clock,
      toolBatchSettleMs: deps.config.toolBatchSettleMs,
      firstEventTimeoutMs: deps.config.firstEventTimeoutMs,
    });
    this.deps.ordinaryJournal?.setOnExpire((record) => {
      const session = this.findSessionByAgentId(record.agentId);
      if (session) this.deps.registry.forget(session, "ordinary_turn_expired");
    });
  }

  ordinaryReplayCount(): number {
    return this.ordinaryReplay.size;
  }

  sweepOrdinaryState(): void {
    this.deps.ordinaryJournal?.sweepExpired();
    const now = this.deps.clock.now();
    for (const [key, replay] of this.ordinaryReplay) {
      if (now >= replay.expiresAt) this.ordinaryReplay.delete(key);
    }
  }

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
    this.sweepOrdinaryState();
    if (parsed.continuation) {
      await this.continueTurn(req, res, auth, parsed, parsed.continuation, requestId, writerFactory);
      return;
    }
    const turn = cursorAgentTurnFromParsed(parsed, { tenantScope: auth.fingerprint });
    if (this.deps.config.ordinaryTurnCoordinator && this.deps.ordinaryJournal) {
      const handled = await this.handleOrdinaryTurn(
        req,
        res,
        auth,
        parsed,
        turn,
        requestId,
        writerFactory,
        sessionHint,
      );
      if (handled) return;
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
    await this.startTurn(
      req,
      res,
      auth,
      parsed,
      requestId,
      writerFactory,
      this.deps.config.ordinaryTurnCoordinator ? turn : undefined,
    );
  }

  private async handleOrdinaryTurn(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    turn: CursorAgentTurn,
    requestId: string,
    writerFactory: TurnWriterFactory,
    sessionHint?: string,
  ): Promise<boolean> {
    const journal = this.deps.ordinaryJournal;
    if (!journal) return false;
    const key = ordinaryReplayKey(turn);
    const inflight = this.ordinaryInflight.get(key);
    if (inflight) {
      await inflight;
      const cached = this.ordinaryReplay.get(key);
      if (!cached) {
        throw sessionLost("completed Cursor ordinary turn cannot be replayed without its in-memory response");
      }
      this.writeReplay(res, cached, parsed.stream, requestId, writerFactory);
      return true;
    }

    const decision = decideOrdinaryTurn({
      turn,
      journal,
      inflight: new Set(this.ordinaryInflight.keys()),
      now: this.deps.clock.now(),
      enabled: true,
      hasReplay: this.ordinaryReplay.has(key),
    });

    if (decision.action === "tool_continuation") return false;
    if (decision.action === "replay") {
      const cached = this.ordinaryReplay.get(key);
      if (!cached) {
        throw sessionLost("completed Cursor ordinary turn cannot be replayed without its in-memory response");
      }
      this.writeReplay(res, cached, parsed.stream, requestId, writerFactory);
      return true;
    }
    if (decision.action === "fail_closed") {
      throw sessionLost("completed Cursor ordinary turn cannot be replayed without its in-memory response");
    }
    if (decision.action === "singleflight") {
      const pending = this.ordinaryInflight.get(key);
      if (pending) {
        await pending;
        const cached = this.ordinaryReplay.get(key);
        if (!cached) {
          throw sessionLost("completed Cursor ordinary turn cannot be replayed without its in-memory response");
        }
        this.writeReplay(res, cached, parsed.stream, requestId, writerFactory);
        return true;
      }
    }
    if (decision.action === "rebuild" && sessionHint) {
      return false;
    }

    if (decision.action === "resume") {
      await this.claimOrdinaryTurn(req, res, auth, parsed, turn, requestId, writerFactory, {
        mode: "resume",
        parent: decision.record,
      });
      return true;
    }

    await this.claimOrdinaryTurn(req, res, auth, parsed, turn, requestId, writerFactory, {
      mode: "rebuild",
      reason: decision.action === "rebuild" ? decision.reason : "unknown_or_first",
    });
    return true;
  }

  private async claimOrdinaryTurn(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    turn: CursorAgentTurn,
    requestId: string,
    writerFactory: TurnWriterFactory,
    claim: { mode: "resume"; parent: OrdinaryTurnRecord } | { mode: "rebuild"; reason: string },
  ): Promise<void> {
    const journal = this.deps.ordinaryJournal;
    if (!journal) {
      await this.startTurn(req, res, auth, parsed, requestId, writerFactory, turn);
      return;
    }
    const lineageKey = cursorAgentTurnLineageKey(turn);
    const key = ordinaryReplayKey(turn);
    const existing = this.ordinaryInflight.get(key);
    if (existing) {
      await existing;
      const cached = this.ordinaryReplay.get(key);
      if (!cached) {
        throw sessionLost("completed Cursor ordinary turn cannot be replayed without its in-memory response");
      }
      this.writeReplay(res, cached, parsed.stream, requestId, writerFactory);
      return;
    }

    let resolveInflight!: () => void;
    let rejectInflight!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveInflight = resolve;
      rejectInflight = reject;
    });
    this.ordinaryInflight.set(key, promise);
    void promise.catch(() => undefined);

    const claimedAt = this.deps.clock.now();
    const runningRecord: OrdinaryTurnRecord = {
      lineageKey,
      requestDigest: turn.lineage.requestDigest,
      nextLineageKey: "",
      tenantScope: turn.tenantScope,
      route: turn.route,
      channelId: turn.channelId,
      effectiveModel: turn.effectiveModel,
      parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
      turnIndex: turn.lineage.turnIndex,
      toolCatalogDigest: turn.lineage.toolCatalogDigest,
      assistantAnchor: "",
      agentId: claim.mode === "resume" ? claim.parent.agentId : "",
      credentialFingerprint: auth.fingerprint,
      state: "running",
      createdAt: claimedAt,
      updatedAt: claimedAt,
      expiresAt: claimedAt + this.deps.config.sessionTtlMs,
    };
    journal.upsert(runningRecord);

    try {
      await this.executeOrdinaryClaim(
        req,
        res,
        auth,
        parsed,
        turn,
        requestId,
        writerFactory,
        claim,
      );
      resolveInflight();
    } catch (error) {
      journal.remove(lineageKey, turn.lineage.requestDigest);
      rejectInflight(error);
      throw error;
    } finally {
      this.ordinaryInflight.delete(key);
    }
  }

  private async executeOrdinaryClaim(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    turn: CursorAgentTurn,
    requestId: string,
    writerFactory: TurnWriterFactory,
    claim: { mode: "resume"; parent: OrdinaryTurnRecord } | { mode: "rebuild"; reason: string },
  ): Promise<void> {
    let resume = claim.mode === "resume";
    if (resume && claim.mode === "resume") {
      const live = this.findSessionByAgentId(claim.parent.agentId);
      if (
        live?.agent &&
        live.state === "completed" &&
        live.credentialFingerprint === auth.fingerprint &&
        live.modelId === parsed.model &&
        claim.parent.credentialFingerprint === auth.fingerprint
      ) {
        live.ordinaryTurn = turn;
        this.traceOrdinary({
          action: "resume",
          reason: "exact_successor_live",
          model: parsed.model,
          send_chars: currentTurnSendPayload(turn).text.length,
        });
        await this.followUp(
          req,
          res,
          auth,
          parsed,
          live,
          requestId,
          writerFactory,
          currentTurnSendPayload(turn),
        );
        return;
      }
      if (live?.agent && live.credentialFingerprint !== auth.fingerprint) {
        resume = false;
      } else if (
        claim.parent.agentId &&
        claim.parent.credentialFingerprint === auth.fingerprint
      ) {
        await this.resumeOrdinaryAgent(
          req,
          res,
          auth,
          parsed,
          turn,
          claim.parent,
          requestId,
          writerFactory,
        );
        return;
      } else {
        resume = false;
      }
    }

    const rebuildReason = claim.mode === "rebuild" ? claim.reason : "resume_fallback";
    this.traceOrdinary({
      action: "rebuild",
      reason: rebuildReason,
      model: parsed.model,
      send_chars: renderPrompt(parsed).text.length,
    });
    await this.startTurn(req, res, auth, parsed, requestId, writerFactory, turn);
  }

  private async resumeOrdinaryAgent(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    turn: CursorAgentTurn,
    parent: OrdinaryTurnRecord,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    this.deps.registry.assertCanActivateRun({
      credentialFingerprint: auth.fingerprint,
    });
    const session = this.deps.registry.create({
      credentialFingerprint: auth.fingerprint,
      modelId: parsed.model,
      modelParams: parsed.modelParams,
    });
    session.ordinaryTurn = turn;
    try {
      const customTools = mapClientTools(parsed.tools, session, this.deps.clock, () => undefined);
      const agent = await this.deps.sdk.resumeAgent({
        agentId: parent.agentId,
        apiKey: auth.cursorApiKey,
        modelId: parsed.model,
        modelParams: session.modelParams,
        workspaceDir: this.deps.workspaceDir,
        clientToolNames: parsed.tools.map((tool) => tool.name),
        customTools,
      });
      session.agent = agent;
      session.sdkAgentId = parent.agentId;
      this.traceOrdinary({
        action: "resume",
        reason: "exact_successor_store",
        model: parsed.model,
        send_chars: currentTurnSendPayload(turn).text.length,
      });
      await this.followUp(
        req,
        res,
        auth,
        parsed,
        session,
        requestId,
        writerFactory,
        currentTurnSendPayload(turn),
      );
    } catch (error) {
      if (!res.headersSent) this.deps.registry.forget(session, "ordinary_resume_failed");
      throw sdkFailure(error);
    }
  }

  private traceOrdinary(event: {
    action: "resume" | "rebuild";
    reason: string;
    model: string;
    send_chars: number;
  }): void {
    this.deps.logger.info(
      {
        model: event.model,
        action: event.action,
        reason: event.reason,
        send_chars: event.send_chars,
      },
      "ordinary turn",
    );
    try {
      appendFileSync(
        join(this.deps.config.stateDir, "ordinary-trace.jsonl"),
        `${JSON.stringify({ t: this.deps.clock.now(), ...event })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
    } catch {
      // diagnostic only
    }
  }

  private findSessionByAgentId(agentId: string): Session | undefined {
    if (!agentId) return undefined;
    for (const session of this.deps.registry.sessions.values()) {
      if (session.sdkAgentId === agentId || session.agent?.agentId === agentId) return session;
    }
    return undefined;
  }

  private rememberOrdinaryCompletion(session: Session): void {
    const turn = session.ordinaryTurn;
    const journal = this.deps.ordinaryJournal;
    if (!turn || !journal || !session.replay) return;
    if (session.state !== "completed" && session.state !== "awaiting_tool_results") return;
    const assistantAnchor = digestAssistantAnchor(session.replay.turn.blocks);
    const now = this.deps.clock.now();
    const completed: OrdinaryTurnRecord = {
      lineageKey: cursorAgentTurnLineageKey(turn),
      requestDigest: turn.lineage.requestDigest,
      nextLineageKey: nextCursorAgentTurnLineageKey(turn, assistantAnchor),
      tenantScope: turn.tenantScope,
      route: turn.route,
      channelId: turn.channelId,
      effectiveModel: turn.effectiveModel,
      parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
      turnIndex: turn.lineage.turnIndex,
      toolCatalogDigest: turn.lineage.toolCatalogDigest,
      assistantAnchor,
      agentId: session.sdkAgentId ?? session.agent?.agentId ?? "",
      credentialFingerprint: session.credentialFingerprint,
      state: "completed",
      createdAt: session.createdAt,
      updatedAt: now,
      expiresAt: now + this.deps.config.sessionTtlMs,
    };
    journal.upsert(completed);
    this.ordinaryReplay.set(ordinaryReplayKey(turn), {
      turn: structuredClone(session.replay.turn),
      writerSession: {
        sessionId: session.sessionId,
        modelId: session.modelId,
        createdAt: session.createdAt,
      },
      expiresAt: completed.expiresAt,
    });
    if (session.state === "completed") {
      session.retainOrdinaryAgent = true;
      session.retainUntil = completed.expiresAt;
    }
  }

  private async startTurn(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    requestId: string,
    writerFactory: TurnWriterFactory,
    ordinaryTurn?: CursorAgentTurn,
    sendOverride?: { text: string; images: Array<{ data: string; mimeType: string }> },
  ): Promise<void> {
    const session = this.deps.registry.create({
      credentialFingerprint: auth.fingerprint,
      modelId: parsed.model,
      modelParams: parsed.modelParams,
    });
    if (ordinaryTurn) session.ordinaryTurn = ordinaryTurn;
    try {
      const prompt = sendOverride ?? renderPrompt(parsed);
      const pump = await this.sdkRunDriver.start({
        session,
        tools: parsed.tools,
        agent: { type: "create", apiKey: auth.cursorApiKey, workspaceDir: this.deps.workspaceDir },
        send: prompt,
      });
      session.state = "running";
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
    sendOverride?: { text: string; images: Array<{ data: string; mimeType: string }> },
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
    const prompt = sendOverride ?? renderPrompt(parsed);
    try {
      const pump = await this.sdkRunDriver.start({
        session,
        tools: parsed.tools,
        agent: { type: "existing", agent: session.agent },
        send: prompt,
      });
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
    let routingError: GatewayError | undefined;
    if (lookup.mixed) {
      routingError = sessionConflict("tool_use_id values belong to different sessions");
    } else if (lookup.session && lookup.missing.length > 0) {
      routingError = invalidRequest(`unknown tool_use_id: ${lookup.missing.join(",")}`);
    }
    if (!lookup.mixed && lookup.session && lookup.missing.length === 0) {
      try {
        await this.continueLiveSession(req, res, auth, parsed, results, lookup.session, requestId, writerFactory);
        return;
      } catch (error) {
        if (!isTranscriptRecoverableRoutingError(error)) throw error;
        routingError = error;
      }
    }
    if (!lookup.mixed && !lookup.session) {
      const recorded = this.deps.lineage?.findByToolIds(ids);
      if (recorded) {
        try {
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
        } catch (error) {
          if (!isTranscriptRecoverableRoutingError(error)) throw error;
          routingError = error;
        }
      }
    }
    await this.recoverFromTranscript(req, res, auth, parsed, results, requestId, writerFactory, routingError);
  }

  private async continueLiveSession(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    session: Session,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): Promise<void> {
    const ids = results.map((result) => result.toolUseId);
    this.deps.registry.requireLive(session, ids);
    this.assertIdentity(session, auth, parsed.model, parsed.modelParams);

    const digest = batchDigest(results);
    if (session.lastResultDigest && session.lastResultDigest !== digest) {
      throw sessionConflict("duplicate tool_use_id with a different result digest");
    }
    if (session.lastResultDigest === digest && session.state === "completed" && session.replay) {
      this.writeReplay(res, { turn: session.replay.turn, writerSession: session }, parsed.stream, requestId, writerFactory);
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

  private async recoverFromTranscript(
    req: IncomingMessage,
    res: ServerResponse,
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    requestId: string,
    writerFactory: TurnWriterFactory,
    routingError?: GatewayError,
  ): Promise<void> {
    let recovery: ReturnType<typeof buildTranscriptRecovery>;
    try {
      recovery = buildTranscriptRecovery(parsed, results);
    } catch (error) {
      if (routingError) throw routingError;
      throw error;
    }
    const now = this.deps.clock.now();
    for (const [key, entry] of this.transcriptRecoveries) {
      if (now >= entry.expiresAt) this.transcriptRecoveries.delete(key);
    }
    const key = `${auth.fingerprint}:${recovery.digest}`;
    let entry = this.transcriptRecoveries.get(key);
    if (!entry) {
      const promise = this.openTranscriptRecovery(auth, parsed, results, recovery);
      entry = {
        expiresAt: now + this.deps.config.replayTtlMs,
        promise,
      };
      this.transcriptRecoveries.set(key, entry);
      void promise.catch(() => {
        if (this.transcriptRecoveries.get(key)?.promise === promise) {
          this.transcriptRecoveries.delete(key);
        }
      });
    }
    const { session, pump } = await entry.promise;
    await this.drive(req, res, session, pump, parsed.stream, requestId, writerFactory);
  }

  private async openTranscriptRecovery(
    auth: AuthContext,
    parsed: ParsedMessages,
    results: ParsedToolResult[],
    recovery: ReturnType<typeof buildTranscriptRecovery>,
  ): Promise<{ session: Session; pump: EventPump }> {
    const session = this.deps.registry.create({
      credentialFingerprint: auth.fingerprint,
      modelId: parsed.model,
      modelParams: parsed.modelParams,
    });
    session.lastResultDigest = batchDigest(results);
    try {
      const pump = await this.sdkRunDriver.start({
        session,
        tools: parsed.tools,
        agent: { type: "create", apiKey: auth.cursorApiKey, workspaceDir: this.deps.workspaceDir },
        send: { text: recovery.prompt, images: parsed.images },
        completedResults: recovery.completedResults,
      });
      session.state = "running";
      return { session, pump };
    } catch (error) {
      this.deps.registry.forget(session, "transcript_recovery_failed");
      throw sdkFailure(error);
    }
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

    try {
      const pump = await this.sdkRunDriver.start({
        session,
        tools: parsed.tools,
        agent: {
          type: "resume",
          agentId: record.sdkAgentId,
          apiKey: auth.cursorApiKey,
          workspaceDir: this.deps.workspaceDir,
        },
        send: { text: recoveredToolResultPrompt(record, results), force: true },
      });
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
          this.rememberOrdinaryCompletion(session);
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
          this.rememberOrdinaryCompletion(session);
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
    // duplicate-same still replays from memory. A later self-contained retry
    // uses transcript recovery instead of a persisted assistant response body.
    if (session.lastResultDigest) record.lastResultDigest = session.lastResultDigest;
    try {
      this.deps.lineage.put(record);
    } catch {
      this.deps.logger.warn({ session_id: session.sessionId }, "lineage persist failed");
    }
  }

  private writeReplay(
    res: ServerResponse,
    replay: { turn: NonNullable<Session["replay"]>["turn"]; writerSession: TurnWriterSession },
    stream: boolean,
    requestId: string,
    writerFactory: TurnWriterFactory,
  ): void {
    const turn = replay.turn;
    const writer = writerFactory({
      res,
      stream,
      requestId,
      session: replay.writerSession,
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

function isTranscriptRecoverableRoutingError(error: unknown): error is GatewayError {
  return error instanceof GatewayError && (
    error.code === "cursor_session_lost" ||
    error.code === "cursor_session_conflict" ||
    error.code === "invalid_request"
  );
}
