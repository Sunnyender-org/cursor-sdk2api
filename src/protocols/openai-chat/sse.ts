import type { ServerResponse } from "node:http";
import { toOpenAIErrorBody } from "../../errors.js";
import { writeDataFrame } from "../../server/http-util.js";

export function beginChatSse(res: ServerResponse, requestId: string, sessionId: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    "x-accel-buffering": "no",
    "x-cursor-session-id": sessionId,
  });
}

export function writeChatFrame(res: ServerResponse, data: unknown): void {
  writeDataFrame(res, data);
}

export function writeChatDone(res: ServerResponse): void {
  writeDataFrame(res, "[DONE]");
}

export function writeChatStreamError(res: ServerResponse, error: unknown, requestId: string): void {
  writeDataFrame(res, toOpenAIErrorBody(error, requestId));
  writeChatDone(res);
}
