import { afterEach, expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { api, closeTestApp, parseSse, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("awaiting session expires on last_activity TTL", async () => {
  const clock = new FakeClock(1_000);
  ctx = await startTestApp({
    clock,
    config: { sessionTtlMs: 1_000, toolBatchSettleMs: 0, firstEventTimeoutMs: 10_000 },
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "ttl" } }] }, { type: "text", chunks: ["late"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  clock.advance(2_000);
  ctx.app.registry.sweep();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] }],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_lost");
});

test("client disconnect before first semantic output cancels the run", async () => {
  ctx = await startTestApp({
    config: { firstEventTimeoutMs: 10_000 },
    sdk: { scripts: [[{ type: "hang" }]] },
  });
  const ac = new AbortController();
  const pending = api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hang" }],
    }),
    signal: ac.signal,
  });
  const started = Date.now();
  while (ctx.app.registry.activeCount() === 0 && Date.now() - started < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(ctx.app.registry.activeCount()).toBe(1);
  ac.abort();
  await pending.catch(() => undefined);
  const closed = Date.now();
  while (ctx.app.registry.activeCount() > 0 && Date.now() - closed < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(ctx.app.registry.activeCount()).toBe(0);
  expect(ctx.sdk.agents[0]?.runs[0]?.cancelled).toBe(true);
});

test("disconnect after a tool batch keeps the session for later replay", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "keep" } }] },
          { type: "text", chunks: ["recovered"] },
        ],
      ],
    },
  });
  const ac = new AbortController();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
    signal: ac.signal,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error("missing body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes("tool_use")) break;
  }
  ac.abort();
  const events = parseSse(buf);
  const toolEvent = events.find((event) => {
    const data = event.data as { content_block?: { type?: string; id?: string } };
    return data.content_block?.type === "tool_use";
  });
  const toolId = (toolEvent?.data as { content_block?: { id?: string } }).content_block?.id;
  expect(toolId).toBeTruthy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ctx.app.registry.activeCount()).toBe(1);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
    }),
  });
  const final = (await second.json()) as { content: Array<{ text?: string }> };
  expect(second.status).toBe(200);
  expect(final.content.some((block) => block.text === "recovered")).toBe(true);
});

test("process-generation loss is explicit session_lost, not a fake success", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] }]] },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id as string;
  const session = [...ctx.app.registry.sessions.values()][0];
  if (session) ctx.app.registry.forget(session, "simulated_restart");
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] }],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_lost");
  expect(JSON.stringify(body)).not.toContain("end_turn");
});

test("streaming tool_result resume can disconnect and reattach the same digest", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "slow" } }] },
          { type: "text", chunks: ["HELLO", "WORLD"], pauseBetweenMs: 80 },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = turn.content.find((block) => block.type === "tool_use")?.id;
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    stream: true,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
  };

  const ac = new AbortController();
  const partial = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
    signal: ac.signal,
  });
  const reader = partial.body?.getReader();
  if (!reader) throw new Error("missing body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes("HELLO")) break;
  }
  ac.abort();
  expect(buf).toContain("HELLO");

  const replay = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const text = await replay.text();
  expect(replay.status).toBe(200);
  expect(text).toContain("HELLO");
  expect(text).toContain("WORLD");
  const sessionId = replay.headers.get("x-cursor-session-id");
  const storedMessageId = sessionId ? ctx.app.registry.get(sessionId)?.replay?.turn.messageId : undefined;
  const messageStart = parseSse(text).find((event) => event.event === "message_start")?.data as
    | { message?: { id?: string } }
    | undefined;
  expect(storedMessageId).toBeTruthy();
  expect(messageStart?.message?.id).toBe(storedMessageId);
  const run = ctx.sdk.agents[0]?.runs[0];
  expect(run?.streamStarts).toBe(1);
  expect(run?.capturedToolResults).toHaveLength(1);
  expect(run?.waitCalls).toBe(1);
});

test("three duplicate-same resumes share one published boundary and one state transition", async () => {
  let finalsAtGate = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let twoHeld!: () => void;
  const twoAtGate = new Promise<void>((resolve) => {
    twoHeld = resolve;
  });
  let thirdEntered!: () => void;
  const thirdAtGate = new Promise<void>((resolve) => {
    thirdEntered = resolve;
  });

  ctx = await startTestApp({
    captureLogs: true,
    beforeApplyBoundary: async (boundary) => {
      if (boundary.type !== "final") return;
      finalsAtGate += 1;
      if (finalsAtGate <= 2) {
        if (finalsAtGate === 2) twoHeld();
        await held;
        return;
      }
      thirdEntered();
    },
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "race" } }] },
          { type: "text", chunks: ["DONE"] },
        ],
      ],
    },
  });
  const opened = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await opened.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = turn.content.find((block) => block.type === "tool_use")?.id;
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
  };

  const first = api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  const second = api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  await twoAtGate;
  const session = [...ctx.app.registry.sessions.values()][0];
  expect(session?.state).toBe("resuming");
  const third = api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  await thirdAtGate;
  release();
  const bodies = await Promise.all([first, second, third]);
  for (const res of bodies) {
    expect(res.status).toBe(200);
    const json = (await res.json()) as { content: Array<{ text?: string }> };
    expect(json.content.some((block) => block.text === "DONE")).toBe(true);
  }
  const run = ctx.sdk.agents[0]?.runs[0];
  expect(run?.streamStarts).toBe(1);
  expect(run?.capturedToolResults).toHaveLength(1);
  expect(run?.waitCalls).toBe(1);
  expect(ctx.logs.filter((line) => line.includes("turn completed"))).toHaveLength(1);
});

test("late same-segment waiter observes a published error boundary", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstHeld!: () => void;
  const atGate = new Promise<void>((resolve) => {
    firstHeld = resolve;
  });
  let holdingFirst = false;
  ctx = await startTestApp({
    beforeApplyBoundary: async (boundary) => {
      if (boundary.type !== "error") return;
      if (holdingFirst) return;
      holdingFirst = true;
      firstHeld();
      await held;
    },
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "err" } }] },
          { type: "error", message: "boom" },
        ],
      ],
    },
  });
  const opened = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await opened.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = turn.content.find((block) => block.type === "tool_use")?.id;
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
  };
  const first = api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  await atGate;
  expect([...ctx.app.registry.sessions.values()][0]?.state).toBe("resuming");
  const second = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  expect(second.status).toBe(502);
  release();
  expect((await first).status).toBe(502);
  expect(ctx.sdk.agents[0]?.runs[0]?.streamStarts).toBe(1);
});

test("periodic sweeper expires idle awaiting sessions without a new request", async () => {
  ctx = await startTestApp({
    config: { sessionTtlMs: 80, sweepIntervalMs: 20, firstEventTimeoutMs: 5_000 },
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "ttl" } }] }, { type: "text", chunks: ["late"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id;
  const started = Date.now();
  while (ctx.app.registry.sessions.size > 0 && Date.now() - started < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(ctx.app.registry.sessions.size).toBe(0);
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "x" }] }],
    }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
});

test("expired tool index is bounded by replay TTL", async () => {
  const clock = new FakeClock(1_000);
  ctx = await startTestApp({
    clock,
    config: { replayTtlMs: 500, sessionTtlMs: 60_000, firstEventTimeoutMs: 10_000 },
    sdk: { scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] }]] },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const id = turn.content.find((block) => block.type === "tool_use")?.id as string;
  const session = [...ctx.app.registry.sessions.values()][0];
  if (session) ctx.app.registry.forget(session, "ttl");
  expect(ctx.app.registry.expiredIndexSize()).toBe(1);
  expect(ctx.app.registry.lostIfExpired([id])).toBe(true);
  clock.advance(500);
  ctx.app.registry.sweep();
  expect(ctx.app.registry.expiredIndexSize()).toBe(0);
});

test("completed follow-up drops old toolIndex and replay identity", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] },
          { type: "text", chunks: ["first-done"] },
        ],
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "2" } }] },
          { type: "text", chunks: ["second-done"] },
        ],
      ],
    },
  });
  const opened = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "one" }],
      tools: [weatherTool()],
    }),
  });
  const firstTurn = (await opened.json()) as {
    content: Array<{ type: string; id?: string }>;
    cursor_session_id: string;
  };
  const oldId = firstTurn.content.find((block) => block.type === "tool_use")?.id as string;
  await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: oldId, content: "r1" }] }],
    }),
  });
  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": firstTurn.cursor_session_id },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "two" }],
      tools: [weatherTool()],
    }),
  });
  const secondTurn = (await follow.json()) as { content: Array<{ type: string; id?: string }>; stop_reason: string };
  expect(follow.status).toBe(200);
  expect(secondTurn.stop_reason).toBe("tool_use");
  const newId = secondTurn.content.find((block) => block.type === "tool_use")?.id as string;
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(oldId);
  const session = ctx.app.registry.get(firstTurn.cursor_session_id);
  expect(session?.lastResultDigest).toBeUndefined();
  expect(ctx.app.registry.lookupByToolIds([oldId]).missing).toContain(oldId);
  const stale = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: oldId, content: "r1" }] }],
    }),
  });
  expect(stale.status).toBe(409);
  expect(((await stale.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
});

test("event pump refuses a second stream consumer", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["one"] }]] },
  });
  await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const run = ctx.sdk.agents[0]?.runs[0];
  expect(run?.streamStarts).toBe(1);
  expect(() => run?.stream()).toThrow(/single-consumer/);
});
