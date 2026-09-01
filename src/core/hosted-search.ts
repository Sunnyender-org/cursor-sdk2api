import { invalidRequest } from "../errors.js";
import type { ToolChoicePolicy } from "../protocols/tool-choice.js";
import type { HostedSearchMode } from "./runtime-profile.js";

const HOSTED_ALWAYS_REJECTED = new Set(["x_search", "file_search", "computer", "shell", "apply_patch"]);

export function isHostedWebSearchTool(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as { type?: unknown }).type === "web_search");
}

export function assertHostedSearchRequest(raw: Record<string, unknown>, mode: HostedSearchMode): void {
  const type = typeof raw.type === "string" ? raw.type : "";
  if (HOSTED_ALWAYS_REJECTED.has(type) || type === "x_search") {
    throw invalidRequest(`${type || "hosted tool"} is not supported`);
  }
  if (type !== "web_search") return;
  if (mode !== "auto") {
    throw invalidRequest("web_search is not supported");
  }
  const extra = Object.keys(raw).filter((key) => key !== "type");
  if (extra.length > 0) {
    throw invalidRequest("web_search filters are not supported");
  }
}

export function assertHostedSearchToolChoice(hostedSearch: boolean, toolChoice: ToolChoicePolicy): void {
  if (!hostedSearch) return;
  if (toolChoice.mode === "required" || toolChoice.mode === "named") {
    throw invalidRequest("hosted search cannot be required or named");
  }
}
