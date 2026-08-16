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

  const messages = raw.messages.map(parseMessage);
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
    systemText: parseSystem(raw.system),
    messages,
    tools,
    images,
    lastUser,
    continuation,
    toolChoice,
  };
}

export function parseModelParams(raw: Record<string, unknown>): Array<{ id: string; value: string }> {
  const params = new Map<string, string>();
  const explicit = raw.cursor_model_params;
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || explicit.length > 16) {
      throw invalidRequest("cursor_model_params must be an array with at most 16 entries");
    }
    for (const item of explicit) {
      if (!item || typeof item !== "object") {
        throw invalidRequest("each cursor_model_params entry must be an object");
      }
      const value = item as Record<string, unknown>;
      if (typeof value.id !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)) {
        throw invalidRequest("cursor_model_params id must match [a-zA-Z0-9_-]{1,64}");
      }
      if (typeof value.value !== "string" || value.value.length < 1 || value.value.length > 128) {
        throw invalidRequest("cursor_model_params value must be a non-empty string up to 128 characters");
      }
      if (params.has(value.id)) throw invalidRequest(`duplicate cursor model parameter: ${value.id}`);
      params.set(value.id, value.value);
    }
  }

  const reasoning = raw.reasoning as Record<string, unknown> | undefined;
  const effort =
    typeof raw.reasoning_effort === "string"
      ? raw.reasoning_effort
      : reasoning && typeof reasoning.effort === "string"
        ? reasoning.effort
        : undefined;
  if (effort) {
    if (effort.length > 128) throw invalidRequest("reasoning_effort is too long");
    const existing = params.get("effort");
    if (existing && existing !== effort) {
      throw invalidRequest("reasoning_effort conflicts with cursor_model_params effort");
    }
    params.set("effort", effort);
  }

  return [...params.entries()]
    .map(([id, value]) => ({ id, value }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function parseMessage(value: unknown): AnthropicMessage {
  if (!value || typeof value !== "object") throw invalidRequest("each message must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.role !== "user" && raw.role !== "assistant") {
    throw invalidRequest("message.role must be user or assistant");
  }
  if (typeof raw.content === "string") {
    return { role: raw.role, content: raw.content };
  }
  if (!Array.isArray(raw.content)) {
    throw invalidRequest("message.content must be a string or content block array");
  }
  return { role: raw.role, content: raw.content.map(parseBlock) };
}

function parseBlock(value: unknown): AnthropicContentBlock {
  if (!value || typeof value !== "object") throw invalidRequest("content block must be an object");
  const raw = value as Record<string, unknown>;
  switch (raw.type) {
    case "text":
      if (typeof raw.text !== "string") throw invalidRequest("text block requires text");
      return { type: "text", text: raw.text };
    case "thinking":
      if (typeof raw.thinking !== "string") throw invalidRequest("thinking block requires thinking");
      return {
        type: "thinking",
        thinking: raw.thinking,
        ...(typeof raw.signature === "string" ? { signature: raw.signature } : {}),
      };
    case "image":
      return parseImage(raw);
    case "tool_use":
      if (typeof raw.id !== "string" || typeof raw.name !== "string") {
        throw invalidRequest("tool_use requires id and name");
      }
      return { type: "tool_use", id: raw.id, name: raw.name, input: raw.input ?? {} };
    case "tool_result":
      if (typeof raw.tool_use_id !== "string" || !raw.tool_use_id) {
        throw invalidRequest("tool_result requires tool_use_id");
      }
      return {
        type: "tool_result",
        tool_use_id: raw.tool_use_id,
        content: raw.content,
        is_error: raw.is_error === true,
      };
    default:
      throw invalidRequest(`unsupported content block type: ${String(raw.type)}`);
  }
}

function parseImage(raw: Record<string, unknown>): AnthropicContentBlock {
  const source = raw.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") throw invalidRequest("image block requires source");
  if (source.type === "base64") {
    if (typeof source.media_type !== "string" || typeof source.data !== "string") {
      throw invalidRequest("base64 image requires media_type and data");
    }
    return { type: "image", source: { type: "base64", media_type: source.media_type, data: source.data } };
  }
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image", source: { type: "url", url: source.url } };
  }
  throw invalidRequest("unsupported image source");
}

function parseTool(value: unknown): AnthropicTool {
  if (!value || typeof value !== "object") throw invalidRequest("tool must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.name)) {
    throw invalidRequest("tool.name must match [a-zA-Z0-9_-]{1,128}");
  }
  return {
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : undefined,
    input_schema:
      raw.input_schema && typeof raw.input_schema === "object"
        ? (raw.input_schema as Record<string, unknown>)
        : { type: "object", properties: {} },
  };
}

function parseSystem(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          return String((block as { text?: string }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  throw invalidRequest("system must be a string or text block array");
}

export function parseContinuation(lastUser: AnthropicMessage): ParsedToolResult[] | undefined {
  const blocks = asBlocks(lastUser.content);
  const hasToolResult = blocks.some((block) => block.type === "tool_result");
  if (!hasToolResult) return undefined;
  const mixed = blocks.some((block) => block.type !== "tool_result");
  if (mixed) {
    throw invalidRequest("mixed new text and tool_result in the latest user turn is not allowed");
  }
  return blocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "tool_result" }> => block.type === "tool_result")
    .map((block) => ({
      toolUseId: block.tool_use_id,
      content: stringifyToolResult(block.content),
      isError: block.is_error === true,
    }));
}

export function asBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content;
}

export function stringifyToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
          return String((block as { text?: string }).text ?? "");
        }
        return JSON.stringify(block);
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function renderPrompt(parsed: ParsedMessages): { text: string; images: Array<{ data: string; mimeType: string }> } {
  const parts: string[] = [];
  if (parsed.tools.length > 0) {
    parts.push(
      [
        "HARNESS TOOL CONTEXT:",
        "The custom MCP tools execute in the API caller's environment, not in the Cursor SDK runtime workspace.",
        "Never use the SDK runtime cwd in tool arguments. Treat workspace metadata supplied by the client as authoritative.",
        "Prefer relative paths when the tool schema allows them. If a tool requires an absolute path, resolve it against the client's workspace path.",
      ].join("\n"),
    );
  }
  if (parsed.systemText) parts.push(`System:\n${parsed.systemText}`);
  const messages = parsed.continuation ? parsed.messages.slice(0, -1) : parsed.messages;
  for (const message of messages) {
    const text = asBlocks(message.content)
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "thinking") return `[thinking]\n${block.thinking}`;
        if (block.type === "tool_use") {
          return `[tool_use ${block.name} ${block.id}]`;
        }
        if (block.type === "tool_result") {
          return `[tool_result ${block.tool_use_id}]`;
        }
        if (block.type === "image") return "[image]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
    if (text) parts.push(`${message.role}:\n${text}`);
  }
  const directive = toolChoiceDirective(parsed.toolChoice, parsed.tools.length > 0);
  if (directive) parts.push(directive);
  return { text: parts.join("\n\n") || " ", images: parsed.images };
}

export function collectImages(messages: AnthropicMessage[]): Array<{ data: string; mimeType: string }> {
  const images: Array<{ data: string; mimeType: string }> = [];
  for (const message of messages) {
    for (const block of asBlocks(message.content)) {
      if (block.type === "image" && block.source.type === "base64") {
        images.push({ data: block.source.data, mimeType: block.source.media_type });
      }
    }
  }
  return images;
}

export function isAnthropicMessagesRequest(value: unknown): value is AnthropicMessagesRequest {
  return Boolean(value && typeof value === "object");
}
