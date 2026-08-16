import { invalidRequest } from "../errors.js";

export type ToolChoicePolicy =
  | { mode: "auto"; disableParallel: boolean }
  | { mode: "required"; disableParallel: boolean }
  | { mode: "named"; name: string; disableParallel: boolean };

export function parseAnthropicToolChoice(
  value: unknown,
  disableParallel: boolean,
  toolNames: Set<string>,
): ToolChoicePolicy {
  if (value === undefined || value === null) return { mode: "auto", disableParallel };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest("tool_choice must be an object if provided");
  }
  const raw = value as Record<string, unknown>;
  const localDisable = disableParallel || raw.disable_parallel_tool_use === true;
  if (raw.type === "auto") return { mode: "auto", disableParallel: localDisable };
  if (raw.type === "any") return requireTools({ mode: "required", disableParallel: localDisable }, toolNames);
  if (raw.type === "tool") {
    return namedTool(raw.name, localDisable, toolNames);
  }
  throw invalidRequest("tool_choice.type must be auto, any, or tool");
}

export function parseOpenAiToolChoice(
  value: unknown,
  disableParallel: boolean,
  toolNames: Set<string>,
  protocol: "Chat Completions" | "Responses",
): ToolChoicePolicy {
  if (value === undefined || value === null || value === "auto") {
    return { mode: "auto", disableParallel };
  }
  if (value === "required") {
    return requireTools({ mode: "required", disableParallel }, toolNames);
  }
  if (value === "none") {
    throw invalidRequest(`${protocol} tool_choice=none is not supported`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(`${protocol} tool_choice must be auto, required, or a named function`);
  }
  const raw = value as Record<string, unknown>;
  if (raw.type !== "function") {
    throw invalidRequest(`${protocol} tool_choice object must have type=function`);
  }
  const nested = raw.function && typeof raw.function === "object"
    ? (raw.function as Record<string, unknown>)
    : undefined;
  return namedTool(raw.name ?? nested?.name, disableParallel, toolNames);
}

function requireTools(policy: ToolChoicePolicy, toolNames: Set<string>): ToolChoicePolicy {
  if (toolNames.size === 0) throw invalidRequest("tool_choice requires at least one tool");
  return policy;
}

function namedTool(value: unknown, disableParallel: boolean, toolNames: Set<string>): ToolChoicePolicy {
  if (typeof value !== "string" || !value) {
    throw invalidRequest("named tool_choice requires a tool name");
  }
  if (!toolNames.has(value)) {
    throw invalidRequest(`tool_choice references unknown tool: ${value}`);
  }
  return { mode: "named", name: value, disableParallel };
}

export function toolChoiceDirective(policy: ToolChoicePolicy, hasTools: boolean): string | undefined {
  if (!hasTools) return undefined;
  if (policy.mode === "named") {
    return `HARNESS:\nYou must call the custom MCP tool ${policy.name} before answering.`;
  }
  if (policy.mode === "required" && policy.disableParallel) {
    return "HARNESS:\nYou must call exactly one available custom MCP tool before answering. Do not call tools in parallel.";
  }
  if (policy.mode === "required") {
    return "HARNESS:\nYou must call at least one available custom MCP tool before answering. If the task needs multiple independent tools, call all of them together in the same turn so they can run in parallel.";
  }
  if (policy.disableParallel) {
    return "HARNESS:\nIf you use a custom MCP tool, call at most one tool in this turn. Do not call tools in parallel.";
  }
  return undefined;
}
