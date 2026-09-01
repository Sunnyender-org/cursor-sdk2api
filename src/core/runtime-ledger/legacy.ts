import { chmodSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Clock } from "../../clock.js";
import { RuntimeLedgerError } from "./errors.js";
import { assertNoForbiddenFields, assertSha256Digest } from "./payload.js";
import type { QuarantineReason, RunState } from "./types.js";

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const HEX64 = /^[a-f0-9]{64}$/;
const ORDINARY_TURN_SCHEMA_VERSION = 1;

export interface CompatibleLineage {
  sessionId: string;
  sdkAgentId: string;
  credentialFingerprint: string;
  modelId: string;
  sessionPolicyFingerprint: string;
  executableToolCatalogFingerprint: string;
  state: "completed" | "awaiting_tool_results" | "failed";
  pendingCalls: Array<{ toolUseId: string; name: string }>;
  lastResultDigest?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

export interface CompatibleOrdinaryTurn {
  lineageKey: string;
  requestDigest: string;
  sdkAgentId: string;
  credentialFingerprint: string;
  modelId: string;
  sessionPolicyFingerprint: string;
  state: "running" | "completed";
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export type ScanItem<T> =
  | { kind: "import"; sourcePath: string; record: T }
  | {
      kind: "quarantine";
      source: "lineage" | "ordinary-turn";
      sourcePath: string;
      reason: QuarantineReason;
      logicalKey?: string;
      copyFile: boolean;
    };

export function mapLineageRunState(state: CompatibleLineage["state"]): RunState {
  if (state === "completed") return "finished";
  if (state === "failed") return "error";
  return "awaiting_tool_results";
}

export function mapOrdinaryRunState(state: CompatibleOrdinaryTurn["state"]): RunState {
  return state === "completed" ? "finished" : "running";
}

export function scanLineageDir(dir: string, clock: Clock): Array<ScanItem<CompatibleLineage>> {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json") && !name.includes(".corrupt"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const out: Array<ScanItem<CompatibleLineage>> = [];
  for (const name of names) {
    const sourcePath = join(dir, name);
    out.push(scanLineageFile(sourcePath, clock));
  }
  return out;
}

export function scanOrdinaryTurnJournal(
  filePath: string,
  clock: Clock,
): Array<ScanItem<CompatibleOrdinaryTurn>> {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return [
      {
        kind: "quarantine",
        source: "ordinary-turn",
        sourcePath: filePath,
        reason: "truncated_json",
        copyFile: true,
      },
    ];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        kind: "quarantine",
        source: "ordinary-turn",
        sourcePath: filePath,
        reason: "invalid_shape",
        copyFile: true,
      },
    ];
  }
  const body = parsed as Record<string, unknown>;
  if (body.schemaVersion !== ORDINARY_TURN_SCHEMA_VERSION || !Array.isArray(body.records)) {
    return [
      {
        kind: "quarantine",
        source: "ordinary-turn",
        sourcePath: filePath,
        reason: "unsupported_version",
        copyFile: true,
      },
    ];
  }
  const now = clock.now();
  const out: Array<ScanItem<CompatibleOrdinaryTurn>> = [];
  for (const [index, record] of body.records.entries()) {
    out.push(classifyOrdinaryRecord(filePath, `#${index}`, record, now));
  }
  return out;
}

export function copyToQuarantineDir(sourcePath: string, quarantineDir: string, clock: Clock): void {
  const dest = join(quarantineDir, `${basename(sourcePath)}.${clock.now()}`);
  copyFileSync(sourcePath, dest);
  try {
    chmodSync(dest, 0o600);
  } catch {
    // best-effort
  }
}

function scanLineageFile(sourcePath: string, clock: Clock): ScanItem<CompatibleLineage> {
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch {
    return {
      kind: "quarantine",
      source: "lineage",
      sourcePath,
      reason: "truncated_json",
      copyFile: true,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return {
      kind: "quarantine",
      source: "lineage",
      sourcePath,
      reason: "truncated_json",
      copyFile: true,
    };
  }
  const classified = classifyLineageRecord(sourcePath, parsed, clock.now());
  return classified;
}

function classifyLineageRecord(
  sourcePath: string,
  value: unknown,
  now: number,
): ScanItem<CompatibleLineage> {
  const quarantine = (
    reason: QuarantineReason,
    logicalKey?: string,
  ): ScanItem<CompatibleLineage> => ({
    kind: "quarantine",
    source: "lineage",
    sourcePath,
    reason,
    logicalKey,
    copyFile: false,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return quarantine("invalid_shape");
  }
  const record = value as Record<string, unknown>;
  try {
    assertNoForbiddenFields(record, "lineage");
  } catch {
    return quarantine("content_forbidden", typeof record.sessionId === "string" ? record.sessionId : undefined);
  }
  if (record.version !== 2) return quarantine("unsupported_version");
  if (typeof record.sessionId !== "string" || !SESSION_ID_RE.test(record.sessionId)) {
    return quarantine("incomplete");
  }
  if (typeof record.sdkAgentId !== "string" || !record.sdkAgentId) return quarantine("incomplete", record.sessionId);
  if (typeof record.credentialFingerprint !== "string" || !record.credentialFingerprint) {
    return quarantine("incomplete", record.sessionId);
  }
  if (typeof record.modelId !== "string" || !record.modelId) return quarantine("incomplete", record.sessionId);
  if (typeof record.sessionPolicyFingerprint !== "string") {
    return quarantine("incomplete", record.sessionId);
  }
  if (!HEX64.test(record.sessionPolicyFingerprint)) {
    return quarantine("policy_mismatch", record.sessionId);
  }
  if (
    typeof record.executableToolCatalogFingerprint !== "string" ||
    !HEX64.test(record.executableToolCatalogFingerprint)
  ) {
    return quarantine("policy_mismatch", record.sessionId);
  }
  if (
    record.state !== "completed" &&
    record.state !== "awaiting_tool_results" &&
    record.state !== "failed"
  ) {
    return quarantine("invalid_shape", record.sessionId);
  }
  if (
    typeof record.createdAt !== "number" ||
    typeof record.lastActivityAt !== "number" ||
    typeof record.expiresAt !== "number"
  ) {
    return quarantine("incomplete", record.sessionId);
  }
  if (now >= record.expiresAt) return quarantine("expired", record.sessionId);
  if (!Array.isArray(record.pendingToolIds) || record.pendingToolIds.some((id) => typeof id !== "string")) {
    return quarantine("incomplete", record.sessionId);
  }
  let pendingCalls: Array<{ toolUseId: string; name: string }> = [];
  if (record.pendingCalls !== undefined) {
    if (!Array.isArray(record.pendingCalls)) return quarantine("invalid_shape", record.sessionId);
    for (const call of record.pendingCalls) {
      if (
        !call ||
        typeof call !== "object" ||
        typeof (call as Record<string, unknown>).toolUseId !== "string" ||
        typeof (call as Record<string, unknown>).name !== "string"
      ) {
        return quarantine("incomplete", record.sessionId);
      }
      pendingCalls.push({
        toolUseId: (call as { toolUseId: string }).toolUseId,
        name: (call as { name: string }).name,
      });
    }
  }
  let lastResultDigest: string | undefined;
  if (record.lastResultDigest !== undefined) {
    if (typeof record.lastResultDigest !== "string") return quarantine("invalid_shape", record.sessionId);
    try {
      assertSha256Digest(record.lastResultDigest, "lastResultDigest");
    } catch {
      return quarantine("invalid_shape", record.sessionId);
    }
    lastResultDigest = record.lastResultDigest;
  }
  return {
    kind: "import",
    sourcePath,
    record: {
      sessionId: record.sessionId,
      sdkAgentId: record.sdkAgentId,
      credentialFingerprint: record.credentialFingerprint,
      modelId: record.modelId,
      sessionPolicyFingerprint: record.sessionPolicyFingerprint,
      executableToolCatalogFingerprint: record.executableToolCatalogFingerprint,
      state: record.state,
      pendingCalls,
      lastResultDigest,
      createdAt: record.createdAt,
      lastActivityAt: record.lastActivityAt,
      expiresAt: record.expiresAt,
    },
  };
}

function classifyOrdinaryRecord(
  sourcePath: string,
  indexLabel: string,
  value: unknown,
  now: number,
): ScanItem<CompatibleOrdinaryTurn> {
  const quarantine = (
    reason: QuarantineReason,
    logicalKey?: string,
  ): ScanItem<CompatibleOrdinaryTurn> => ({
    kind: "quarantine",
    source: "ordinary-turn",
    sourcePath: `${sourcePath}${indexLabel}`,
    reason,
    logicalKey,
    copyFile: false,
  });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return quarantine("invalid_shape");
  }
  const record = value as Record<string, unknown>;
  try {
    assertNoForbiddenFields(record, "ordinary-turn");
  } catch {
    return quarantine(
      "content_forbidden",
      typeof record.lineageKey === "string" ? String(record.lineageKey) : undefined,
    );
  }
  if (typeof record.lineageKey !== "string" || !record.lineageKey) return quarantine("incomplete");
  if (typeof record.requestDigest !== "string" || !record.requestDigest) {
    return quarantine("incomplete", record.lineageKey);
  }
  if (typeof record.agentId !== "string" || !record.agentId) {
    return quarantine("incomplete", record.lineageKey);
  }
  if (typeof record.credentialFingerprint !== "string" || !HEX64.test(record.credentialFingerprint)) {
    return quarantine("incomplete", record.lineageKey);
  }
  if (typeof record.effectiveModel !== "string" || !record.effectiveModel) {
    return quarantine("incomplete", record.lineageKey);
  }
  if (typeof record.sessionPolicyFingerprint !== "string") {
    return quarantine("policy_mismatch", record.lineageKey);
  }
  if (!HEX64.test(record.sessionPolicyFingerprint)) {
    return quarantine("policy_mismatch", record.lineageKey);
  }
  if (record.state !== "running" && record.state !== "completed") {
    return quarantine("invalid_shape", record.lineageKey);
  }
  if (
    typeof record.createdAt !== "number" ||
    typeof record.updatedAt !== "number" ||
    typeof record.expiresAt !== "number"
  ) {
    return quarantine("incomplete", record.lineageKey);
  }
  if (now >= record.expiresAt) return quarantine("expired", record.lineageKey);
  const logicalKey = `${record.lineageKey}:${record.requestDigest}`;
  return {
    kind: "import",
    sourcePath,
    record: {
      lineageKey: logicalKey,
      requestDigest: record.requestDigest,
      sdkAgentId: record.agentId,
      credentialFingerprint: record.credentialFingerprint,
      modelId: record.effectiveModel,
      sessionPolicyFingerprint: record.sessionPolicyFingerprint,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
    },
  };
}

export function requireScanClock(clock: Clock): Clock {
  if (!clock || typeof clock.now !== "function") {
    throw new RuntimeLedgerError("invalid", "RuntimeLedger requires a clock");
  }
  return clock;
}
