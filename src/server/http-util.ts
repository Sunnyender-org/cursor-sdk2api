import type { IncomingMessage, ServerResponse } from "node:http";
import {
  GatewayError,
  httpStatusOf,
  invalidRequest,
  toOpenAIErrorBody,
  toPublicErrorBody,
} from "../errors.js";

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value;
}

export function requestPath(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  return url.pathname;
}

export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new GatewayError("invalid_request", "Request body too large", 413);
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw invalidRequest("Request body must be valid JSON");
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  requestId: string,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": requestId,
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, error: unknown, requestId: string): void {
  const body = toPublicErrorBody(error, requestId);
  sendJson(res, httpStatusOf(error), body, requestId);
}

export function sendOpenAIError(res: ServerResponse, error: unknown, requestId: string): void {
  sendJson(res, httpStatusOf(error), toOpenAIErrorBody(error, requestId), requestId);
}

export function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** OpenAI-style SSE: `data: ...\\n\\n` only, no Anthropic `event:` names. */
export function writeDataFrame(res: ServerResponse, data: unknown | "[DONE]"): void {
  if (data === "[DONE]") {
    res.write("data: [DONE]\n\n");
    return;
  }
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function clientAborted(req: IncomingMessage, res: ServerResponse): boolean {
  return req.aborted || req.destroyed || res.writableEnded || res.destroyed;
}

export function abortSignalFromRequest(req: IncomingMessage): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  req.once("close", () => {
    if (!req.complete) abort();
  });
  return controller.signal;
}
