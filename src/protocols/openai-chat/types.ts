import type { ParsedMessages } from "../anthropic/types.js";

export interface ParsedChatCompletions {
  parsed: ParsedMessages;
  includeUsage: boolean;
}

export type ChatFinishReason = "stop" | "length" | "tool_calls";

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}
