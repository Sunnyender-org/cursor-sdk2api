import type { ServerResponse } from "node:http";
import { toOpenAIErrorBody } from "../../errors.js";
import { writeSse } from "../../server/http-util.js";

const nextSequenceByResponse = new WeakMap<ServerResponse, number>();

export function beginResponsesSse(res: ServerResponse, requestId: string, sessionId: string): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-request-id": requestId,
    "x-accel-buffering": "no",
    "x-cursor-session-id": sessionId,
  });
}

export function writeResponsesEvent(
  res: ServerResponse,
  event: string,
  data: Record<string, unknown>,
  sequence: number,
): void {
  writeSse(res, event, { ...data, sequence_number: sequence, type: event });
  nextSequenceByResponse.set(res, sequence + 1);
}

export function writeResponsesStreamError(
  res: ServerResponse,
  error: unknown,
  requestId: string,
  sequence?: number,
): void {
  const body = toOpenAIErrorBody(error, requestId);
  const resolvedSequence = sequence ?? nextSequenceByResponse.get(res) ?? 0;
  writeSse(res, "error", {
    type: "error",
    code: body.error.code,
    message: body.error.message,
    param: null,
    sequence_number: resolvedSequence,
  });
  nextSequenceByResponse.set(res, resolvedSequence + 1);
}
