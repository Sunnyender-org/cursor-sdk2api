import { sessionId, toolUseId } from "../ids.js";
import type { Clock } from "../clock.js";
import type { SdkAgent, SdkCustomToolResult, SdkRun } from "../sdk/port.js";
import type { AssistantTurn } from "../protocols/anthropic/types.js";
import type { CursorAgentTurn } from "./cursor-agent-turn.js";
import type { EventPump } from "./event-pump.js";

export type SessionState =
  | "creating"
  | "running"
  | "awaiting_tool_results"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

export interface PendingCall {
  toolUseId: string;
  name: string;
  input: unknown;
  toolKind?: "function" | "custom";
  namespace?: string;
  createdAt: number;
  resolved: boolean;
  resultDigest?: string;
  promise: Promise<SdkCustomToolResult>;
  resolve: (value: SdkCustomToolResult) => void;
  reject: (error: Error) => void;
}

export interface ReplayRecord {
  digest: string;
  turn: AssistantTurn;
  createdAt: number;
}

export class Session {
  readonly sessionId: string;
  readonly credentialFingerprint: string;
  readonly modelId: string;
  readonly modelParams: Array<{ id: string; value: string }>;
  readonly sessionPolicyFingerprint: string;
  readonly executableToolCatalogFingerprint: string;
  readonly instanceId: string;
  readonly createdAt: number;
  lastActivityAt: number;
  state: SessionState = "creating";
  agent?: SdkAgent;
  sdkAgentId?: string;
  run?: SdkRun;
  pump?: EventPump;
  readonly pending = new Map<string, PendingCall>();
  readonly earlyCalls: PendingCall[] = [];
  replay?: ReplayRecord;
  usageConfirmed = false;
  hasSemanticOutput = false;
  sawToolBatch = false;
  lastResultDigest?: string;
  appliedBoundaryId?: string;
  closeReason?: string;
  ordinaryReplayOwner?: CursorAgentTurn;
  retainOrdinaryAgent = false;
  retainUntil = 0;

  constructor(input: {
    credentialFingerprint: string;
    modelId: string;
    modelParams?: Array<{ id: string; value: string }>;
    sessionPolicyFingerprint: string;
    executableToolCatalogFingerprint: string;
    instanceId: string;
    clock: Clock;
    sessionId?: string;
  }) {
    this.sessionId = input.sessionId ?? sessionId();
    this.credentialFingerprint = input.credentialFingerprint;
    this.modelId = input.modelId;
    this.modelParams = [...(input.modelParams ?? [])];
    this.sessionPolicyFingerprint = input.sessionPolicyFingerprint;
    this.executableToolCatalogFingerprint = input.executableToolCatalogFingerprint;
    this.instanceId = input.instanceId;
    this.createdAt = input.clock.now();
    this.lastActivityAt = this.createdAt;
  }

  touch(clock: Clock): void {
    this.lastActivityAt = clock.now();
  }

  createPending(
    name: string,
    input: unknown,
    clock: Clock,
    explicitId?: string,
    toolKind?: "function" | "custom",
    namespace?: string,
  ): PendingCall {
    let resolve!: (value: SdkCustomToolResult) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<SdkCustomToolResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const call: PendingCall = {
      toolUseId: toolUseId(explicitId),
      name,
      input,
      ...(toolKind ? { toolKind } : {}),
      ...(namespace ? { namespace } : {}),
      createdAt: clock.now(),
      resolved: false,
      promise,
      resolve,
      reject,
    };
    this.pending.set(call.toolUseId, call);
    return call;
  }

  unresolvedIds(): string[] {
    return [...this.pending.values()].filter((call) => !call.resolved).map((call) => call.toolUseId);
  }

  markClosed(reason: string): void {
    this.state = "closed";
    this.closeReason = reason;
  }
}
