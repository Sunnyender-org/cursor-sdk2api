import { compactTranscriptDigest } from "../../core/compact-anchor.js";
import { invalidRequest } from "../../errors.js";
import { stableStringify } from "../../digest.js";
import { collectImages, parseContinuation, parseModelParams } from "../anthropic/parse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
} from "../anthropic/types.js";
import type { ParsedResponses } from "./types.js";
import { parseOpenAiToolChoice } from "../tool-choice.js";

const UNSUPPORTED_MEDIA_TYPES = new Set([
  "input_file",
  "input_audio",
  "input_video",
  "document",
  "audio",
  "video",
  "file",
]);

export function parseResponsesRequest(body: unknown): ParsedResponses {
  if (!body || typeof body !== "object") {
    throw invalidRequest("JSON object body is required");
  }
  const raw = body as Record<string, unknown>;
  const formatDirective = rejectUnsupported(raw);
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
  if (formatDirective) systemParts.push(formatDirective);
  const messages = parsedInput.messages;
  const tools = mergeResponseTools(
    Array.isArray(raw.tools) ? raw.tools.map(parseResponsesTool) : [],
    parsedInput.additionalTools,
  );
  const names = new Set(tools.flatMap((tool) => [tool.name, tool.sdk_name ?? tool.name]));

  if (messages.length === 0 && !parsedInput.compactionTrigger) {
    if (parsedInput.compactionEncryptedContent) {
      throw invalidRequest("input must include a user message after compact context, or a compaction_trigger");
    }
    throw invalidRequest("input must include a user message or function_call_output");
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const terminal = messages.at(-1);
  const continuation = terminal?.role === "user" ? parseContinuation(terminal) : undefined;
  const images = collectImages(messages);
  const toolChoice = parseOpenAiToolChoice(
    raw.tool_choice,
    raw.parallel_tool_calls === false,
    names,
    "Responses",
  );
  const systemText = systemParts.filter(Boolean).join("\n");

  return {
    parsed: {
      model: raw.model.trim(),
      modelParams: parseModelParams(raw),
      stream: raw.stream === true,
      systemText,
      messages,
      tools,
      images,
      lastUser,
      continuation,
      toolChoice,
    },
    compaction: {
      trigger: parsedInput.compactionTrigger,
      ...(parsedInput.compactionEncryptedContent
        ? { encryptedContent: parsedInput.compactionEncryptedContent }
        : {}),
      sourceDigest: compactTranscriptDigest({
        model: raw.model.trim(),
        systemText,
        messages: parsedInput.sourceMessages,
        tools,
      }),
      sourceMessages: parsedInput.sourceMessages,
      sourceTools: tools,
    },
  };
}

function rejectUnsupported(raw: Record<string, unknown>): string | undefined {
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
  if (raw.audio !== undefined) {
    throw invalidRequest("audio is not supported");
  }
  if (raw.video !== undefined) {
    throw invalidRequest("video is not supported");
  }
  if (raw.web_search_options !== undefined) {
    throw invalidRequest("web_search_options is not supported");
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
      const type = format && typeof format === "object" ? (format as { type?: unknown }).type : undefined;
      if (type === "text") return undefined;
      if (type !== "json_schema") {
        throw invalidRequest('text.format.type must be "text" or "json_schema"');
      }
      const schema = format as Record<string, unknown>;
      if (typeof schema.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(schema.name)) {
        throw invalidRequest("text.format json_schema requires a valid name");
      }
      if (!schema.schema || typeof schema.schema !== "object" || Array.isArray(schema.schema)) {
        throw invalidRequest("text.format json_schema requires a schema object");
      }
      return [
        "OUTPUT FORMAT:",
        `Return only valid JSON matching schema ${schema.name}. Do not use Markdown fences or add prose outside the JSON value.`,
        `JSON Schema: ${stableStringify(schema.schema)}`,
        schema.strict === true
          ? "The client requested strict schema adherence. The Cursor SDK has no native structured-output API, so follow this contract exactly."
          : "Follow this schema as closely as possible.",
      ].join("\n");
    }
  }
  return undefined;
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
  if (raw.type === "custom") {
    if (typeof raw.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(raw.name)) {
      throw invalidRequest("custom tool name must match [a-zA-Z0-9_-]{1,128}");
    }
    return {
      name: raw.name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      input_schema: {
        type: "object",
        properties: { input: { type: "string", description: "Freeform custom tool input" } },
        required: ["input"],
        additionalProperties: false,
      },
      tool_kind: "custom",
    };
  }
  if (raw.type !== "function") {
    throw invalidRequest(
      `unsupported Responses tool type: ${String(raw.type)}; hosted tools (web_search, file_search, x_search, computer, shell, apply_patch) are not implemented`,
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
    tool_kind: "function",
  };
}

function parseInput(input: unknown): {
  messages: AnthropicMessage[];
  sourceMessages: AnthropicMessage[];
  systemParts: string[];
  additionalTools: AnthropicTool[];
  compactionTrigger: boolean;
  compactionEncryptedContent?: string;
} {
  if (typeof input === "string") {
    if (!input.trim()) throw invalidRequest("input must be a non-empty string or item array");
    const messages = [{ role: "user" as const, content: input }];
    return {
      messages,
      sourceMessages: [...messages],
      systemParts: [],
      additionalTools: [],
      compactionTrigger: false,
    };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw invalidRequest("input must be a non-empty string or item array");
  }
  const messages: AnthropicMessage[] = [];
  const sourceMessages: AnthropicMessage[] = [];
  const systemParts: string[] = [];
  const additionalTools: AnthropicTool[] = [];
  let compactionTrigger = false;
  let compactionEncryptedContent: string | undefined;
  let pendingResults: Extract<AnthropicContentBlock, { type: "tool_result" }>[] = [];
  let pendingAssistant: AnthropicContentBlock[] = [];

  const pushMessage = (message: AnthropicMessage) => {
    sourceMessages.push(message);
    messages.push(message);
  };
  const flushResults = () => {
    if (pendingResults.length === 0) return;
    pushMessage({ role: "user", content: pendingResults });
    pendingResults = [];
  };
  const flushAssistant = () => {
    if (pendingAssistant.length === 0) return;
    pushMessage(packAssistant(pendingAssistant));
    pendingAssistant = [];
  };

  for (const item of input) {
    if (!item || typeof item !== "object") throw invalidRequest("each input item must be an object");
    const raw = item as Record<string, unknown>;
    const type = typeof raw.type === "string" ? raw.type : inferItemType(raw);
    rejectUnsupportedMediaType(type);

    if (type === "additional_tools") {
      if (!Array.isArray(raw.tools)) {
        throw invalidRequest("additional_tools.tools must be an array");
      }
      additionalTools.push(...raw.tools.flatMap(parseAdditionalTool));
      continue;
    }

    if (type === "compaction_trigger") {
      flushResults();
      flushAssistant();
      compactionTrigger = true;
      continue;
    }

    if (type === "compaction") {
      flushResults();
      flushAssistant();
      if (typeof raw.encrypted_content !== "string" || !raw.encrypted_content.trim()) {
        throw invalidRequest("compaction item must include encrypted_content");
      }
      compactionEncryptedContent = raw.encrypted_content.trim();
      messages.length = 0;
      continue;
    }

    if (type === "function_call_output" || type === "custom_tool_call_output") {
      flushAssistant();
      pendingResults.push(parseFunctionCallOutput(raw));
      continue;
    }

    flushResults();

    if (type === "function_call" || type === "custom_tool_call") {
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
      pushMessage({ role: "user", content: raw.text });
      continue;
    }
    if (type === "message" || type === "easy_input_message") {
      flushAssistant();
      const before = messages.length;
      pushMessageItem(messages, systemParts, raw);
      if (messages.length > before) {
        sourceMessages.push(messages[messages.length - 1]!);
      }
      continue;
    }
    throw invalidRequest(`unsupported input item type: ${String(type)}`);
  }

  flushResults();
  flushAssistant();
  return {
    messages,
    sourceMessages,
    systemParts,
    additionalTools,
    compactionTrigger,
    ...(compactionEncryptedContent ? { compactionEncryptedContent } : {}),
  };
}

function rejectUnsupportedMediaType(type: string): void {
  if (UNSUPPORTED_MEDIA_TYPES.has(type)) {
    throw invalidRequest(`${type} is not supported`);
  }
}

function parseAdditionalTool(value: unknown): AnthropicTool[] {
  if (!value || typeof value !== "object") {
    throw invalidRequest("each additional_tools entry must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (raw.type === "function" || raw.type === "custom") return [parseResponsesTool(raw)];
  if (raw.type === "namespace") return parseNamespaceTools(raw);
  throw invalidRequest(
    `unsupported additional_tools type: ${String(raw.type)}; only client-executed function, custom, and namespace tools are supported`,
  );
}

function parseNamespaceTools(raw: Record<string, unknown>): AnthropicTool[] {
  if (typeof raw.name !== "string" || !/^[a-zA-Z0-9_-]{1,96}$/.test(raw.name)) {
    throw invalidRequest("namespace tool requires a valid name");
  }
  if (!Array.isArray(raw.tools) || raw.tools.length === 0) {
    throw invalidRequest("namespace tool requires a non-empty tools array");
  }
  const namespace = raw.name;
  return raw.tools.map((child) => {
    const parsed = parseResponsesTool(child);
    const sdkName = qualifyNamespaceTool(namespace, parsed.name);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sdkName)) {
      throw invalidRequest(`qualified namespace tool name is invalid: ${sdkName}`);
    }
    return { ...parsed, sdk_name: sdkName, namespace };
  });
}

function qualifyNamespaceTool(namespace: string, name: string): string {
  if (name.startsWith("mcp__") || name.startsWith(`${namespace}__`)) return name;
  return `${namespace}__${name}`;
}

function mergeResponseTools(primary: AnthropicTool[], additional: AnthropicTool[]): AnthropicTool[] {
  const merged = new Map<string, AnthropicTool>();
  for (const tool of primary) {
    const key = tool.sdk_name ?? tool.name;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, tool);
      continue;
    }
    if (stableStringify(existing) !== stableStringify(tool)) {
      throw invalidRequest(`conflicting duplicate tool name: ${key}`);
    }
  }
  const seenAdditional = new Map<string, AnthropicTool>();
  for (const tool of additional) {
    const key = tool.sdk_name ?? tool.name;
    // Responses Lite may repeat a top-level declaration inside
    // additional_tools using a different representation (function/custom).
    // The top-level catalog is authoritative, matching Codex gateway behavior.
    if (merged.has(key)) continue;
    const existing = seenAdditional.get(key);
    if (existing && stableStringify(existing) !== stableStringify(tool)) {
      throw invalidRequest(`conflicting duplicate additional tool name: ${key}`);
    }
    if (!existing) seenAdditional.set(key, tool);
  }
  for (const [key, tool] of seenAdditional) merged.set(key, tool);
  return [...merged.values()];
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
    throw invalidRequest("tool call output must include call_id");
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
    throw invalidRequest("tool call must include call_id");
  }
  if (typeof raw.name !== "string" || !raw.name) {
    throw invalidRequest("tool call must include name");
  }
  return {
    type: "tool_use",
    id: raw.call_id,
    name: raw.name,
    input: raw.type === "custom_tool_call"
      ? { input: typeof raw.input === "string" ? raw.input : "" }
      : parseToolArguments(raw.arguments),
    ...(raw.type === "custom_tool_call" ? { tool_kind: "custom" as const } : {}),
    ...(typeof raw.namespace === "string" && raw.namespace ? { namespace: raw.namespace } : {}),
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
  const type = typeof raw.type === "string" ? raw.type : "";
  rejectUnsupportedMediaType(type);
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
    const type = typeof raw.type === "string" ? raw.type : "";
    rejectUnsupportedMediaType(type);
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
