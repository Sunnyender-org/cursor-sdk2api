export type AnthropicRole = "user" | "assistant";

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: unknown;
      is_error?: boolean;
    };

export interface AnthropicMessage {
  role: AnthropicRole;
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens?: number;
  system?: string | Array<{ type: "text"; text: string }>;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
  thinking?: unknown;
  reasoning_effort?: string;
  cursor_model_params?: Array<{ id: string; value: string }>;
}

export interface UsageView {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
  usage_deferred?: boolean;
  usage_status?: "sdk" | "unavailable" | "deferred";
}

export interface AssistantTurn {
  messageId: string;
  sessionId: string;
  model: string;
  stopReason: "end_turn" | "tool_use" | "max_tokens";
  blocks: AnthropicContentBlock[];
  usage: UsageView;
}

export interface ParsedToolResult {
  toolUseId: string;
  content: string;
  isError: boolean;
}

export interface ParsedMessages {
  model: string;
  modelParams: Array<{ id: string; value: string }>;
  stream: boolean;
  systemText: string;
  messages: AnthropicMessage[];
  tools: AnthropicTool[];
  images: Array<{ data: string; mimeType: string }>;
  lastUser: AnthropicMessage | undefined;
  continuation: ParsedToolResult[] | undefined;
  toolChoice: import("../tool-choice.js").ToolChoicePolicy;
}
