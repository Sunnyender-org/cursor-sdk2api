import { digestJson, sha256Hex, stableStringify } from "../digest.js";
import { asBlocks, collectImages } from "../protocols/anthropic/parse.js";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicTool,
  ParsedMessages,
} from "../protocols/anthropic/types.js";
import type { ToolChoicePolicy } from "../protocols/tool-choice.js";

export const CURSOR_AGENT_TURN_VERSION = 1;
export const CURSOR_AGENT_ROUTE = "cursor-agent";

export interface CursorAgentTurn {
  version: number;
  sourceProtocol: string;
  stream: boolean;
  tenantScope: string;
  channelId: number;
  route: string;
  originalModel: string;
  effectiveModel: string;
  system: string;
  conversation: AnthropicMessage[];
  tools: AnthropicTool[];
  toolChoice: ToolChoicePolicy | null;
  currentTurn: {
    text: string;
    images: Array<{ data: string; mimeType: string }>;
  };
  continuationToolIds: string[];
  lineage: {
    requestDigest: string;
    parentAssistantAnchor: string;
    turnIndex: number;
    toolCatalogDigest: string;
  };
}

export function effectiveCursorModel(
  model: string,
  modelParams: Array<{ id: string; value: string }>,
): string {
  return `${model}|${stableStringify(modelParams)}`;
}

export function serializedContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as AnthropicContentBlock;
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else if (item.type === "thinking" && typeof item.thinking === "string") {
      parts.push(item.thinking);
    } else if (item.type === "tool_use" && item.id && item.name) {
      parts.push(`TOOL_USE id=${item.id} name=${item.name} input=${JSON.stringify(item.input ?? {})}`);
    } else if (item.type === "tool_result" && item.tool_use_id) {
      parts.push(
        `TOOL_RESULT tool_use_id=${item.tool_use_id} is_error=${Boolean(item.is_error)} content=${JSON.stringify(stringifyUnknown(item.content))}`,
      );
    } else if (item.type === "image") {
      parts.push("IMAGE_ATTACHMENT");
    }
  }
  return parts.join("\n");
}

export function digestAssistantAnchor(content: unknown): string {
  return sha256Hex(serializedContent(content));
}

export function normalizeTools(tools: AnthropicTool[] | undefined): AnthropicTool[] {
  if (!Array.isArray(tools)) return [];
  const normalized: AnthropicTool[] = [];
  for (const tool of tools) {
    const name = String(tool?.name || "").trim();
    if (!name) continue;
    normalized.push({
      name,
      description: typeof tool.description === "string" ? tool.description : "",
      input_schema:
        tool.input_schema && typeof tool.input_schema === "object"
          ? tool.input_schema
          : { type: "object", properties: {} },
    });
  }
  return normalized;
}

export function digestToolCatalog(tools: AnthropicTool[] | undefined): string {
  return digestJson(normalizeTools(tools));
}

export function imageDigests(images: Array<{ data: string; mimeType: string }>): string[] {
  return images.map((image) => sha256Hex(`data:${image.mimeType}:${image.data}`));
}

export function textFromContent(content: string | AnthropicContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function currentTurnFromMessage(message: AnthropicMessage | undefined): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  if (!message) return { text: "", images: [] };
  const text =
    typeof message.content === "string"
      ? message.content.trim()
      : textFromContent(asBlocks(message.content)).trim();
  return {
    text,
    images: collectImages([message]),
  };
}

function lastUserIndex(conversation: AnthropicMessage[]): number {
  for (let index = conversation.length - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "user") return index;
  }
  return -1;
}

function parentAssistantMessage(
  conversation: AnthropicMessage[],
  userIndex: number,
): AnthropicMessage | null {
  for (let index = userIndex - 1; index >= 0; index -= 1) {
    if (conversation[index]?.role === "assistant") return conversation[index] ?? null;
  }
  return null;
}

export function digestCursorAgentTurnRequest(turn: CursorAgentTurn): string {
  return digestJson({
    effectiveModel: turn.effectiveModel,
    currentTurnText: turn.currentTurn.text,
    currentTurnImages: imageDigests(turn.currentTurn.images),
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
    toolChoice: turn.toolChoice,
    parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
    turnIndex: turn.lineage.turnIndex,
  });
}

export function cursorAgentTurnLineageKey(turn: CursorAgentTurn): string {
  return digestJson({
    tenantScope: turn.tenantScope,
    route: turn.route,
    channelId: turn.channelId,
    effectiveModel: turn.effectiveModel,
    parentAssistantAnchor: turn.lineage.parentAssistantAnchor,
    turnIndex: turn.lineage.turnIndex,
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
  });
}

export function nextCursorAgentTurnLineageKey(turn: CursorAgentTurn, assistantAnchor: string): string {
  return digestJson({
    tenantScope: turn.tenantScope,
    route: turn.route,
    channelId: turn.channelId,
    effectiveModel: turn.effectiveModel,
    parentAssistantAnchor: assistantAnchor,
    turnIndex: turn.lineage.turnIndex + 1,
    toolCatalogDigest: turn.lineage.toolCatalogDigest,
  });
}

export function cursorAgentTurnFromParsed(
  parsed: ParsedMessages,
  extras: { tenantScope: string; sourceProtocol?: string } = { tenantScope: "" },
): CursorAgentTurn {
  const conversation = parsed.messages;
  const userIndex = lastUserIndex(conversation);
  const currentMessage = userIndex >= 0 ? conversation[userIndex] : undefined;
  const parent = userIndex >= 0 ? parentAssistantMessage(conversation, userIndex) : null;
  const tools = normalizeTools(parsed.tools);
  const currentTurn = currentTurnFromMessage(currentMessage);
  const turnIndex = conversation.filter((message) => message.role === "user").length;
  const toolCatalogDigest = digestToolCatalog(tools);
  const turn: CursorAgentTurn = {
    version: CURSOR_AGENT_TURN_VERSION,
    sourceProtocol: extras.sourceProtocol || "messages",
    stream: parsed.stream,
    tenantScope: extras.tenantScope,
    channelId: 0,
    route: CURSOR_AGENT_ROUTE,
    originalModel: parsed.model,
    effectiveModel: effectiveCursorModel(parsed.model, parsed.modelParams),
    system: parsed.systemText,
    conversation,
    tools,
    toolChoice: parsed.toolChoice ?? null,
    currentTurn,
    continuationToolIds: (parsed.continuation ?? []).map((result) => result.toolUseId),
    lineage: {
      requestDigest: "",
      parentAssistantAnchor: parent ? digestAssistantAnchor(parent.content) : "",
      turnIndex,
      toolCatalogDigest,
    },
  };
  turn.lineage.requestDigest = digestCursorAgentTurnRequest(turn);
  return turn;
}

export function currentTurnSendPayload(turn: CursorAgentTurn): {
  text: string;
  images: Array<{ data: string; mimeType: string }>;
} {
  const images = turn.currentTurn.images;
  const text = turn.currentTurn.text.trim();
  return {
    text: text || " ",
    images,
  };
}

export function ordinaryReplayKey(turn: CursorAgentTurn): string {
  return `${cursorAgentTurnLineageKey(turn)}:${turn.lineage.requestDigest}`;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
