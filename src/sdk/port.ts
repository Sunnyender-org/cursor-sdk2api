import type { RuntimeProfile } from "../core/runtime-profile.js";

export const AMBIENT_DISALLOWED_TOOLS = [
  "shell",
  "read",
  "edit",
  "task",
  "webSearch",
  "webFetch",
] as const;

export interface SdkModelParameter {
  id: string;
  displayName?: string;
  values: Array<{ value: string; displayName?: string }>;
}

export interface SdkModel {
  id: string;
  displayName?: string;
  description?: string;
  parameters?: SdkModelParameter[];
  variants?: Array<{
    displayName: string;
    description?: string;
    isDefault?: boolean;
    params: Array<{ id: string; value: string }>;
  }>;
}

export interface SdkIdentity {
  apiKeyName?: string;
  userId?: number | string;
  createdAt?: string;
  firstName?: string;
  lastName?: string;
}

export interface SdkUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface SdkRunResult {
  id: string;
  requestId?: string;
  status: "finished" | "error" | "cancelled";
  result?: string;
  error?: { message: string; code?: string };
  usage?: SdkUsage;
}

export type SdkStreamEvent =
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "usage"; usage: SdkUsage }
  | { type: "tool_call"; callId: string; name: string; status: string }
  | { type: "status"; status: string };

export interface SdkCustomToolContext {
  toolCallId?: string;
}

export type SdkToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType?: string };

export type SdkCustomToolResult =
  | string
  | {
      content: SdkToolContent[];
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };

export interface SdkCustomTool {
  description?: string;
  inputSchema?: Record<string, unknown>;
  execute: (
    args: Record<string, unknown>,
    context: SdkCustomToolContext,
  ) => SdkCustomToolResult | Promise<SdkCustomToolResult>;
}

export type SdkDeltaUpdate =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "turn-ended"; usage?: SdkUsage };

export type SdkDeltaHandler = (update: SdkDeltaUpdate) => void | Promise<void>;

export interface SdkSendInput {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  customTools?: Record<string, SdkCustomTool>;
  /** Expire a persisted active run before sending a recovered continuation. */
  force?: boolean;
  /** Official SendOptions.onDelta mapping. */
  onDelta?: SdkDeltaHandler;
  /** Optional alias for the same incremental updates. */
  onEvent?: SdkDeltaHandler;
}

export interface SdkRun {
  id: string;
  requestId?: string;
  stream(): AsyncIterable<SdkStreamEvent>;
  wait(): Promise<SdkRunResult>;
  cancel(): Promise<void>;
  usage?: SdkUsage;
}

export interface SdkAgent {
  agentId: string;
  send(input: SdkSendInput): Promise<SdkRun>;
  close(): void | Promise<void>;
}

export interface CreateAgentInput {
  apiKey: string;
  modelId: string;
  modelParams?: Array<{ id: string; value: string }>;
  workspaceDir: string;
  clientToolNames: string[];
  customTools: Record<string, SdkCustomTool>;
  runtimeProfile?: RuntimeProfile;
  hostedSearch?: boolean;
}

export interface ResumeAgentInput extends CreateAgentInput {
  agentId: string;
}

export type SdkCatalogResult =
  | { ok: true; models: SdkModel[] }
  | { ok: false; reason: string; message: string };

export type SdkAccountResult =
  | {
      ok: true;
      identity: SdkIdentity;
      spending?: Record<string, unknown>;
      limits?: Record<string, unknown>;
      spendingReason?: string;
      limitsReason?: string;
    }
  | { ok: false; reason: string; message: string };

export interface SdkRuntime {
  readonly sdkVersion: string;
  createAgent(input: CreateAgentInput): Promise<SdkAgent>;
  resumeAgent(input: ResumeAgentInput): Promise<SdkAgent>;
  listModels(apiKey: string): Promise<SdkCatalogResult>;
  getAccount(apiKey: string): Promise<SdkAccountResult>;
  probeCredential(apiKey: string): Promise<"valid" | "invalid" | "unavailable">;
}

export function apiProfileToolAllowlist(clientToolNames: string[], hostedSearch = false): string[] {
  const names = clientToolNames.length > 0 ? ["mcp"] : [];
  if (hostedSearch) names.push("webSearch", "webFetch");
  return names;
}

export function ambientDisallowedTools(hostedSearch = false): string[] {
  if (!hostedSearch) return [...AMBIENT_DISALLOWED_TOOLS];
  return AMBIENT_DISALLOWED_TOOLS.filter((name) => name !== "webSearch" && name !== "webFetch");
}
