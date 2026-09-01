import { digestJson, stableStringify } from "../digest.js";
import type { AnthropicTool, ParsedMessages } from "../protocols/anthropic/types.js";
import type { ToolChoicePolicy } from "../protocols/tool-choice.js";
import {
  boundRuntimeProfile,
  DEFAULT_RUNTIME_PROFILE,
  type RuntimeProfile,
} from "./runtime-profile.js";

export interface SessionPolicyInput {
  modelId: string;
  modelParams: Array<{ id: string; value: string }>;
  tools: AnthropicTool[];
  toolChoice: ToolChoicePolicy | null;
  runtimeProfile?: RuntimeProfile;
}

export function sessionPolicyFingerprint(input: SessionPolicyInput): string {
  return digestJson({
    model: {
      id: input.modelId,
      params: normalizeModelParams(input.modelParams),
    },
    tools: normalizeExecutableTools(input.tools),
    toolChoice: input.toolChoice,
    runtimeProfile: boundRuntimeProfile(input.runtimeProfile),
  });
}

export function executableToolCatalogFingerprint(tools: AnthropicTool[]): string {
  return digestJson(normalizeExecutableTools(tools));
}

export function sessionPolicyFingerprintFromParsed(
  parsed: ParsedMessages,
  effectiveModelParams: Array<{ id: string; value: string }> = parsed.modelParams,
  runtimeProfile: RuntimeProfile = DEFAULT_RUNTIME_PROFILE,
): string {
  return sessionPolicyFingerprint({
    modelId: parsed.model,
    modelParams: effectiveModelParams,
    tools: parsed.tools,
    toolChoice: parsed.toolChoice ?? null,
    runtimeProfile,
  });
}

export function normalizeModelParams(
  params: Array<{ id: string; value: string }>,
): Array<{ id: string; value: string }> {
  return params
    .map((param) => ({ id: param.id, value: param.value }))
    .sort((left, right) =>
      left.id.localeCompare(right.id) || left.value.localeCompare(right.value),
    );
}

function normalizeExecutableTools(tools: AnthropicTool[]): Array<Record<string, unknown>> {
  return tools
    .map((tool) => ({
      publicName: tool.name,
      sdkName: tool.sdk_name ?? tool.name,
      kind: tool.tool_kind ?? "function",
      namespace: tool.namespace ?? "",
      description: tool.description ?? "",
      inputSchema: tool.input_schema ?? null,
    }))
    .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
}
