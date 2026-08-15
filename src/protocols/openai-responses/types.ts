import type { ParsedMessages } from "../anthropic/types.js";

export interface ParsedResponses {
  parsed: ParsedMessages;
}

export type ResponsesStatus = "in_progress" | "completed" | "incomplete" | "failed";
