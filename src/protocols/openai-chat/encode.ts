import { chatCompletionId } from "../../ids.js";
import type { AnthropicContentBlock, AssistantTurn } from "../anthropic/types.js";
import type { ChatFinishReason, ChatToolCall } from "./types.js";

export function mapChatFinishReason(stopReason: AssistantTurn["stopReason"]): ChatFinishReason {
  if (stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  return "stop";
}

export function encodeChatUsage(turn: AssistantTurn): {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  usage_deferred?: boolean;
  usage_status?: "sdk" | "unavailable" | "deferred";
} {
  const prompt = turn.usage.input_tokens;
  const completion = turn.usage.output_tokens;
  const usage: ReturnType<typeof encodeChatUsage> = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
  if (typeof turn.usage.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = turn.usage.cache_creation_input_tokens;
  }
  if (typeof turn.usage.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = turn.usage.cache_read_input_tokens;
  }
  if (turn.usage.usage_deferred) usage.usage_deferred = true;
  if (turn.usage.usage_status) usage.usage_status = turn.usage.usage_status;
  return usage;
}

export function encodeChatToolCall(
  block: Extract<AnthropicContentBlock, { type: "tool_use" }>,
): ChatToolCall {
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      arguments: JSON.stringify(block.input ?? {}),
    },
  };
}

export function encodeChatCompletion(
  turn: AssistantTurn,
  created: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const text = turn.blocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("");
  const thinking = turn.blocks
    .filter((block): block is Extract<AnthropicContentBlock, { type: "thinking" }> => block.type === "thinking")
    .map((block) => block.thinking)
    .join("");
  const tools = turn.blocks.filter(
    (block): block is Extract<AnthropicContentBlock, { type: "tool_use" }> => block.type === "tool_use",
  );

  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || (tools.length > 0 ? null : ""),
  };
  if (thinking) message.reasoning_content = thinking;
  if (tools.length > 0) {
    message.tool_calls = tools.map(encodeChatToolCall);
  }

  return {
    id: chatCompletionId(turn.messageId),
    object: "chat.completion",
    created,
    model: turn.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapChatFinishReason(turn.stopReason),
      },
    ],
    usage: encodeChatUsage(turn),
    cursor_session_id: turn.sessionId,
    ...extra,
  };
}

export function encodeChatChunk(
  input: {
    id: string;
    created: number;
    model: string;
    delta?: Record<string, unknown>;
    finishReason?: ChatFinishReason | null;
    usage?: ReturnType<typeof encodeChatUsage>;
    emptyChoices?: boolean;
    extra?: Record<string, unknown>;
  },
): Record<string, unknown> {
  const chunk: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
  };
  if (input.emptyChoices) {
    chunk.choices = [];
  } else {
    chunk.choices = [
      {
        index: 0,
        delta: input.delta ?? {},
        finish_reason: input.finishReason ?? null,
      },
    ];
  }
  if (input.usage) chunk.usage = input.usage;
  if (input.extra) Object.assign(chunk, input.extra);
  return chunk;
}
