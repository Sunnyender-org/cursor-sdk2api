import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.js";
import type { RuntimeProfile } from "./runtime-profile.js";

export type LineageState = "completed" | "awaiting_tool_results" | "failed";

export interface LineageRecord {
  version: 2;
  sessionId: string;
  sdkAgentId: string;
  credentialFingerprint: string;
  modelId: string;
  modelParams?: Array<{ id: string; value: string }>;
  sessionPolicyFingerprint: string;
  executableToolCatalogFingerprint: string;
  runtimeProfile?: RuntimeProfile;
  state: LineageState;
  pendingToolIds: string[];
  pendingCalls?: Array<{ toolUseId: string; name: string }>;
  lastResultDigest?: string;
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;

export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort on filesystems that ignore mode
  }
}

export class LineageStore {
  readonly dir: string;

  constructor(
    stateDir: string,
    private readonly clock: Clock,
  ) {
    this.dir = join(stateDir, "lineage");
    ensurePrivateDir(stateDir);
    ensurePrivateDir(this.dir);
  }

  get(sessionId: string): LineageRecord | undefined {
    if (!SESSION_ID_RE.test(sessionId)) return undefined;
    return this.liveRecord(this.readFile(this.pathFor(sessionId)));
  }

  findByToolIds(ids: string[]): LineageRecord | undefined {
    if (ids.length === 0) return undefined;
    const wanted = new Set(ids);
    for (const record of this.list()) {
      const live = this.liveRecord(record);
      if (live?.pendingToolIds.some((id) => wanted.has(id))) return live;
    }
    return undefined;
  }

  put(record: LineageRecord): void {
    if (!SESSION_ID_RE.test(record.sessionId)) {
      throw new Error("invalid lineage session id");
    }
    const path = this.pathFor(record.sessionId);
    const tmp = `${path}.${process.pid}.${this.clock.now()}.tmp`;
    const payload = JSON.stringify(record);
    try {
      writeFileSync(tmp, payload, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort
      }
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // leftover tmp must not crash the process
      }
      throw error;
    }
  }

  delete(sessionId: string): void {
    if (!SESSION_ID_RE.test(sessionId)) return;
    try {
      unlinkSync(this.pathFor(sessionId));
    } catch {
      // already gone
    }
  }

  list(): LineageRecord[] {
    const out: LineageRecord[] = [];
    for (const name of this.lineageFiles()) {
      const record = this.readFile(join(this.dir, name));
      if (record) out.push(record);
    }
    return out;
  }

  sweep(): void {
    const now = this.clock.now();
    for (const record of this.list()) {
      if (now >= record.expiresAt) this.delete(record.sessionId);
    }
  }

  dirMode(): number {
    return statSync(this.dir).mode & 0o777;
  }

  fileMode(sessionId: string): number | undefined {
    try {
      return statSync(this.pathFor(sessionId)).mode & 0o777;
    } catch {
      return undefined;
    }
  }

  private liveRecord(record: LineageRecord | undefined): LineageRecord | undefined {
    if (!record) return undefined;
    if (this.clock.now() >= record.expiresAt) {
      this.delete(record.sessionId);
      return undefined;
    }
    return record;
  }

  private pathFor(sessionId: string): string {
    return join(this.dir, `${sessionId}.json`);
  }

  private lineageFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith(".json") && !name.includes(".corrupt"));
    } catch {
      return [];
    }
  }

  private readFile(path: string): LineageRecord | undefined {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isLineageRecord(parsed)) throw new Error("invalid lineage shape");
      return parsed;
    } catch {
      this.quarantine(path);
      return undefined;
    }
  }

  private quarantine(path: string): void {
    try {
      renameSync(path, `${path}.corrupt.${this.clock.now()}`);
    } catch {
      try {
        unlinkSync(path);
      } catch {
        // leave in place rather than crash
      }
    }
  }
}

function isLineageRecord(value: unknown): value is LineageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return false;
  if (typeof record.sessionId !== "string" || !SESSION_ID_RE.test(record.sessionId)) return false;
  if (typeof record.sdkAgentId !== "string" || !record.sdkAgentId) return false;
  if (typeof record.credentialFingerprint !== "string" || !record.credentialFingerprint) return false;
  if (typeof record.modelId !== "string" || !record.modelId) return false;
  if (
    typeof record.sessionPolicyFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.sessionPolicyFingerprint)
  ) {
    return false;
  }
  if (
    typeof record.executableToolCatalogFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.executableToolCatalogFingerprint)
  ) {
    return false;
  }
  if (
    record.modelParams !== undefined &&
    (!Array.isArray(record.modelParams) ||
      record.modelParams.some(
        (item) =>
          !item ||
          typeof item !== "object" ||
          typeof (item as Record<string, unknown>).id !== "string" ||
          typeof (item as Record<string, unknown>).value !== "string",
      ))
  ) {
    return false;
  }
  if (record.state !== "completed" && record.state !== "awaiting_tool_results" && record.state !== "failed") {
    return false;
  }
  if (!Array.isArray(record.pendingToolIds) || record.pendingToolIds.some((id) => typeof id !== "string")) {
    return false;
  }
  if (
    record.pendingCalls !== undefined &&
    (!Array.isArray(record.pendingCalls) ||
      record.pendingCalls.some(
        (call) =>
          !call ||
          typeof call !== "object" ||
          typeof (call as Record<string, unknown>).toolUseId !== "string" ||
          typeof (call as Record<string, unknown>).name !== "string",
      ))
  ) {
    return false;
  }
  if (typeof record.createdAt !== "number" || typeof record.lastActivityAt !== "number" || typeof record.expiresAt !== "number") {
    return false;
  }
  if (record.lastResultDigest !== undefined && typeof record.lastResultDigest !== "string") return false;
  return true;
}
