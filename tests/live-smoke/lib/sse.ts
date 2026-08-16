export interface SseEvent {
  event: string;
  data: unknown;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    let parsed: unknown = null;
    if (data) {
      try {
        parsed = JSON.parse(data);
      } catch {
        parsed = { unparsed: true };
      }
    }
    events.push({ event, data: parsed });
  }
  return events;
}

export function sseShapeCounts(events: SseEvent[]): Record<string, number> {
  const counts: Record<string, number> = {
    events: events.length,
    message_start: 0,
    message_stop: 0,
    message_delta: 0,
    content_block_start: 0,
    content_block_delta: 0,
    content_block_stop: 0,
    text_deltas: 0,
    thinking_deltas: 0,
    errors: 0,
  };
  for (const item of events) {
    if (item.event in counts) counts[item.event] = (counts[item.event] ?? 0) + 1;
    const payload = item.data as { type?: string; delta?: { type?: string } } | null;
    if (item.event === "content_block_delta" && payload?.delta?.type === "text_delta") {
      counts.text_deltas = (counts.text_deltas ?? 0) + 1;
    }
    if (item.event === "content_block_delta" && payload?.delta?.type === "thinking_delta") {
      counts.thinking_deltas = (counts.thinking_deltas ?? 0) + 1;
    }
    if (item.event === "error") counts.errors = (counts.errors ?? 0) + 1;
  }
  return counts;
}

export function sseShapeOk(counts: Record<string, number>): boolean {
  return (counts.message_start ?? 0) >= 1 && (counts.message_stop ?? 0) >= 1 && (counts.content_block_start ?? 0) + (counts.content_block_delta ?? 0) >= 1;
}

export function pickUsage(source: unknown): Record<string, number> | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = source as Record<string, unknown>;
  const usage = (raw.usage && typeof raw.usage === "object" ? raw.usage : raw) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function pickErrorType(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = source as { type?: string; error?: { type?: string } };
  if (raw.type !== "error") return undefined;
  if (raw.error && typeof raw.error.type === "string") return raw.error.type;
  return "error";
}

export function pickSessionId(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = source as { cursor_session_id?: string; message?: { cursor_session_id?: string } };
  if (typeof raw.cursor_session_id === "string") return raw.cursor_session_id;
  if (typeof raw.message?.cursor_session_id === "string") return raw.message.cursor_session_id;
  return undefined;
}

export function listToolUses(source: unknown): Array<{ id: string; name: string }> {
  const blocks = extractBlocks(source);
  const out: Array<{ id: string; name: string }> = [];
  for (const block of blocks) {
    if (block && block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      out.push({ id: block.id, name: block.name });
    }
  }
  return out;
}

export function stopReasonOf(source: unknown): string | undefined {
  if (!source || typeof source !== "object") return undefined;
  const raw = source as { stop_reason?: string };
  return typeof raw.stop_reason === "string" ? raw.stop_reason : undefined;
}

export function extractBlocks(source: unknown): Array<{ type?: string; id?: string; name?: string; text?: string }> {
  if (!source || typeof source !== "object") return [];
  const raw = source as { content?: unknown };
  return Array.isArray(raw.content) ? (raw.content as Array<{ type?: string; id?: string; name?: string; text?: string }>) : [];
}

export function containsOpaqueMarker(source: unknown, marker: string): boolean {
  if (!marker) return false;
  try {
    return JSON.stringify(source).includes(marker);
  } catch {
    return false;
  }
}
