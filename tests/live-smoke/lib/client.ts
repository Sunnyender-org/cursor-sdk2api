import {
  containsOpaqueMarker,
  listToolUses,
  parseSse,
  pickErrorType,
  pickSessionId,
  pickUsage,
  sseShapeCounts,
  stopReasonOf,
  type SseEvent,
} from "./sse.js";

export interface GatewayResponse {
  status: number;
  error_type?: string;
  session_id?: string;
  stop_reason?: string;
  tool_uses: Array<{ id: string; name: string }>;
  usage?: Record<string, number>;
  duration_ms: number;
  first_event_ms?: number;
  sse_counts?: Record<string, number>;
  sse_events?: SseEvent[];
  marker_hit: boolean;
  reason_class?: "region_unsupported";
  raw: unknown;
}

export async function gatewayGet(
  baseUrl: string,
  path: string,
  apiKey: string,
  timeoutMs: number,
): Promise<{ status: number; json: unknown; duration_ms: number; error_type?: string }> {
  const started = Date.now();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await readJson(res);
  return {
    status: res.status,
    json,
    duration_ms: Date.now() - started,
    error_type: pickErrorType(json),
  };
}

export async function postMessages(input: {
  baseUrl: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
  sessionId?: string;
  extraHeaders?: Record<string, string>;
  marker?: string;
}): Promise<GatewayResponse> {
  const headers = new Headers({
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    ...(input.extraHeaders ?? {}),
  });
  if (input.sessionId) headers.set("x-cursor-session-id", input.sessionId);
  const started = Date.now();
  const res = await fetch(`${input.baseUrl}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify(applyLiveModelSelection(input.body)),
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const stream = isEventStream(res);
  if (stream) {
    const { text, first_event_ms } = await readBodyIncremental(res, started);
    const events = parseSse(text);
    const startEvent = events.find((event) => event.event === "message_start");
    const json = reconstructFromSse(events);
    return {
      status: res.status,
      error_type: pickErrorType(json) ?? sseErrorType(events),
      session_id: pickSessionId(json) ?? pickSessionId((startEvent?.data as { message?: unknown })?.message),
      stop_reason: stopReasonOf(json),
      tool_uses: listToolUses(json),
      usage: pickUsage(json),
      duration_ms: Date.now() - started,
      first_event_ms,
      sse_counts: sseShapeCounts(events),
      sse_events: events,
      marker_hit: input.marker ? containsOpaqueMarker(json, input.marker) || text.includes(input.marker) : false,
      reason_class: classifyErrorReason(json),
      raw: json,
    };
  }
  const json = await readJson(res);
  return {
    status: res.status,
    error_type: pickErrorType(json),
    session_id: pickSessionId(json),
    stop_reason: stopReasonOf(json),
    tool_uses: listToolUses(json),
    usage: pickUsage(json),
    duration_ms: Date.now() - started,
    marker_hit: input.marker ? containsOpaqueMarker(json, input.marker) : false,
    reason_class: classifyErrorReason(json),
    raw: json,
  };
}

function classifyErrorReason(source: unknown): "region_unsupported" | undefined {
  if (!source || typeof source !== "object") return undefined;
  const error = (source as { error?: { message?: unknown } }).error;
  if (typeof error?.message !== "string") return undefined;
  return /not supported in your region|model not available/i.test(error.message) ? "region_unsupported" : undefined;
}

export function applyLiveModelSelection(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const raw = body as Record<string, unknown>;
  if (raw.model !== "grok-4.6" || raw.reasoning_effort !== undefined) return body;
  return { ...raw, reasoning_effort: "xhigh" };
}

function isEventStream(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/event-stream");
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { unparsed: true };
  }
}

async function readBodyIncremental(
  res: Response,
  started: number,
): Promise<{ text: string; first_event_ms?: number }> {
  if (!res.body) {
    const text = await res.text();
    return { text, first_event_ms: Date.now() - started };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let first_event_ms: number | undefined;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && first_event_ms === undefined) first_event_ms = Date.now() - started;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return { text, first_event_ms };
}

function reconstructFromSse(events: SseEvent[]): unknown {
  const start = events.find((event) => event.event === "message_start")?.data as
    | { message?: Record<string, unknown> }
    | undefined;
  const message = { ...(start?.message ?? { type: "message", role: "assistant", content: [] }) };
  const content: Array<Record<string, unknown>> = [];
  const open = new Map<number, Record<string, unknown>>();
  for (const event of events) {
    const data = event.data as Record<string, unknown> | null;
    if (!data) continue;
    if (event.event === "content_block_start" && data.content_block && typeof data.index === "number") {
      const block = { ...(data.content_block as Record<string, unknown>) };
      open.set(data.index, block);
      content[data.index] = block;
    } else if (event.event === "content_block_delta" && typeof data.index === "number") {
      const block = open.get(data.index) ?? { type: "text", text: "" };
      const delta = data.delta as { type?: string; text?: string; thinking?: string } | undefined;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        block.text = `${typeof block.text === "string" ? block.text : ""}${delta.text}`;
        block.type = "text";
      }
      if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = `${typeof block.thinking === "string" ? block.thinking : ""}${delta.thinking}`;
        block.type = "thinking";
      }
      open.set(data.index, block);
      content[data.index] = block;
    } else if (event.event === "message_delta") {
      const delta = data.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) message.stop_reason = delta.stop_reason;
      if (data.usage) message.usage = data.usage;
    } else if (event.event === "error") {
      return data;
    }
  }
  message.content = content.filter(Boolean);
  return message;
}

function sseErrorType(events: SseEvent[]): string | undefined {
  const err = events.find((event) => event.event === "error");
  return err ? pickErrorType(err.data) : undefined;
}

export function liveTools(): Array<Record<string, unknown>> {
  return [
    {
      name: "live_alpha",
      description: "Record token A. Call when instructed.",
      input_schema: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      },
    },
    {
      name: "live_beta",
      description: "Record token B. Call when instructed.",
      input_schema: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
      },
    },
  ];
}

export function claudeCodeHeaders(): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "user-agent": "claude-cli/live-smoke",
  };
}
