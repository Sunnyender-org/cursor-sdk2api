import { invalidRequest } from "../../errors.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicTool,
  ParsedMessages,
  ParsedToolResult,
} from "./types.js";
import { parseAnthropicToolChoice, toolChoiceDirective } from "../tool-choice.js";

export function parseMessagesRequest(body: unknown): ParsedMessages {
  if (!body || typeof body !== "object") {
    throw invalidRequest("JSON object body is required");
  }
  const raw = body as Record<string, unknown>;
  if (typeof raw.model !== "string" || !raw.model.trim()) {
    throw invalidRequest("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw invalidRequest("messages must be a non-empty array");
  }

  const normalized = normalizeRawMessages(raw.messages);
  if (normalized.messages.length === 0) {
    throw invalidRequest("messages must be a non-empty array");
  }
  const messages = normalized.messages.map(parseMessage);
  const tools = Array.isArray(raw.tools) ? raw.tools.map(parseTool) : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw invalidRequest(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const continuation = lastUser ? parseContinuation(lastUser) : undefined;
  const images = collectImages(messages);
  const toolChoice = parseAnthropicToolChoice(
    raw.tool_choice,
    raw.tool_choice && typeof raw.tool_choice === "object"
      ? (raw.tool_choice as { disable_parallel_tool_use?: unknown }).disable_parallel_tool_use === true
      : false,
    names,
  );

  return {
    model: raw.model.trim(),
    modelParams: parseModelParams(raw),
    stream: raw.stream === true,
    systemText: [parseSystem(raw.system), ...normalized.extraSystem].filter(Boolean).join("\n"),
    messages,
    tools,
    images,
    lastUser,
    continuation,
    toolChoice,
  };
}
