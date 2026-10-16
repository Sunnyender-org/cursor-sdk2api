import type { AssistantTurn } from "./types.js";

export function encodeMessage(turn: AssistantTurn, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: turn.messageId,
    type: "message",
    role: "assistant",
    model: turn.model,
    content: turn.blocks.map((block) => block.type === "tool_use"
      ? { type: block.type, id: block.id, name: block.name, input: block.input }
      : block),
    stop_reason: turn.stopReason,
    stop_sequence: null,
    usage: encodeUsage(turn),
    cursor_session_id: turn.sessionId,
    ...(turn.usage.usage_deferred ? { usage_deferred: true } : {}),
    ...(turn.usage.usage_status ? { usage_status: turn.usage.usage_status } : {}),
    ...extra,
  };
}

export function encodeUsage(turn: AssistantTurn): Record<string, unknown> {
  // Cursor's SDK reports `inputTokens` as the TOTAL prompt size, with
  // cache_read/cache_creation as SUBSETS of it. Anthropic semantics treat the
  // cache fields as additive to input_tokens, so emitting the total here makes
  // clients that sum them (e.g. Claude Code context accounting) roughly double
  // the real context. Subtract the cached portions to keep the sum correct.
  const cacheRead = turn.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = turn.usage.cache_creation_input_tokens ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: Math.max(0, turn.usage.input_tokens - cacheRead - cacheWrite),
    output_tokens: turn.usage.output_tokens,
  };
  if (typeof turn.usage.cache_creation_input_tokens === "number") {
    usage.cache_creation_input_tokens = turn.usage.cache_creation_input_tokens;
  }
  if (typeof turn.usage.cache_read_input_tokens === "number") {
    usage.cache_read_input_tokens = turn.usage.cache_read_input_tokens;
  }
  return usage;
}
