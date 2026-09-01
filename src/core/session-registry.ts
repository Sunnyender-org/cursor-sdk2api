import type { Clock } from "../clock.js";
import { rateLimited, sessionConflict, sessionLost } from "../errors.js";
import { Session, type SessionState } from "./session.js";
import type { RuntimeProfile } from "./runtime-profile.js";

const ACTIVE_RUN_STATES: ReadonlySet<SessionState> = new Set(["creating", "running", "resuming"]);

export interface RegistryLimits {
  globalActiveRuns: number;
  perCredentialActiveRuns: number;
  maxAwaitingSessions: number;
  sessionTtlMs: number;
  replayTtlMs: number;
  runDeadlineMs: number;
}

export class SessionRegistry {
  readonly sessions = new Map<string, Session>();
  readonly toolIndex = new Map<string, string>();
  readonly expiredToolIds = new Map<string, number>();
  shuttingDown = false;

  constructor(
    private readonly clock: Clock,
    readonly instanceId: string,
    private readonly limits: RegistryLimits,
  ) {}

  create(input: {
    credentialFingerprint: string;
    modelId: string;
    modelParams?: Array<{ id: string; value: string }>;
    sessionPolicyFingerprint: string;
    executableToolCatalogFingerprint: string;
    runtimeProfile?: RuntimeProfile;
  }): Session {
    this.assertCanActivateRun({
      credentialFingerprint: input.credentialFingerprint,
      runtimeProfile: input.runtimeProfile,
    });
    const awaiting = [...this.sessions.values()].filter((session) => session.state === "awaiting_tool_results");
    if (awaiting.length >= this.limits.maxAwaitingSessions) {
      throw rateLimited("Awaiting session limit reached");
    }
    const session = new Session({
      ...input,
      instanceId: this.instanceId,
      clock: this.clock,
    });
    this.sessions.set(session.sessionId, session);
    return session;
  }

  /**
   * Capacity for a new SDK run (create, completed follow-up, persisted resume).
   * Counts creating/running/resuming, excluding the session about to activate.
   * Awaiting tool_result continuation does not use this path.
   */
  assertCanActivateRun(input: {
    credentialFingerprint: string;
    runtimeProfile?: RuntimeProfile;
    excludeSessionId?: string;
  }): void {
    if (this.shuttingDown) {
      throw rateLimited("Gateway is draining; new runs are not accepted");
    }
    this.sweep();
    const active = [...this.sessions.values()].filter(
      (session) => ACTIVE_RUN_STATES.has(session.state) && session.sessionId !== input.excludeSessionId,
    );
    if (active.length >= this.limits.globalActiveRuns) {
      throw rateLimited("Global active run limit reached");
    }
    const perCred = active.filter(
      (session) =>
        session.credentialFingerprint === input.credentialFingerprint &&
        session.runtimeProfile === (input.runtimeProfile ?? session.runtimeProfile),
    );
    if (perCred.length >= this.limits.perCredentialActiveRuns) {
      throw rateLimited("Per-credential active run limit reached");
    }
  }

  activateRun(session: Session, next: "creating" | "running" | "resuming"): void {
    this.assertCanActivateRun({
      credentialFingerprint: session.credentialFingerprint,
      runtimeProfile: session.runtimeProfile,
      excludeSessionId: session.sessionId,
    });
    session.state = next;
  }

  indexTool(toolUseId: string, sessionId: string): void {
    this.toolIndex.set(toolUseId, sessionId);
  }

  unindexTool(toolUseId: string): void {
    this.toolIndex.delete(toolUseId);
  }

  lookupByToolIds(ids: string[]): { session?: Session; missing: string[]; mixed: boolean } {
    const sessionIds = new Set<string>();
    const missing: string[] = [];
    for (const id of ids) {
      const sessionId = this.toolIndex.get(id);
      if (!sessionId) {
        missing.push(id);
        continue;
      }
      sessionIds.add(sessionId);
    }
    if (sessionIds.size > 1) return { mixed: true, missing };
    const sessionId = [...sessionIds][0];
    return {
      session: sessionId ? this.sessions.get(sessionId) : undefined,
      missing,
      mixed: false,
    };
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  adopt(session: Session): void {
    const existing = this.sessions.get(session.sessionId);
    if (existing && existing !== session) {
      throw sessionConflict("session id is already bound to a different in-memory session");
    }
    this.sessions.set(session.sessionId, session);
  }

  forget(session: Session, reason: string): void {
    // In-memory only. Completed lineage files stay until their own TTL so a
    // later process can Agent.resume. Pending records also stay until TTL for
    // exact persisted recovery; a complete transcript may cold-branch later.
    const expireAt = this.clock.now() + this.limits.replayTtlMs;
    for (const [id, ownerSessionId] of this.toolIndex) {
      if (ownerSessionId !== session.sessionId) continue;
      this.toolIndex.delete(id);
      this.expiredToolIds.set(id, expireAt);
    }
    void session.run?.cancel().catch(() => undefined);
    for (const pending of session.pending.values()) {
      if (pending.resolved) continue;
      pending.resolved = true;
      pending.reject(Object.assign(new Error(reason), { name: "SessionClosedError" }));
    }
    try {
      session.agent?.close();
    } catch {
      // best-effort
    }
    session.markClosed(reason);
    this.sessions.delete(session.sessionId);
  }

  sweep(): void {
    const now = this.clock.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.createdAt > this.limits.runDeadlineMs) {
        this.forget(session, "run_deadline");
        continue;
      }
      if (session.state === "awaiting_tool_results" && now - session.lastActivityAt > this.limits.sessionTtlMs) {
        this.forget(session, "ttl");
        continue;
      }
      if (
        (session.state === "completed" || session.state === "failed" || session.state === "cancelled") &&
        session.replay &&
        now - session.replay.createdAt > this.limits.replayTtlMs
      ) {
        if (session.retainOrdinaryAgent && now < session.retainUntil) {
          continue;
        }
        this.forget(session, "replay_ttl");
      }
    }
    for (const [id, expireAt] of this.expiredToolIds) {
      if (now >= expireAt) this.expiredToolIds.delete(id);
    }
  }

  lostIfExpired(ids: string[]): boolean {
    return ids.some((id) => this.expiredToolIds.has(id));
  }

  expiredIndexSize(): number {
    return this.expiredToolIds.size;
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((session) =>
      ["creating", "running", "resuming", "awaiting_tool_results"].includes(session.state),
    ).length;
  }

  activeRunCountForCredential(credentialFingerprint: string): number {
    return [...this.sessions.values()].filter(
      (session) =>
        session.credentialFingerprint === credentialFingerprint && ACTIVE_RUN_STATES.has(session.state),
    ).length;
  }

  beginShutdown(): void {
    this.shuttingDown = true;
  }

  requireLive(session: Session | undefined, ids: string[]): Session {
    if (!session) {
      throw sessionLost(
        this.lostIfExpired(ids) || ids.length > 0
          ? "No live in-process SDK session owns these tool_use_id values"
          : "Tool continuation session is gone",
      );
    }
    if (session.instanceId !== this.instanceId) {
      throw sessionLost("Session belongs to a different instance generation");
    }
    if (session.state === "closed" || session.state === "failed" || session.state === "cancelled") {
      throw sessionLost("Session is no longer live");
    }
    return session;
  }
}
