import { invalidRequest } from "../../errors.js";
import { collectImages, parseContinuation, parseModelParams } from "../anthropic/parse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
} from "../anthropic/types.js";
import type { ParsedChatCompletions } from "./types.js";
import { parseOpenAiToolChoice } from "../tool-choice.js";

export function parseChatCompletionsRequest(body: unknown): ParsedChatCompletions {
  if (!body || typeof body !== "object") {
    throw invalidRequest("JSON object body is required");
  }
  const raw = body as Record<string, unknown>;
  rejectUnsupported(raw);
  if (typeof raw.model !== "string" || !raw.model.trim()) {
    throw invalidRequest("model is required");
  }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw invalidRequest("messages must be a non-empty array");
  }

  const systemParts: string[] = [];
  if (typeof raw.system === "string" && raw.system.trim()) {
    systemParts.push(raw.system);
  } else if (raw.system !== undefined) {
    throw invalidRequest("system must be a string if provided");
  }

  const messages: AnthropicMessage[] = [];
  let pendingResults: Extract<AnthropicContentBlock, { type: "tool_result" }>[] = [];
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const item of raw.messages) {
    if (!item || typeof item !== "object") throw invalidRequest("each message must be an object");
    const message = item as Record<string, unknown>;
    const role = message.role;
    if (role === "system" || role === "developer") {
      flushResults();
      const text = stringifyChatText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (role === "tool") {
      pendingResults.push(parseToolResultMessage(message));
      continue;
    }
    flushResults();
    if (role === "user") {
      messages.push(parseUserMessage(message));
      continue;
    }
    if (role === "assistant") {
      messages.push(parseAssistantMessage(message));
      continue;
    }
    throw invalidRequest(`unsupported message.role: ${String(role)}`);
  }
  flushResults();

  const tools = Array.isArray(raw.tools) ? raw.tools.map(parseChatTool) : [];
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw invalidRequest(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const continuation = lastUser ? parseContinuation(lastUser) : undefined;
  const images = collectImages(messages);
  const toolChoice = parseOpenAiToolChoice(
    raw.tool_choice,
    raw.parallel_tool_calls === false,
    names,
    "Chat Completions",
  );

  return {
    parsed: {
      model: raw.model.trim(),
      modelParams: parseModelParams(raw),
      stream: raw.stream === true,
      systemText: systemParts.filter(Boolean).join("\n"),
      messages,
      tools,
      images,
      lastUser,
      continuation,
      toolChoice,
    },
    includeUsage: readIncludeUsage(raw),
  };
}

function rejectUnsupported(raw: Record<string, unknown>): void {
  if ("n" in raw && raw.n !== 1) {
    throw invalidRequest("n must be 1");
  }
  if (raw.functions !== undefined) {
    throw invalidRequest("legacy functions is not supported; use tools");
  }
  if (raw.function_call !== undefined) {
    throw invalidRequest("legacy function_call is not supported");
  }
  if (raw.logprobs === true) {
    throw invalidRequest("logprobs is not supported");
  }
  if (raw.modalities !== undefined) {
    throw invalidRequest("modalities is not supported");
  }
  if (raw.audio !== undefined) {
    throw invalidRequest("audio is not supported");
  }
  if (raw.prediction !== undefined) {
    throw invalidRequest("prediction is not supported");
  }
  if (raw.web_search_options !== undefined) {
    throw invalidRequest("web_search_options is not supported");
  }
  if (raw.response_format !== undefined) {
    const format = raw.response_format;
    if (!format || typeof format !== "object" || (format as { type?: unknown }).type !== "text") {
      throw invalidRequest('response_format must be omitted or {type:"text"}');
    }
  }
  if (raw.stream_options !== undefined) {
    if (!raw.stream_options || typeof raw.stream_options !== "object" || Array.isArray(raw.stream_options)) {
      throw invalidRequest("stream_options must be an object");
    }
    const options = raw.stream_options as Record<string, unknown>;
    for (const key of Object.keys(options)) {
      if (key !== "include_usage") {
        throw invalidRequest("stream_options only supports include_usage");
      }
    }
    if (options.include_usage !== undefined && typeof options.include_usage !== "boolean") {
      throw invalidRequest("stream_options.include_usage must be a boolean");
    }
  }
}

function readIncludeUsage(raw: Record<string, unknown>): boolean {
  const options = raw.stream_options as Record<string, unknown> | undefined;
  return options?.include_usage === true;
}

function parseChatTool(value: unknown): AnthropicTool {
  if (!value || typeof value !== "object") throw invalidRequest("tool must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.type !== "function") {
    throw invalidRequest("tools[].type must be function");
  }
  const fn = raw.function as Record<string, unknown> | undefined;
  if (!fn || typeof fn !== "object") throw invalidRequest("tools[].function is required");
  if (typeof fn.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(fn.name)) {
    throw invalidRequest("tool name must match [a-zA-Z0-9_-]{1,128}");
  }
  return {
    name: fn.name,
    description: typeof fn.description === "string" ? fn.description : undefined,
    input_schema:
      fn.parameters && typeof fn.parameters === "object"
        ? (fn.parameters as Record<string, unknown>)
        : { type: "object", properties: {} },
  };
}

function parseUserMessage(raw: Record<string, unknown>): AnthropicMessage {
  const blocks = parseUserContent(raw.content);
  return { role: "user", content: blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks };
}

function parseAssistantMessage(raw: Record<string, unknown>): AnthropicMessage {
  const blocks: AnthropicContentBlock[] = [];
  if (typeof raw.reasoning_content === "string" && raw.reasoning_content) {
    blocks.push({ type: "thinking", thinking: raw.reasoning_content });
  }
  blocks.push(...parseAssistantContent(raw.content));
  const toolCalls = raw.tool_calls;
  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) throw invalidRequest("assistant.tool_calls must be an array");
    for (const call of toolCalls) blocks.push(parseToolCall(call));
  }
  if (blocks.length === 0) return { role: "assistant", content: "" };
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return { role: "assistant", content: blocks[0].text };
  }
  return { role: "assistant", content: blocks };
}

function parseToolResultMessage(
  raw: Record<string, unknown>,
): Extract<AnthropicContentBlock, { type: "tool_result" }> {
  if (typeof raw.tool_call_id !== "string" || !raw.tool_call_id) {
    throw invalidRequest("tool message requires tool_call_id");
  }
  return {
    type: "tool_result",
    tool_use_id: raw.tool_call_id,
    content: stringifyChatText(raw.content),
    is_error: raw.is_error === true,
  };
}

function parseToolCall(value: unknown): Extract<AnthropicContentBlock, { type: "tool_use" }> {
  if (!value || typeof value !== "object") throw invalidRequest("each tool_call must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.type !== undefined && raw.type !== "function") {
    throw invalidRequest('tool_calls[].type must be "function"');
  }
  if (typeof raw.id !== "string" || !raw.id) throw invalidRequest("tool_calls[].id is required");
  const fn = raw.function as Record<string, unknown> | undefined;
  if (!fn || typeof fn !== "object") throw invalidRequest("tool_calls[].function is required");
  if (typeof fn.name !== "string" || !fn.name) {
    throw invalidRequest("tool_calls[].function.name is required");
  }
  return {
    type: "tool_use",
    id: raw.id,
    name: fn.name,
    input: parseToolArguments(fn.arguments),
  };
}

function parseToolArguments(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") {
    throw invalidRequest("tool_calls.function.arguments must be a JSON string");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidRequest("tool_calls.function.arguments must be valid JSON");
  }
}

function parseUserContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    throw invalidRequest("user content must be a string or content part array");
  }
  return content.map((part) => {
    if (!part || typeof part !== "object") throw invalidRequest("content part must be an object");
    const raw = part as Record<string, unknown>;
    if (raw.type === "text") {
      if (typeof raw.text !== "string") throw invalidRequest("text part requires text");
      return { type: "text", text: raw.text };
    }
    if (raw.type === "image_url") {
      return parseImageUrlPart(raw);
    }
    throw invalidRequest(`unsupported content part type: ${String(raw.type)}`);
  });
}

function parseAssistantContent(content: unknown): AnthropicContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    throw invalidRequest("assistant content must be a string, null, or content part array");
  }
  return content.map((part) => {
    if (!part || typeof part !== "object") throw invalidRequest("content part must be an object");
    const raw = part as Record<string, unknown>;
    if (raw.type === "text") {
      if (typeof raw.text !== "string") throw invalidRequest("text part requires text");
      return { type: "text", text: raw.text };
    }
    throw invalidRequest(`unsupported assistant content part type: ${String(raw.type)}`);
  });
}

function parseImageUrlPart(raw: Record<string, unknown>): AnthropicContentBlock {
  const image = raw.image_url;
  const url =
    typeof image === "string"
      ? image
      : image && typeof image === "object"
        ? (image as { url?: unknown }).url
        : undefined;
  if (typeof url !== "string" || !url) {
    throw invalidRequest("image_url requires a url");
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("//")) {
    throw invalidRequest("image_url.url must be a base64 data URL; remote URLs are not fetched");
  }
  const parsed = parseDataUrl(url);
  if (!parsed) {
    throw invalidRequest("image_url.url must be a base64 data URL; remote URLs are not fetched");
  }
  return { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } };
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim());
  if (!match) return undefined;
  return {
    mediaType: match[1]?.trim() || "image/png",
    data: (match[2] ?? "").replace(/\s+/g, ""),
  };
}

function stringifyChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
          return String((part as { text?: string }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  throw invalidRequest("message content must be a string or text part array");
}
