import type { ServerResponse } from "node:http";
import { writeSse } from "../../server/http-util.js";
import { encodeMessage, encodeUsage } from "./encode.js";
import type { AnthropicContentBlock, AssistantTurn } from "./types.js";

export function beginSse(res: ServerResponse, requestId: string, sessionId?: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    "x-accel-buffering": "no",
    ...(sessionId ? { "x-cursor-session-id": sessionId } : {}),
  });
}

export function writeMessageStart(res: ServerResponse, turn: Pick<AssistantTurn, "messageId" | "model" | "sessionId">): void {
  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: turn.messageId,
      type: "message",
      role: "assistant",
      model: turn.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
      cursor_session_id: turn.sessionId,
    },
  });
}

export function writeTextDelta(res: ServerResponse, index: number, text: string, started: boolean): boolean {
  if (!started) {
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    });
  }
  if (text) {
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    });
  }
  return true;
}

export function writeThinkingDelta(res: ServerResponse, index: number, text: string, started: boolean): boolean {
  if (!started) {
    writeSse(res, "content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "thinking", thinking: "" },
    });
  }
  if (text) {
    writeSse(res, "content_block_delta", {
      type: "content_block_delta",
      index,
      delta: { type: "thinking_delta", thinking: text },
    });
  }
  return true;
}

export function writeToolUse(res: ServerResponse, index: number, block: Extract<AnthropicContentBlock, { type: "tool_use" }>): void {
  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
  });
  writeSse(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
  });
  writeSse(res, "content_block_stop", { type: "content_block_stop", index });
}

export function writeBlockStop(res: ServerResponse, index: number): void {
  writeSse(res, "content_block_stop", { type: "content_block_stop", index });
}

export function writeMessageStop(res: ServerResponse, turn: AssistantTurn): void {
  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: turn.stopReason, stop_sequence: null },
    usage: encodeUsage(turn),
  });
  writeSse(res, "message_stop", { type: "message_stop" });
}

export function writeSseError(res: ServerResponse, body: unknown): void {
  writeSse(res, "error", body);
}

export function writeCompletedTurn(res: ServerResponse, turn: AssistantTurn, requestId: string): void {
  beginSse(res, requestId, turn.sessionId);
  writeMessageStart(res, turn);
  let index = 0;
  for (const block of turn.blocks) {
    if (block.type === "text") {
      writeTextDelta(res, index, block.text, false);
      writeBlockStop(res, index);
      index += 1;
    } else if (block.type === "thinking") {
      writeThinkingDelta(res, index, block.thinking, false);
      writeBlockStop(res, index);
      index += 1;
    } else if (block.type === "tool_use") {
      writeToolUse(res, index, block);
      index += 1;
    }
  }
  writeMessageStop(res, turn);
  res.end();
}

export function replayAsJson(turn: AssistantTurn): Record<string, unknown> {
  return encodeMessage(turn);
}
