import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, parseSse, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("non-stream text returns an assistant message", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello ", "world"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as {
    type: string;
    role: string;
    content: Array<{ type: string; text?: string }>;
    stop_reason: string;
    cursor_session_id: string;
  };
  expect(res.status).toBe(200);
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(body.type).toBe("message");
  expect(body.role).toBe("assistant");
  expect(body.stop_reason).toBe("end_turn");
  expect(body.content).toEqual([{ type: "text", text: "hello world" }]);
  expect(body.cursor_session_id).toMatch(/^ses_/);
  expect(ctx.sdk.lastAllowlist).toEqual([]);
});

test("keeps the public model id and forwards explicit Cursor model parameters", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "xhigh",
      cursor_model_params: [{ id: "fast", value: "false" }],
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.lastCreate?.modelId).toBe("grok-4.6");
  expect(ctx.sdk.lastCreate?.modelParams).toEqual([
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ]);
});

test("completed follow-up inherits model parameters and rejects an explicit change", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [{ type: "text", chunks: ["first"] }],
        [{ type: "text", chunks: ["second"] }],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "xhigh",
      max_tokens: 32,
      messages: [{ role: "user", content: "first" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const inherited = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "grok-4.6",
      max_tokens: 32,
      messages: [{ role: "user", content: "second" }],
    }),
  });
  expect(inherited.status).toBe(200);

  const changed = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "high",
      max_tokens: 32,
      messages: [{ role: "user", content: "third" }],
    }),
  });
  expect(changed.status).toBe(409);
  expect(((await changed.json()) as { error: { type: string } }).error.type).toBe("cursor_session_conflict");
});

test("conflicting model parameter extensions fail closed", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "xhigh",
      cursor_model_params: [{ id: "effort", value: "high" }],
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.status).toBe(400);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("stream text forwards incremental SSE deltas", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "thinking", chunks: ["hmm"] }, { type: "text", chunks: ["A", "B"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = parseSse(await res.text());
  expect(events[0]?.event).toBe("message_start");
  const deltas = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => event.data as { delta: { type: string; text?: string; thinking?: string } });
  expect(deltas.some((item) => item.delta.type === "thinking_delta" && item.delta.thinking === "hmm")).toBe(true);
  expect(deltas.filter((item) => item.delta.type === "text_delta").map((item) => item.delta.text)).toEqual(["A", "B"]);
  expect(events.at(-1)?.event).toBe("message_stop");
  const run = ctx.sdk.agents[0]?.runs[0];
  expect(run?.onDeltaCalls).toEqual([
    { type: "thinking-delta", text: "hmm" },
    { type: "text-delta", text: "A" },
    { type: "text-delta", text: "B" },
  ]);
  expect(run?.streamSnapshots).toEqual([
    { type: "thinking", text: "hmm" },
    { type: "assistant", text: "A" },
    { type: "assistant", text: "B" },
  ]);
  expect(run?.streamStarts).toBe(1);
});

test("onDelta chunks are not doubled by stream message snapshots", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello ", "world"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const events = parseSse(await res.text());
  const texts = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => (event.data as { delta: { type: string; text?: string } }).delta)
    .filter((delta) => delta.type === "text_delta")
    .map((delta) => delta.text);
  expect(texts).toEqual(["hello ", "world"]);
  expect(texts.join("")).toBe("hello world");
  expect(ctx.sdk.agents[0]?.runs[0]?.onDeltaCalls.map((item) => item.type)).toEqual([
    "text-delta",
    "text-delta",
  ]);
  expect(ctx.sdk.agents[0]?.runs[0]?.streamSnapshots).toHaveLength(2);
});

test("early onDelta before send() resolves is not lost", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["PRE", "POST"], early: true }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const events = parseSse(await res.text());
  const texts = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => (event.data as { delta?: { text?: string } }).delta?.text)
    .filter((text): text is string => Boolean(text));
  expect(texts).toEqual(["PRE", "POST"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.onDeltaCalls).toEqual([
    { type: "text-delta", text: "PRE" },
    { type: "text-delta", text: "POST" },
  ]);
});

test("SSE thinking then text uses strict start/delta/stop block order", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "thinking", chunks: ["hmm"] }, { type: "text", chunks: ["A", "B"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const events = parseSse(await res.text());
  const trace = events.map((event) => {
    const data = event.data as {
      index?: number;
      content_block?: { type?: string };
      delta?: { type?: string };
    };
    if (event.event === "content_block_start") return `start:${data.index}:${data.content_block?.type}`;
    if (event.event === "content_block_delta") return `delta:${data.index}:${data.delta?.type}`;
    if (event.event === "content_block_stop") return `stop:${data.index}`;
    return event.event;
  });
  expect(trace).toEqual([
    "message_start",
    "start:0:thinking",
    "delta:0:thinking_delta",
    "stop:0",
    "start:1:text",
    "delta:1:text_delta",
    "delta:1:text_delta",
    "stop:1",
    "message_delta",
    "message_stop",
  ]);
  const stops = trace.filter((item) => item.startsWith("stop:"));
  expect(stops).toEqual(["stop:0", "stop:1"]);
});

test("silent-final wait() text is not reported as empty turn", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "silent-final", text: "only-from-wait" }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as { content: Array<{ type: string; text?: string }>; stop_reason: string };
  expect(res.status).toBe(200);
  expect(body.stop_reason).toBe("end_turn");
  expect(body.content).toEqual([{ type: "text", text: "only-from-wait" }]);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("empty semantic output fails closed", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "empty" }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as { error: { type: string }; request_id: string };
  expect(res.status).toBe(502);
  expect(body.error.type).toBe("cursor_empty_turn");
  expect(body.request_id).toBeTruthy();
});

test("in-stream error closes open blocks and sends message_stop before error", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["partial"] }, { type: "error", message: "upstream failed" }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "go" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = parseSse(await res.text());
  const eventTypes = events.map((e) => e.event);
  expect(eventTypes[0]).toBe("message_start");
  expect(eventTypes).toContain("content_block_delta");
  expect(eventTypes).toContain("content_block_stop");
  expect(eventTypes).toContain("message_delta");
  expect(eventTypes).toContain("message_stop");
  expect(eventTypes).toContain("error");
  const stopIdx = eventTypes.indexOf("message_stop");
  const errorIdx = eventTypes.indexOf("error");
  expect(stopIdx).toBeGreaterThan(-1);
  expect(errorIdx).toBeGreaterThan(stopIdx);
});
