import type { AnthropicMessage, AnthropicTool, ParsedMessages } from "../anthropic/types.js";

export interface ResponsesCompaction {
  trigger: boolean;
  encryptedContent?: string;
  sourceDigest: string;
  sourceMessages: AnthropicMessage[];
  sourceTools: AnthropicTool[];
}

export interface ParsedResponses {
  parsed: ParsedMessages;
  compaction: ResponsesCompaction;
}

export type ResponsesStatus = "in_progress" | "completed" | "incomplete" | "failed";
