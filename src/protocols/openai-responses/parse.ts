import { invalidRequest } from "../../errors.js";
import { collectImages, parseContinuation, parseModelParams } from "../anthropic/parse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
} from "../anthropic/types.js";
import type { ParsedResponses } from "./types.js";
import { parseOpenAiToolChoice } from "../tool-choice.js";

export function parseResponsesRequest(body: unknown): ParsedResponses {
  if (!body || typeof body !== "object") {
    throw invalidRequest("JSON object body is required");
  }
  const raw = body as Record<string, unknown>;
  rejectUnsupported(raw);
  if (typeof raw.model !== "string" || !raw.model.trim()) {
    throw invalidRequest("model is required");
  }
  if (raw.input === undefined) {
    if (raw.messages !== undefined) {
      throw invalidRequest("Responses requires input; use /v1/chat/completions for messages");
    }
    throw invalidRequest("input is required");
  }

  const systemParts: string[] = [];
  if (raw.instructions !== undefined) {
    systemParts.push(parseInstructions(raw.instructions));
  }
  if (typeof raw.system === "string" && raw.system.trim()) {
    systemParts.push(raw.system);
  } else if (raw.system !== undefined && raw.instructions === undefined) {
    systemParts.push(parseInstructions(raw.system));
  } else if (raw.system !== undefined && typeof raw.system !== "string") {
    throw invalidRequest("system must be a string if provided");
  }

  const parsedInput = parseInput(raw.input);
  systemParts.push(...parsedInput.systemParts);
  const messages = parsedInput.messages;
  const tools = Array.isArray(raw.tools) ? raw.tools.map(parseResponsesTool) : [];
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
    "Responses",
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
  };
}

function rejectUnsupported(raw: Record<string, unknown>): void {
  if (raw.previous_response_id != null && raw.previous_response_id !== "") {
    throw invalidRequest(
      "previous_response_id is not supported; use function_call_output.call_id to resume a pending tool turn, or x-cursor-session-id for a completed follow-up",
    );
  }
  if (raw.store === true) {
    throw invalidRequest("store=true is not supported");
  }
  if (raw.background === true) {
    throw invalidRequest("background mode is not supported");
  }
  if (raw.conversation !== undefined && raw.conversation !== null) {
    throw invalidRequest("conversation is not supported");
  }
  if (raw.include !== undefined && raw.include !== null) {
    if (!Array.isArray(raw.include)) {
      throw invalidRequest("include must be an array if provided");
    }
    for (const item of raw.include) {
      if (item !== "reasoning.encrypted_content") {
        throw invalidRequest(`unsupported include expansion: ${String(item)}`);
      }
    }
    // Grok requests encrypted reasoning for compatibility. Cursor SDK does not
    // expose that opaque blob, so this known optional expansion is accepted but omitted.
  }
  if (raw.text !== undefined) {
    const text = raw.text;
    if (!text || typeof text !== "object" || Array.isArray(text)) {
      throw invalidRequest("text must be an object if provided");
    }
    const format = (text as { format?: unknown }).format;
    if (format !== undefined) {
      if (!format || typeof format !== "object" || Array.isArray(format)) {
        throw invalidRequest("text.format must be an object if provided");
      }
      // Codex / sub2api send json_schema (and other format types). Cursor SDK
      // does not enforce structured output, so this known optional field is
      // accepted but omitted.
    }
  }
}

function parseInstructions(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (part && typeof part === "object") {
          const raw = part as Record<string, unknown>;
          if (raw.type === "input_text" || raw.type === "text" || raw.type === "output_text") {
            return typeof raw.text === "string" ? raw.text : "";
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  throw invalidRequest("instructions must be a string or text part array");
}

function parseResponsesTool(value: unknown): AnthropicTool {
  if (!value || typeof value !== "object") throw invalidRequest("tool must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.type !== "function") {
    throw invalidRequest(
      `unsupported Responses tool type: ${String(raw.type)}; hosted tools (web_search, file_search, computer, shell, apply_patch) are not implemented`,
    );
  }
  const nested = raw.function && typeof raw.function === "object" ? (raw.function as Record<string, unknown>) : undefined;
  const name = typeof raw.name === "string" ? raw.name : typeof nested?.name === "string" ? nested.name : undefined;
  if (!name || !/^[a-zA-Z0-9_-]{1,128}$/.test(name)) {
    throw invalidRequest("tool name must match [a-zA-Z0-9_-]{1,128}");
  }
  const description =
    typeof raw.description === "string"
      ? raw.description
      : typeof nested?.description === "string"
        ? nested.description
        : undefined;
  const parameters = raw.parameters ?? nested?.parameters;
  return {
    name,
    description,
    input_schema:
      parameters && typeof parameters === "object"
        ? (parameters as Record<string, unknown>)
        : { type: "object", properties: {} },
  };
}

function parseInput(input: unknown): { messages: AnthropicMessage[]; systemParts: string[] } {
  if (typeof input === "string") {
    if (!input.trim()) throw invalidRequest("input must be a non-empty string or item array");
    return { messages: [{ role: "user", content: input }], systemParts: [] };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest("input must be a non-empty string or item array");
  }
  const messages: AnthropicMessage[] = [];
  const systemParts: string[] = [];
  let pendingResults: Extract<AnthropicContentBlock, { type: "tool_result" }>[] = [];
  let pendingAssistant: AnthropicContentBlock[] = [];

  const flushResults = () => {
    if (pendingResults.length === 0) return;
    messages.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };
  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return;
    messages.push(packAssistant(pendingAssistant));
    pendingAssistant = [];
  };

  for (const item of input) {
    if (!item || typeof item !== "object") throw invalidRequest("each input item must be an object");
    const raw = item as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : inferItemType(raw);

    if (type === "additional_tools") {
      // Codex Lite advertises hosted/function tools as an input item. Nested
      // hosted tools are not lifted into top-level tools; the item is skipped.
      continue;
    }

    if (type === "function_call_output") {
      flushAssistant();
      pendingResults.push(parseFunctionCallOutput(raw));
      continue;
    }

    flushResults();

    if (type === "function_call") {
      pendingAssistant.push(parseFunctionCall(raw));
      continue;
    }
    if (type === "reasoning") {
      const thinking = parseReasoningText(raw);
      if (thinking) pendingAssistant.push({ type: "thinking", thinking });
      continue;
    }
    if (type === "input_text") {
      flushAssistant();
      if (typeof raw.text !== "string") throw invalidRequest("input_text requires text");
      messages.push({ role: "user", content: raw.text });
      continue;
    }
    if (type === "message" || type === "easy_input_message") {
      flushAssistant();
      pushMessageItem(messages, systemParts, raw);
      continue;
    }
    throw invalidRequest(`unsupported input item type: ${String(type)}`);
  }

  flushResults();
  flushAssistant();
  if (messages.length === 0) {
    throw invalidRequest("input must include a user message or function_call_output");
  }
  return { messages, systemParts };
}

function pushMessageItem(
  messages: AnthropicMessage[],
  systemParts: string[],
  raw: Record<string, unknown>,
): void {
  const role = raw.role;
  if (role === "system" || role === "developer") {
    const text = stringifyMessageText(raw.content);
    if (text) systemParts.push(text);
    return;
  }
  if (role === "user" || role === undefined) {
    messages.push(parseUserItem(raw));
    return;
  }
  if (role === "assistant") {
    messages.push(parseAssistantItem(raw));
    return;
  }
  throw invalidRequest(`unsupported input message role: ${String(role)}`);
}

function inferItemType(raw: Record<string, unknown>): string {
  if (raw.role !== undefined) return "message";
  if (raw.call_id !== undefined && raw.output !== undefined) return "function_call_output";
  if (raw.call_id !== undefined && raw.name !== undefined) return "function_call";
  throw invalidRequest("input item must include type");
}

function parseFunctionCallOutput(
  raw: Record<string, unknown>,
): Extract<AnthropicContentBlock, { type: "tool_result" }> {
  if (typeof raw.call_id !== "string" || !raw.call_id.trim()) {
    throw invalidRequest("function_call_output must include call_id");
  }
  return {
    type: "tool_result",
    tool_use_id: raw.call_id,
    content: stringifyResponsesToolOutput(raw.output),
    is_error: raw.is_error === true || raw.status === "incomplete",
  };
}

function stringifyResponsesToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) {
    throw invalidRequest("function_call_output.output must be a string or text content array");
  }
  return output
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw invalidRequest("function_call_output.output array items must be text content objects");
      }
      const raw = part as Record<string, unknown>;
      if (raw.type !== "input_text" && raw.type !== "output_text" && raw.type !== "text") {
        throw invalidRequest(
          `function_call_output.output must contain only text content; unsupported type: ${String(raw.type)}`,
        );
      }
      if (typeof raw.text !== "string") throw invalidRequest(`${String(raw.type)} tool output requires text`);
      return raw.text;
    })
    .join("\n");
}

function parseFunctionCall(raw: Record<string, unknown>): Extract<AnthropicContentBlock, { type: "tool_use" }> {
  if (typeof raw.call_id !== "string" || !raw.call_id.trim()) {
    throw invalidRequest("function_call must include call_id");
  }
  if (typeof raw.name !== "string" || !raw.name) {
    throw invalidRequest("function_call must include name");
  }
  return {
    type: "tool_use",
    id: raw.call_id,
    name: raw.name,
    input: parseToolArguments(raw.arguments),
  };
}

function parseToolArguments(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return {};
  if (typeof value !== "string") {
    throw invalidRequest("function_call.arguments must be a JSON string");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidRequest("function_call.arguments must be valid JSON");
  }
}

function parseReasoningText(raw: Record<string, unknown>): string {
  if (typeof raw.content === "string") return raw.content;
  const parts: string[] = [];
  const summary = raw.summary;
  if (Array.isArray(summary)) {
    for (const part of summary) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
  }
  if (Array.isArray(raw.content)) {
    for (const part of raw.content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push((part as { text: string }).text);
      }
    }
  }
  return parts.join("");
}

function parseUserItem(raw: Record<string, unknown>): AnthropicMessage {
  const blocks = parseUserContent(raw.content);
  return { role: "user", content: blocks.length === 1 && blocks[0]?.type === "text" ? blocks[0].text : blocks };
}

function parseAssistantItem(raw: Record<string, unknown>): AnthropicMessage {
  const blocks = parseAssistantContent(raw.content);
  if (blocks.length === 0) return { role: "assistant", content: "" };
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return { role: "assistant", content: blocks[0].text };
  }
  return { role: "assistant", content: blocks };
}

function packAssistant(blocks: AnthropicContentBlock[]): AnthropicMessage {
  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return { role: "assistant", content: blocks[0].text };
  }
  return { role: "assistant", content: blocks };
}

function parseUserContent(content: unknown): AnthropicContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    throw invalidRequest("user content must be a string or content part array");
  }
  return content.map((part) => parseUserPart(part));
}

function parseUserPart(part: unknown): AnthropicContentBlock {
  if (!part || typeof part !== "object") throw invalidRequest("content part must be an object");
  const raw = part as Record<string, unknown>;
  if (raw.type === "input_text" || raw.type === "text" || raw.type === "output_text") {
    if (typeof raw.text !== "string") throw invalidRequest("text part requires text");
    return { type: "text", text: raw.text };
  }
  if (raw.type === "input_image" || raw.type === "image_url") {
    return parseInputImage(raw);
  }
  throw invalidRequest(`unsupported content part type: ${String(raw.type)}`);
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
    if (raw.type === "output_text" || raw.type === "text" || raw.type === "input_text") {
      if (typeof raw.text !== "string") throw invalidRequest("text part requires text");
      return { type: "text", text: raw.text };
    }
    throw invalidRequest(`unsupported assistant content part type: ${String(raw.type)}`);
  });
}

function parseInputImage(raw: Record<string, unknown>): AnthropicContentBlock {
  if (raw.file_id !== undefined && raw.file_id !== null) {
    throw invalidRequest("input_image.file_id is not supported; use a base64 data URL");
  }
  const url = readImageUrl(raw);
  if (!url) {
    throw invalidRequest("input_image requires image_url");
  }
  if (/^https?:\/\//i.test(url) || url.startsWith("//")) {
    throw invalidRequest("input_image.image_url must be a base64 data URL; remote URLs are not fetched");
  }
  const parsed = parseDataUrl(url);
  if (!parsed) {
    throw invalidRequest("input_image.image_url must be a base64 data URL; remote URLs are not fetched");
  }
  return { type: "image", source: { type: "base64", media_type: parsed.mediaType, data: parsed.data } };
}

function readImageUrl(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.image_url === "string") return raw.image_url;
  if (raw.image_url && typeof raw.image_url === "object") {
    const url = (raw.image_url as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  if (typeof raw.image === "string") return raw.image;
  return undefined;
}

function parseDataUrl(url: string): { mediaType: string; data: string } | undefined {
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(url.trim());
  if (!match) return undefined;
  return {
    mediaType: match[1]?.trim() || "image/png",
    data: (match[2] ?? "").replace(/\s+/g, ""),
  };
}

function stringifyMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object") {
          const raw = part as { type?: string; text?: unknown };
          if (raw.type === "input_text" || raw.type === "text" || raw.type === "output_text") {
            return typeof raw.text === "string" ? raw.text : "";
          }
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  throw invalidRequest("message content must be a string or text part array");
}
