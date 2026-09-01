/**
 * SQLite WAL runtime ledger for Agent / Run / Interaction / provider receipt.
 *
 * Coordinator wiring (next round): RunCoordinator may hold a RuntimeLedger and
 * call claimRun / persistObserveOffset / recordInteractionDigests /
 * finalizeRunWithReceipt. This module does not register disconnect observers
 * or persist from the coordinator yet. A no-op-ready surface is the class
 * methods below; wiring them is intentionally out of scope.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import type { Clock } from "../clock.js";
import { ensurePrivateDir } from "./lineage-store.js";
import { RuntimeLedgerError, mapSqliteError } from "./runtime-ledger/errors.js";
import {
  copyToQuarantineDir,
  mapLineageRunState,
  mapOrdinaryRunState,
  requireScanClock,
  scanLineageDir,
  scanOrdinaryTurnJournal,
} from "./runtime-ledger/legacy.js";
import {
  assertNoForbiddenFields,
  assertSafeStoredText,
  assertSha256Digest,
  parseLedgerUsage,
  serializeLedgerUsage,
} from "./runtime-ledger/payload.js";
import { RUNTIME_LEDGER_SCHEMA_SQL } from "./runtime-ledger/schema.js";
import {
  RUNTIME_DB_FILENAME,
  RUNTIME_LEDGER_BUSY_TIMEOUT_MS,
  RUNTIME_LEDGER_SCHEMA_VERSION,
  RUNTIME_QUARANTINE_DIR,
  TERMINAL_RUN_STATES,
  runtimeLedgerV2Enabled,
  type AgentState,
  type ClaimRunInput,
  type ClaimedRun,
  type FinalizeRunInput,
  type InteractionState,
  type LedgerUsage,
  type LegacyImportReport,
  type ProviderReceiptRow,
  type QuarantineRow,
  type RecordInteractionInput,
  type ReceiptState,
  type RunState,
  type RuntimeAgentRow,
  type RuntimeInteractionRow,
  type RuntimeProfile,
  type RuntimeRunRow,
  type UpsertAgentInput,
  isAgentState,
  isInteractionState,
  isReceiptState,
  isRunState,
  isRuntimeProfile,
} from "./runtime-ledger/types.js";

export { RuntimeLedgerError } from "./runtime-ledger/errors.js";
export {
  RUNTIME_DB_FILENAME,
  RUNTIME_LEDGER_BUSY_TIMEOUT_MS,
  RUNTIME_LEDGER_SCHEMA_VERSION,
  RUNTIME_QUARANTINE_DIR,
  runtimeLedgerV2Enabled,
} from "./runtime-ledger/types.js";
export type {
  AgentState,
  ClaimRunInput,
  ClaimedRun,
  FinalizeRunInput,
  InteractionState,
  LedgerUsage,
  LegacyImportReport,
  ProviderReceiptRow,
  QuarantineReason,
  QuarantineRow,
  ReceiptState,
  RecordInteractionInput,
  RunState,
  RuntimeAgentRow,
  RuntimeInteractionRow,
  RuntimeProfile,
  RuntimeRunRow,
  UpsertAgentInput,
} from "./runtime-ledger/types.js";

export interface RuntimeLedgerOpenOptions {
  clock: Clock;
  /**
   * Scan lineage JSON and the ordinary-turn journal into SQLite.
   * Defaults to RUNTIME_LEDGER_V2 semantics (on unless set to 0/false/off).
   * The ledger can still be constructed when that flag is off.
   */
  migrateLegacy?: boolean;
}

export class RuntimeLedger {
  readonly stateDir: string;
  readonly dbPath: string;
  readonly quarantineDir: string;
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private closed = false;

  private constructor(stateDir: string, clock: Clock, db: DatabaseSync) {
    this.stateDir = stateDir;
    this.dbPath = join(stateDir, RUNTIME_DB_FILENAME);
    this.quarantineDir = join(stateDir, RUNTIME_QUARANTINE_DIR);
    this.clock = clock;
    this.db = db;
  }

  static open(stateDir: string, options: RuntimeLedgerOpenOptions): RuntimeLedger {
    if (!options?.clock) {
      throw new RuntimeLedgerError("invalid", "RuntimeLedger.open requires { clock }");
    }
    const clock = requireScanClock(options.clock);
    ensurePrivateDir(stateDir);
    const dbPath = join(stateDir, RUNTIME_DB_FILENAME);
    const db = openRuntimeDatabase(dbPath);
    const ledger = new RuntimeLedger(stateDir, clock, db);
    ledger.migrateSchema();
    chmodOwnerOnly(dbPath);
    chmodOwnerOnly(`${dbPath}-wal`);
    chmodOwnerOnly(`${dbPath}-shm`);
    ensurePrivateDir(ledger.quarantineDir);
    const migrateLegacy = options.migrateLegacy ?? runtimeLedgerV2Enabled();
    if (migrateLegacy) ledger.importLegacyLineage();
    return ledger;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  fileMode(): number | undefined {
    try {
      return statSync(this.dbPath).mode & 0o777;
    } catch {
      return undefined;
    }
  }

  upsertAgent(input: UpsertAgentInput): RuntimeAgentRow {
    this.assertOpen();
    assertNoForbiddenFields(input, "agent");
    const credentialFingerprint = requireNonEmpty(input.credentialFingerprint, "credentialFingerprint");
    const sdkAgentId = requireNonEmpty(input.sdkAgentId, "sdkAgentId");
    const policyDigest = requireHexDigest(input.policyDigest, "policyDigest");
    const runtimeProfile = requireProfile(input.runtimeProfile);
    const state: AgentState = input.state ?? "active";
    if (!isAgentState(state)) throw new RuntimeLedgerError("invalid", "unsupported agent state");
    if (input.model != null) requireNonEmpty(input.model, "model");
    const now = this.clock.now();
    const id = input.id ?? `agt_${randomUUID()}`;
    return this.transact(() => {
      const existing = this.db
        .prepare(
          `SELECT * FROM runtime_agents
           WHERE credential_fingerprint = ? AND runtime_profile = ? AND sdk_agent_id = ?`,
        )
        .get(credentialFingerprint, runtimeProfile, sdkAgentId);
      if (existing) {
        this.db
          .prepare(
            `UPDATE runtime_agents
             SET model = ?, policy_digest = ?, state = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(input.model ?? null, policyDigest, state, now, asString(existing.id));
        return this.mustAgent(asString(existing.id));
      }
      this.db
        .prepare(
          `INSERT INTO runtime_agents (
             id, credential_fingerprint, runtime_profile, sdk_agent_id, model,
             policy_digest, generation, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          id,
          credentialFingerprint,
          runtimeProfile,
          sdkAgentId,
          input.model ?? null,
          policyDigest,
          state,
          now,
          now,
        );
      return this.mustAgent(id);
    });
  }

  getAgent(id: string): RuntimeAgentRow | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM runtime_agents WHERE id = ?").get(id);
    return row ? mapAgent(row) : undefined;
  }

  /**
   * Fence a logical request to at most one owner. A second claim with the same
   * generation returns the existing row (reconnect, not a second Send).
   * A later owner may raise generation; a stale generation is a conflict.
   */
  claimRun(input: ClaimRunInput): ClaimedRun {
    this.assertOpen();
    assertNoForbiddenFields(input, "run");
    const logicalKey = requireNonEmpty(input.logicalKey, "logicalKey");
    const agentId = requireNonEmpty(input.agentId, "agentId");
    const runtimeProfile = requireProfile(input.runtimeProfile);
    const generation = requireGeneration(input.generation);
    if (input.sdkRunId != null) requireNonEmpty(input.sdkRunId, "sdkRunId");
    return this.transact(() => {
      const agent = this.mustAgent(agentId);
      if (agent.runtimeProfile !== runtimeProfile) {
        throw new RuntimeLedgerError("conflict", "run profile does not match agent");
      }
      if (generation < agent.generation) {
        throw new RuntimeLedgerError("conflict", "stale generation cannot claim this agent");
      }
      const existing = this.findRunRowByLogicalKey(logicalKey);
      if (existing) {
        if (generation < existing.generation) {
          throw new RuntimeLedgerError("conflict", "stale generation cannot claim this run");
        }
        if (existing.agentId !== agentId) {
          throw new RuntimeLedgerError("conflict", "logical key is owned by another agent");
        }
        if (generation > existing.generation) {
          const bumped = this.db
            .prepare(
              `UPDATE runtime_runs
               SET generation = ?, sdk_run_id = COALESCE(?, sdk_run_id)
               WHERE id = ? AND generation = ?`,
            )
            .run(generation, input.sdkRunId ?? null, existing.id, existing.generation);
          if (numberOf(bumped.changes) !== 1) {
            throw new RuntimeLedgerError("conflict", "stale generation cannot claim this run");
          }
          this.bumpAgentGeneration(agentId, generation);
          return { outcome: "existing" as const, run: this.mustRun(existing.id) };
        }
        return { outcome: "existing", run: existing };
      }
      const id = input.id ?? `run_${randomUUID()}`;
      this.db
        .prepare(
          `INSERT INTO runtime_runs (
             id, agent_id, logical_key, runtime_profile, sdk_run_id, state,
             generation, started_at
           ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
        )
        .run(id, agentId, logicalKey, runtimeProfile, input.sdkRunId ?? null, generation, this.clock.now());
      this.bumpAgentGeneration(agentId, generation);
      return { outcome: "created" as const, run: this.mustRun(id) };
    });
  }

  claimLogicalRun(
    logicalKey: string,
    generation: number,
    input: Omit<ClaimRunInput, "logicalKey" | "generation">,
  ): ClaimedRun {
    return this.claimRun({ ...input, logicalKey, generation });
  }

  persistObserveOffset(runId: string, observeOffset: string, generation: number): RuntimeRunRow {
    this.assertOpen();
    const id = requireNonEmpty(runId, "runId");
    const offset = requireNonEmpty(observeOffset, "observeOffset");
    assertSafeStoredText(offset, "observe_offset");
    const gen = requireGeneration(generation);
    return this.transact(() => {
      this.requireGenerationOwner(id, gen);
      this.db.prepare("UPDATE runtime_runs SET observe_offset = ? WHERE id = ? AND generation = ?").run(offset, id, gen);
      return this.mustRun(id);
    });
  }

  recordInteractionDigests(input: RecordInteractionInput): RuntimeInteractionRow {
    this.assertOpen();
    assertNoForbiddenFields(input, "interaction");
    if ("args" in input || "result" in input || "input" in input) {
      throw new RuntimeLedgerError("forbidden_content", "interactions store digests only");
    }
    const runId = requireNonEmpty(input.runId, "runId");
    const toolCallId = requireNonEmpty(input.toolCallId, "toolCallId");
    const toolName = requireNonEmpty(input.toolName, "toolName");
    assertSafeStoredText(toolName, "tool_name");
    assertSha256Digest(input.argsDigest, "argsDigest");
    assertSha256Digest(input.resultDigest, "resultDigest");
    if (!isInteractionState(input.state)) {
      throw new RuntimeLedgerError("invalid", "unsupported interaction state");
    }
    const gen = requireGeneration(input.generation);
    const now = this.clock.now();
    return this.transact(() => {
      this.requireGenerationOwner(runId, gen);
      const deliveredAt = input.state === "pending" ? null : now;
      const acknowledgedAt = input.state === "acknowledged" ? now : null;
      this.db
        .prepare(
          `INSERT INTO runtime_interactions (
             run_id, tool_call_id, tool_name, args_digest, result_digest, state,
             delivered_at, acknowledged_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(run_id, tool_call_id) DO UPDATE SET
             tool_name = excluded.tool_name,
             args_digest = COALESCE(excluded.args_digest, runtime_interactions.args_digest),
             result_digest = COALESCE(excluded.result_digest, runtime_interactions.result_digest),
             state = excluded.state,
             delivered_at = COALESCE(excluded.delivered_at, runtime_interactions.delivered_at),
             acknowledged_at = COALESCE(excluded.acknowledged_at, runtime_interactions.acknowledged_at)`,
        )
        .run(
          runId,
          toolCallId,
          toolName,
          input.argsDigest ?? null,
          input.resultDigest ?? null,
          input.state,
          deliveredAt,
          acknowledgedAt,
        );
      return this.mustInteraction(runId, toolCallId);
    });
  }

  /**
   * Persist usage, terminal snapshot, and receipt in one transaction.
   * Reconnect / Observe / SubmitResult must call this rather than inserting a
   * second receipt. runtime_lost keeps a provisional receipt and refuses to
   * fabricate final token usage.
   */
  finalizeRunWithReceipt(input: FinalizeRunInput): { run: RuntimeRunRow; receipt: ProviderReceiptRow } {
    this.assertOpen();
    assertNoForbiddenFields(input, "finalize");
    const runId = requireNonEmpty(input.runId, "runId");
    const receiptId = requireNonEmpty(input.receiptId, "receiptId");
    const terminalDigest = requireHexDigest(input.terminalDigest, "terminalDigest");
    const gen = requireGeneration(input.generation);
    if (input.state !== "finished" && input.state !== "error" && input.state !== "runtime_lost") {
      throw new RuntimeLedgerError("invalid", "finalize requires a terminal run state");
    }
    if (input.state === "runtime_lost" && input.usage) {
      throw new RuntimeLedgerError("invalid", "runtime_lost must not fabricate final token usage");
    }
    if (input.state === "finished" && !input.usage) {
      throw new RuntimeLedgerError("invalid", "finished runs require numeric usage");
    }
    const usageJson = input.usage ? serializeLedgerUsage(input.usage) : null;
    const receiptState: ReceiptState = input.state === "finished" ? "finalized" : "provisional";
    const now = this.clock.now();
    return this.transact(() => {
      const run = this.requireGenerationOwner(runId, gen);
      if (run.receiptId && run.receiptId !== receiptId) {
        throw new RuntimeLedgerError("conflict", "run already has a different receipt");
      }
      const existingReceipt = this.getReceiptRow(receiptId) ?? this.getReceiptByRunId(runId);
      if (existingReceipt) {
        if (existingReceipt.runId !== runId || existingReceipt.receiptId !== receiptId) {
          throw new RuntimeLedgerError("conflict", "receipt id is already bound to another run");
        }
        return { run: this.mustRun(runId), receipt: existingReceipt };
      }
      this.db
        .prepare(
          `UPDATE runtime_runs
           SET state = ?, usage_json = ?, receipt_id = ?, terminal_digest = ?, terminal_at = ?
           WHERE id = ? AND generation = ?`,
        )
        .run(input.state, usageJson, receiptId, terminalDigest, now, runId, gen);
      this.db
        .prepare(
          `INSERT INTO provider_receipts (receipt_id, run_id, state, usage_json, finalized_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(receiptId, runId, receiptState, usageJson, receiptState === "finalized" ? now : null);
      return { run: this.mustRun(runId), receipt: this.mustReceipt(receiptId) };
    });
  }

  getRun(id: string): RuntimeRunRow | undefined {
    this.assertOpen();
    const row = this.db.prepare("SELECT * FROM runtime_runs WHERE id = ?").get(id);
    return row ? mapRun(row) : undefined;
  }

  getRunByLogicalKey(logicalKey: string): RuntimeRunRow | undefined {
    this.assertOpen();
    return this.findRunRowByLogicalKey(logicalKey);
  }

  getReceipt(receiptId: string): ProviderReceiptRow | undefined {
    this.assertOpen();
    return this.getReceiptRow(receiptId);
  }

  getReceiptByRunId(runId: string): ProviderReceiptRow | undefined {
    this.assertOpen();
    return this.getReceiptByRunIdPrivate(runId);
  }

  listQuarantine(): QuarantineRow[] {
    this.assertOpen();
    return this.db.prepare("SELECT * FROM runtime_quarantine ORDER BY quarantined_at ASC").all().map(mapQuarantine);
  }

  /**
   * Read-only scan of lineage v2 JSON and the ordinary-turn journal.
   * Compatible records are inserted; incomplete/expired/policy-mismatch rows
   * go to quarantine. Original JSON files are never deleted.
   */
  importLegacyLineage(): LegacyImportReport {
    this.assertOpen();
    const report: LegacyImportReport = {
      importedAgents: 0,
      importedRuns: 0,
      importedInteractions: 0,
      quarantined: 0,
    };
    const lineageItems = scanLineageDir(join(this.stateDir, "lineage"), this.clock);
    const ordinaryItems = scanOrdinaryTurnJournal(join(this.stateDir, "ordinary-turns.json"), this.clock);
    this.transact(() => {
      for (const item of lineageItems) {
        if (item.kind === "quarantine") {
          this.persistQuarantine(item);
          report.quarantined += 1;
          continue;
        }
        try {
          const imported = this.importCompatibleLineage(item.record);
          report.importedAgents += imported.agent ? 1 : 0;
          report.importedRuns += imported.run ? 1 : 0;
          report.importedInteractions += imported.interactions;
        } catch (error) {
          if (!(error instanceof PolicyMismatchSignal)) throw error;
          this.persistQuarantine({
            source: "lineage",
            sourcePath: item.sourcePath,
            reason: "policy_mismatch",
            logicalKey: item.record.sessionId,
            copyFile: false,
          });
          report.quarantined += 1;
        }
      }
      for (const item of ordinaryItems) {
        if (item.kind === "quarantine") {
          this.persistQuarantine(item);
          report.quarantined += 1;
          continue;
        }
        try {
          const imported = this.importCompatibleOrdinary(item.record);
          report.importedAgents += imported.agent ? 1 : 0;
          report.importedRuns += imported.run ? 1 : 0;
        } catch (error) {
          if (!(error instanceof PolicyMismatchSignal)) throw error;
          this.persistQuarantine({
            source: "ordinary-turn",
            sourcePath: item.sourcePath,
            reason: "policy_mismatch",
            logicalKey: item.record.lineageKey,
            copyFile: false,
          });
          report.quarantined += 1;
        }
      }
    });
    return report;
  }

  private importCompatibleLineage(record: {
    sessionId: string;
    sdkAgentId: string;
    credentialFingerprint: string;
    modelId: string;
    sessionPolicyFingerprint: string;
    state: "completed" | "awaiting_tool_results" | "failed";
    pendingCalls: Array<{ toolUseId: string; name: string }>;
    createdAt: number;
    lastActivityAt: number;
  }): { agent: boolean; run: boolean; interactions: number } {
    const existingRun = this.findRunRowByLogicalKey(record.sessionId);
    if (existingRun) return { agent: false, run: false, interactions: 0 };
    const agent = this.insertImportedAgent({
      credentialFingerprint: record.credentialFingerprint,
      sdkAgentId: record.sdkAgentId,
      model: record.modelId,
      policyDigest: record.sessionPolicyFingerprint,
      createdAt: record.createdAt,
      updatedAt: record.lastActivityAt,
    });
    const runId = `run_${randomUUID()}`;
    const runState = mapLineageRunState(record.state);
    const terminalAt = TERMINAL_RUN_STATES.has(runState) ? record.lastActivityAt : null;
    this.db
      .prepare(
        `INSERT INTO runtime_runs (
           id, agent_id, logical_key, runtime_profile, state, generation, started_at, terminal_at
         ) VALUES (?, ?, ?, 'sdk', ?, 0, ?, ?)`,
      )
      .run(runId, agent.id, record.sessionId, runState, record.createdAt, terminalAt);
    let interactions = 0;
    for (const call of record.pendingCalls) {
      this.db
        .prepare(
          `INSERT INTO runtime_interactions (
             run_id, tool_call_id, tool_name, state
           ) VALUES (?, ?, ?, 'pending')`,
        )
        .run(runId, call.toolUseId, call.name);
      interactions += 1;
    }
    return { agent: agent.created, run: true, interactions };
  }

  private importCompatibleOrdinary(record: {
    lineageKey: string;
    sdkAgentId: string;
    credentialFingerprint: string;
    modelId: string;
    sessionPolicyFingerprint: string;
    state: "running" | "completed";
    createdAt: number;
    updatedAt: number;
  }): { agent: boolean; run: boolean } {
    if (this.findRunRowByLogicalKey(record.lineageKey)) return { agent: false, run: false };
    const agent = this.insertImportedAgent({
      credentialFingerprint: record.credentialFingerprint,
      sdkAgentId: record.sdkAgentId,
      model: record.modelId,
      policyDigest: record.sessionPolicyFingerprint,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
    const runState = mapOrdinaryRunState(record.state);
    const terminalAt = TERMINAL_RUN_STATES.has(runState) ? record.updatedAt : null;
    this.db
      .prepare(
        `INSERT INTO runtime_runs (
           id, agent_id, logical_key, runtime_profile, state, generation, started_at, terminal_at
         ) VALUES (?, ?, ?, 'sdk', ?, 0, ?, ?)`,
      )
      .run(`run_${randomUUID()}`, agent.id, record.lineageKey, runState, record.createdAt, terminalAt);
    return { agent: agent.created, run: true };
  }

  private insertImportedAgent(input: {
    credentialFingerprint: string;
    sdkAgentId: string;
    model: string;
    policyDigest: string;
    createdAt: number;
    updatedAt: number;
  }): { id: string; created: boolean } {
    const existing = this.db
      .prepare(
        `SELECT id, policy_digest FROM runtime_agents
         WHERE credential_fingerprint = ? AND runtime_profile = 'sdk' AND sdk_agent_id = ?`,
      )
      .get(input.credentialFingerprint, input.sdkAgentId);
    if (existing) {
      if (asString(existing.policy_digest) !== input.policyDigest) {
        throw new PolicyMismatchSignal();
      }
      return { id: asString(existing.id), created: false };
    }
    const id = `agt_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO runtime_agents (
           id, credential_fingerprint, runtime_profile, sdk_agent_id, model,
           policy_digest, generation, state, created_at, updated_at
         ) VALUES (?, ?, 'sdk', ?, ?, ?, 0, 'active', ?, ?)`,
      )
      .run(
        id,
        input.credentialFingerprint,
        input.sdkAgentId,
        input.model,
        input.policyDigest,
        input.createdAt,
        input.updatedAt,
      );
    return { id, created: true };
  }

  private persistQuarantine(item: {
    source: "lineage" | "ordinary-turn";
    sourcePath: string;
    reason: QuarantineRow["reason"];
    logicalKey?: string;
    copyFile: boolean;
  }): void {
    if (item.copyFile && existsSync(item.sourcePath)) {
      copyToQuarantineDir(item.sourcePath, this.quarantineDir, this.clock);
    }
    this.db
      .prepare(
        `INSERT INTO runtime_quarantine (id, source, source_path, reason, logical_key, quarantined_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `qrn_${randomUUID()}`,
        item.source,
        item.sourcePath,
        item.reason,
        item.logicalKey ?? null,
        this.clock.now(),
      );
  }

  private migrateSchema(): void {
    this.db.exec(RUNTIME_LEDGER_SCHEMA_SQL);
    const version = this.db.prepare("SELECT value FROM runtime_ledger_meta WHERE key = 'schema_version'").get();
    if (!version) {
      this.db
        .prepare("INSERT INTO runtime_ledger_meta (key, value) VALUES ('schema_version', ?)")
        .run(String(RUNTIME_LEDGER_SCHEMA_VERSION));
      return;
    }
    const current = Number.parseInt(asString(version.value), 10);
    if (current !== RUNTIME_LEDGER_SCHEMA_VERSION) {
      throw new RuntimeLedgerError("invalid", `unsupported runtime ledger schema version ${current}`);
    }
  }

  private transact<T>(fn: () => T): T {
    this.assertOpen();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      mapSqliteError(error);
    }
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
      } catch {
        // original error is authoritative
      }
      if (error instanceof PolicyMismatchSignal) {
        throw new RuntimeLedgerError("conflict", "legacy record policy digest does not match imported agent");
      }
      mapSqliteError(error);
    }
  }

  private requireGenerationOwner(runId: string, generation: number): RuntimeRunRow {
    const run = this.getRun(runId);
    if (!run) throw new RuntimeLedgerError("not_found", "run not found");
    if (run.generation !== generation) {
      throw new RuntimeLedgerError("conflict", "stale generation cannot mutate this run");
    }
    return run;
  }

  private bumpAgentGeneration(agentId: string, generation: number): void {
    this.db
      .prepare(
        `UPDATE runtime_agents
         SET generation = ?, updated_at = ?
         WHERE id = ? AND generation < ?`,
      )
      .run(generation, this.clock.now(), agentId, generation);
  }

  private findRunRowByLogicalKey(logicalKey: string): RuntimeRunRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM runtime_runs WHERE logical_key = ? ORDER BY started_at DESC LIMIT 1")
      .get(logicalKey);
    return row ? mapRun(row) : undefined;
  }

  private getReceiptRow(receiptId: string): ProviderReceiptRow | undefined {
    const row = this.db.prepare("SELECT * FROM provider_receipts WHERE receipt_id = ?").get(receiptId);
    return row ? mapReceipt(row) : undefined;
  }

  private getReceiptByRunIdPrivate(runId: string): ProviderReceiptRow | undefined {
    const row = this.db.prepare("SELECT * FROM provider_receipts WHERE run_id = ?").get(runId);
    return row ? mapReceipt(row) : undefined;
  }

  private mustAgent(id: string): RuntimeAgentRow {
    const agent = this.getAgent(id);
    if (!agent) throw new RuntimeLedgerError("not_found", "agent not found");
    return agent;
  }

  private mustRun(id: string): RuntimeRunRow {
    const run = this.getRun(id);
    if (!run) throw new RuntimeLedgerError("not_found", "run not found");
    return run;
  }

  private mustReceipt(receiptId: string): ProviderReceiptRow {
    const receipt = this.getReceiptRow(receiptId);
    if (!receipt) throw new RuntimeLedgerError("not_found", "receipt not found");
    return receipt;
  }

  private mustInteraction(runId: string, toolCallId: string): RuntimeInteractionRow {
    const row = this.db
      .prepare("SELECT * FROM runtime_interactions WHERE run_id = ? AND tool_call_id = ?")
      .get(runId, toolCallId);
    if (!row) throw new RuntimeLedgerError("not_found", "interaction not found");
    return mapInteraction(row);
  }

  private assertOpen(): void {
    if (this.closed || !this.db.isOpen) {
      throw new RuntimeLedgerError("invalid", "runtime ledger is closed");
    }
  }
}

class PolicyMismatchSignal extends Error {
  constructor() {
    super("policy mismatch");
    this.name = "PolicyMismatchSignal";
  }
}

function openRuntimeDatabase(dbPath: string): DatabaseSync {
  let DatabaseCtor: typeof DatabaseSync;
  try {
    DatabaseCtor = DatabaseSync;
  } catch (error) {
    throw new RuntimeLedgerError(
      "invalid",
      "node:sqlite is required for RuntimeLedger; refusing to fall back to another engine",
      { cause: error },
    );
  }
  const db = new DatabaseCtor(dbPath, {
    timeout: RUNTIME_LEDGER_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${RUNTIME_LEDGER_BUSY_TIMEOUT_MS}`);
  return db;
}

function chmodOwnerOnly(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems that ignore mode
  }
}

function requireNonEmpty(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeLedgerError("invalid", `${label} is required`);
  }
  return value;
}

function requireHexDigest(value: string, label: string): string {
  const digest = requireNonEmpty(value, label);
  assertSha256Digest(digest, label);
  return digest;
}

function requireProfile(value: RuntimeProfile): RuntimeProfile {
  if (!isRuntimeProfile(value)) throw new RuntimeLedgerError("invalid", "runtime profile must be sdk or sand");
  return value;
}

function requireGeneration(value: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RuntimeLedgerError("invalid", "generation must be a non-negative integer");
  }
  return value;
}

function asString(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") throw new RuntimeLedgerError("invalid", "expected text column");
  return value;
}

function asNullableString(value: SQLOutputValue | undefined): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== "string") throw new RuntimeLedgerError("invalid", "expected text column");
  return value;
}

function asInt(value: SQLOutputValue | undefined): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new RuntimeLedgerError("invalid", "expected integer column");
}

function asNullableInt(value: SQLOutputValue | undefined): number | undefined {
  if (value == null) return undefined;
  return asInt(value);
}

function numberOf(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function mapAgent(row: Record<string, SQLOutputValue>): RuntimeAgentRow {
  const runtimeProfile = asString(row.runtime_profile);
  const state = asString(row.state);
  if (!isRuntimeProfile(runtimeProfile) || !isAgentState(state)) {
    throw new RuntimeLedgerError("invalid", "corrupt agent row");
  }
  return {
    id: asString(row.id),
    credentialFingerprint: asString(row.credential_fingerprint),
    runtimeProfile,
    sdkAgentId: asString(row.sdk_agent_id),
    model: asNullableString(row.model),
    policyDigest: asString(row.policy_digest),
    generation: asInt(row.generation),
    state,
    createdAt: asInt(row.created_at),
    updatedAt: asInt(row.updated_at),
  };
}

function mapRun(row: Record<string, SQLOutputValue>): RuntimeRunRow {
  const runtimeProfile = asString(row.runtime_profile);
  const state = asString(row.state);
  if (!isRuntimeProfile(runtimeProfile) || !isRunState(state)) {
    throw new RuntimeLedgerError("invalid", "corrupt run row");
  }
  return {
    id: asString(row.id),
    agentId: asString(row.agent_id),
    logicalKey: asString(row.logical_key),
    runtimeProfile,
    sdkRunId: asNullableString(row.sdk_run_id),
    state,
    observeOffset: asNullableString(row.observe_offset),
    usage: parseNullableUsage(asNullableString(row.usage_json)),
    receiptId: asNullableString(row.receipt_id),
    terminalDigest: asNullableString(row.terminal_digest),
    generation: asInt(row.generation),
    startedAt: asInt(row.started_at),
    terminalAt: asNullableInt(row.terminal_at),
  };
}

function mapReceipt(row: Record<string, SQLOutputValue>): ProviderReceiptRow {
  const state = asString(row.state);
  if (!isReceiptState(state)) throw new RuntimeLedgerError("invalid", "corrupt receipt row");
  return {
    receiptId: asString(row.receipt_id),
    runId: asString(row.run_id),
    state,
    usage: parseNullableUsage(asNullableString(row.usage_json)),
    finalizedAt: asNullableInt(row.finalized_at),
  };
}

function mapInteraction(row: Record<string, SQLOutputValue>): RuntimeInteractionRow {
  const state = asString(row.state);
  if (!isInteractionState(state)) throw new RuntimeLedgerError("invalid", "corrupt interaction row");
  return {
    runId: asString(row.run_id),
    toolCallId: asString(row.tool_call_id),
    toolName: asString(row.tool_name),
    argsDigest: asNullableString(row.args_digest),
    resultDigest: asNullableString(row.result_digest),
    state,
    deliveredAt: asNullableInt(row.delivered_at),
    acknowledgedAt: asNullableInt(row.acknowledged_at),
  };
}

function mapQuarantine(row: Record<string, SQLOutputValue>): QuarantineRow {
  const source = asString(row.source);
  if (source !== "lineage" && source !== "ordinary-turn") {
    throw new RuntimeLedgerError("invalid", "corrupt quarantine row");
  }
  return {
    id: asString(row.id),
    source,
    sourcePath: asString(row.source_path),
    reason: asString(row.reason) as QuarantineRow["reason"],
    logicalKey: asNullableString(row.logical_key),
    quarantinedAt: asInt(row.quarantined_at),
  };
}

function parseNullableUsage(json: string | undefined): LedgerUsage | undefined {
  if (!json) return undefined;
  return parseLedgerUsage(json);
}
