export const RUNTIME_DB_FILENAME = "runtime.db";
export const RUNTIME_QUARANTINE_DIR = "runtime-quarantine";
export const RUNTIME_LEDGER_BUSY_TIMEOUT_MS = 5_000;
export const RUNTIME_LEDGER_SCHEMA_VERSION = 1;

export type RuntimeProfile = "sdk" | "sand";

export type AgentState = "active" | "retired";

export type RunState =
  | "running"
  | "awaiting_tool_results"
  | "finished"
  | "error"
  | "runtime_lost";

export type ReceiptState = "provisional" | "finalized";

export type InteractionState = "pending" | "delivered" | "acknowledged";

export type LedgerErrorCode = "conflict" | "invalid" | "busy" | "not_found" | "forbidden_content";

export type QuarantineReason =
  | "truncated_json"
  | "invalid_shape"
  | "unsupported_version"
  | "incomplete"
  | "expired"
  | "policy_mismatch"
  | "content_forbidden";

export interface LedgerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export interface RuntimeAgentRow {
  id: string;
  credentialFingerprint: string;
  runtimeProfile: RuntimeProfile;
  sdkAgentId: string;
  model?: string;
  policyDigest: string;
  generation: number;
  state: AgentState;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeRunRow {
  id: string;
  agentId: string;
  logicalKey: string;
  runtimeProfile: RuntimeProfile;
  sdkRunId?: string;
  state: RunState;
  observeOffset?: string;
  usage?: LedgerUsage;
  receiptId?: string;
  terminalDigest?: string;
  generation: number;
  startedAt: number;
  terminalAt?: number;
}

export interface RuntimeInteractionRow {
  runId: string;
  toolCallId: string;
  toolName: string;
  argsDigest?: string;
  resultDigest?: string;
  state: InteractionState;
  deliveredAt?: number;
  acknowledgedAt?: number;
}

export interface ProviderReceiptRow {
  receiptId: string;
  runId: string;
  state: ReceiptState;
  usage?: LedgerUsage;
  finalizedAt?: number;
}

export interface UpsertAgentInput {
  id?: string;
  credentialFingerprint: string;
  runtimeProfile: RuntimeProfile;
  sdkAgentId: string;
  model?: string;
  policyDigest: string;
  state?: AgentState;
}

export interface ClaimRunInput {
  id?: string;
  agentId: string;
  logicalKey: string;
  runtimeProfile: RuntimeProfile;
  generation: number;
  sdkRunId?: string;
}

export interface ClaimedRun {
  /** `existing` means reconnect: the same owner, never a second Send. */
  outcome: "created" | "existing";
  run: RuntimeRunRow;
}

export interface RecordInteractionInput {
  runId: string;
  generation: number;
  toolCallId: string;
  toolName: string;
  argsDigest?: string;
  resultDigest?: string;
  state: InteractionState;
}

export interface FinalizeRunInput {
  runId: string;
  generation: number;
  receiptId: string;
  terminalDigest: string;
  state: Extract<RunState, "finished" | "error" | "runtime_lost">;
  usage?: LedgerUsage;
}

export interface QuarantineRow {
  id: string;
  source: "lineage" | "ordinary-turn";
  sourcePath: string;
  reason: QuarantineReason;
  logicalKey?: string;
  quarantinedAt: number;
}

export interface LegacyImportReport {
  importedAgents: number;
  importedRuns: number;
  importedInteractions: number;
  quarantined: number;
}

export const TERMINAL_RUN_STATES = new Set<RunState>(["finished", "error", "runtime_lost"]);
export const ACTIVE_RUN_STATES = new Set<RunState>(["running", "awaiting_tool_results"]);

export function isRuntimeProfile(value: string): value is RuntimeProfile {
  return value === "sdk" || value === "sand";
}

export function isAgentState(value: string): value is AgentState {
  return value === "active" || value === "retired";
}

export function isRunState(value: string): value is RunState {
  return (
    value === "running" ||
    value === "awaiting_tool_results" ||
    value === "finished" ||
    value === "error" ||
    value === "runtime_lost"
  );
}

export function isReceiptState(value: string): value is ReceiptState {
  return value === "provisional" || value === "finalized";
}

export function isInteractionState(value: string): value is InteractionState {
  return value === "pending" || value === "delivered" || value === "acknowledged";
}

export function runtimeLedgerV2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.RUNTIME_LEDGER_V2;
  if (raw == null || raw === "") return true;
  const value = raw.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}
