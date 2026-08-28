import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ORDINARY_TURN_SCHEMA_VERSION = 1;

export type OrdinaryTurnState = "running" | "completed";

export interface OrdinaryTurnRecord {
  lineageKey: string;
  requestDigest: string;
  nextLineageKey: string;
  tenantScope: string;
  route: string;
  channelId: number;
  effectiveModel: string;
  parentAssistantAnchor: string;
  turnIndex: number;
  toolCatalogDigest: string;
  sessionPolicyFingerprint?: string;
  assistantAnchor: string;
  agentId: string;
  credentialFingerprint: string;
  state: OrdinaryTurnState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

const ALLOWED_STATES = new Set<OrdinaryTurnState>(["running", "completed"]);
const FORBIDDEN_KEYS = [
  "prompt",
  "transcript",
  "messages",
  "conversation",
  "tools",
  "images",
  "response",
  "content",
  "apiKey",
  "credential",
  "body",
] as const;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function validateRecord(record: OrdinaryTurnRecord): void {
  if (!record || typeof record !== "object") {
    throw new Error("invalid Cursor ordinary-turn record");
  }
  if (!record.lineageKey || !record.requestDigest || !record.effectiveModel) {
    throw new Error("incomplete Cursor ordinary-turn record");
  }
  if (
    record.sessionPolicyFingerprint !== undefined &&
    !/^[a-f0-9]{64}$/.test(record.sessionPolicyFingerprint)
  ) {
    throw new Error("invalid Cursor ordinary-turn session policy fingerprint");
  }
  if (record.tenantScope && !/^[a-f0-9]{64}$/.test(record.tenantScope)) {
    throw new Error("invalid Cursor ordinary-turn tenant scope");
  }
  if (!ALLOWED_STATES.has(record.state)) {
    throw new Error("unsupported Cursor ordinary-turn record state");
  }
  if (!Number.isFinite(record.expiresAt)) {
    throw new Error("Cursor ordinary-turn record requires expiry");
  }
  if (record.credentialFingerprint && !/^[a-f0-9]{64}$/.test(record.credentialFingerprint)) {
    throw new Error("invalid Cursor ordinary-turn credential fingerprint");
  }
  for (const key of FORBIDDEN_KEYS) {
    if (Object.hasOwn(record, key)) {
      throw new Error("Cursor ordinary-turn journal cannot persist request or response content");
    }
  }
}

export class OrdinaryTurnJournal {
  readonly records = new Map<string, OrdinaryTurnRecord>();
  private onExpire?: (record: OrdinaryTurnRecord) => void;

  constructor(
    readonly filePath = "",
    private readonly options: {
      now?: () => number;
      onExpire?: (record: OrdinaryTurnRecord) => void;
    } = {},
  ) {
    this.onExpire = options.onExpire;
    this.#load();
  }

  setOnExpire(handler: (record: OrdinaryTurnRecord) => void): void {
    this.onExpire = handler;
  }

  now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #recordId(record: Pick<OrdinaryTurnRecord, "lineageKey" | "requestDigest">): string {
    return `${record.lineageKey}:${record.requestDigest}`;
  }

  #load(): void {
    if (!this.filePath) return;
    let parsed: { schemaVersion?: number; records?: OrdinaryTurnRecord[] };
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as {
        schemaVersion?: number;
        records?: OrdinaryTurnRecord[];
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw new Error(
        `failed to load Cursor ordinary-turn journal: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (parsed.schemaVersion !== ORDINARY_TURN_SCHEMA_VERSION || !Array.isArray(parsed.records)) {
      throw new Error("unsupported Cursor ordinary-turn journal schema");
    }
    const expired: OrdinaryTurnRecord[] = [];
    for (const record of parsed.records) {
      validateRecord(record);
      if (record.expiresAt > this.now()) this.records.set(this.#recordId(record), record);
      else expired.push(record);
    }
    this.#flush();
    this.#notifyExpired(expired);
  }

  #flush(): void {
    if (!this.filePath) return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify({ schemaVersion: ORDINARY_TURN_SCHEMA_VERSION, records: [...this.records.values()] })}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.filePath);
  }

  upsert(record: OrdinaryTurnRecord): OrdinaryTurnRecord {
    validateRecord(record);
    this.records.set(this.#recordId(record), clone(record));
    this.#flush();
    return clone(record);
  }

  remove(lineageKey: string, requestDigest: string): boolean {
    if (!this.records.delete(`${lineageKey}:${requestDigest}`)) return false;
    this.#flush();
    return true;
  }

  findExact(lineageKey: string, requestDigest: string): OrdinaryTurnRecord | null {
    this.sweepExpired();
    const record = this.records.get(`${lineageKey}:${requestDigest}`);
    return record ? clone(record) : null;
  }

  findByLineageKey(lineageKey: string): OrdinaryTurnRecord[] {
    this.sweepExpired();
    return [...this.records.values()]
      .filter((record) => record.lineageKey === lineageKey)
      .map(clone);
  }

  findByNextLineageKey(nextLineageKey: string): OrdinaryTurnRecord[] {
    this.sweepExpired();
    return [...this.records.values()]
      .filter((record) => record.state === "completed" && record.nextLineageKey === nextLineageKey)
      .map(clone);
  }

  sweepExpired(): boolean {
    const now = this.now();
    const expired: OrdinaryTurnRecord[] = [];
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(id);
        expired.push(record);
        changed = true;
      }
    }
    if (changed) this.#flush();
    this.#notifyExpired(expired);
    return changed;
  }

  counts(): { running: number; completed: number; total: number } {
    this.sweepExpired();
    let running = 0;
    let completed = 0;
    for (const record of this.records.values()) {
      if (record.state === "running") running += 1;
      else completed += 1;
    }
    return { running, completed, total: running + completed };
  }

  clear(): void {
    this.records.clear();
    if (this.filePath) rmSync(this.filePath, { force: true });
  }

  #notifyExpired(expired: OrdinaryTurnRecord[]): void {
    if (!this.onExpire || expired.length === 0) return;
    const liveAgentIds = new Set(
      [...this.records.values()].map((record) => record.agentId).filter(Boolean),
    );
    const notified = new Set<string>();
    for (const record of expired) {
      const agentId = record.agentId;
      if (!agentId || liveAgentIds.has(agentId) || notified.has(agentId)) continue;
      notified.add(agentId);
      try {
        this.onExpire(record);
      } catch {
        // Store cleanup is best-effort; journal expiry already landed.
      }
    }
  }
}
