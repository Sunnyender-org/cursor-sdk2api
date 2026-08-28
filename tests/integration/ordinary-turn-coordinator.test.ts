import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

function followBody(assistant: string, next = "next", extras: Record<string, unknown> = {}) {
  return {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: assistant },
      { role: "user", content: next },
    ],
    ...extras,
  };
}

test("exact ordinary next turn reuses one Agent and sends only current text", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const firstBody = (await first.json()) as { content: Array<{ text?: string }> };
  expect(first.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);

  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(firstBody.content[0]?.text ?? "first")),
  });
  expect(follow.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.resumeCalls).toHaveLength(0);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(2);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toBe("next");
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("hello");
});

test("reused Agent publishes a tool called synchronously during follow-up send", async () => {
  ctx = await startTestApp({
    config: { firstEventTimeoutMs: 25 },
    sdk: {
      scripts: [
        [{ type: "text", chunks: ["first"] }],
        [
          { type: "send-tools", calls: [{ name: "lookup", input: { q: "weather" }, id: "early_followup" }] },
          { type: "hang" },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [weatherTool()],
    }),
  });
  const firstBody = (await first.json()) as { content: Array<{ text?: string }> };

  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(firstBody.content[0]?.text ?? "first", "use the tool", {
      tools: [weatherTool()],
    })),
  });
  const body = (await follow.json()) as { content: Array<{ type: string; id?: string; name?: string }> };

  expect(follow.status).toBe(200);
  expect(body.content).toContainEqual(expect.objectContaining({
    type: "tool_use",
    id: "early_followup",
    name: "lookup",
  }));
});

test("feature flag off keeps a cold rebuild for every ordinary turn", async () => {
  ctx = await startTestApp({
    config: { ordinaryTurnCoordinator: false },
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const firstBody = (await first.json()) as { content: Array<{ text?: string }> };
  await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(firstBody.content[0]?.text ?? "first")),
  });
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("hello");
  expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("next");
});

test("identical request digest replays without a second SDK send", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["same"] }]] },
  });
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
  };
  const [a, b] = await Promise.all([
    api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) }),
    api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) }),
  ]);
  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  const later = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  expect(later.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(((await a.json()) as { content: unknown }).content).toEqual(
    ((await later.json()) as { content: unknown }).content,
  );
});

test("an earlier ordinary turn replays its own response after a later turn completes", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const firstPayload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: "hello" }],
  };
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(firstPayload),
  });
  const firstBody = (await first.json()) as { content: Array<{ text?: string }> };

  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(firstBody.content[0]?.text ?? "first")),
  });
  expect(follow.status).toBe(200);

  const replay = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(firstPayload),
  });
  const replayBody = (await replay.json()) as { content: Array<{ text?: string }> };
  expect(replay.status).toBe(200);
  expect(replayBody.content[0]?.text).toBe("first");
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(2);
});

test("expired ordinary replay is released and the same request runs again", async () => {
  const clock = new FakeClock(1_000);
  ctx = await startTestApp({
    clock,
    config: { sessionTtlMs: 1_000, sweepIntervalMs: 5 },
    sdk: {
      agentScripts: [
        [[{ type: "text", chunks: ["first"] }]],
        [[{ type: "text", chunks: ["rebuilt"] }]],
      ],
    },
  });
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: "expire me" }],
  };
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  expect(first.status).toBe(200);
  expect(ctx.app.coordinator.ordinaryReplayCount()).toBe(1);

  clock.advance(1_001);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(ctx.app.coordinator.ordinaryReplayCount()).toBe(0);
  expect(ctx.sdk.agents[0]?.closed).toBe(true);

  const retried = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  const retriedBody = (await retried.json()) as { content: Array<{ text?: string }> };
  expect(retried.status).toBe(200);
  expect(retriedBody.content[0]?.text).toBe("rebuilt");
  expect(ctx.sdk.createCalls).toHaveLength(2);
});

test("a forked successor cold-rebuilds without sending on the original Agent", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["path-a"] }]],
        [[{ type: "text", chunks: ["path-b"] }]],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const assistant = ((await first.json()) as { content: Array<{ text?: string }> }).content[0]?.text ?? "first";
  const original = ctx.sdk.agents[0];
  const branchA = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(assistant, "path-a")),
  });
  const branchB = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(assistant, "path-b")),
  });
  expect(branchA.status).toBe(200);
  expect(branchB.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(original?.runs).toHaveLength(2);
  expect(original?.lastSend?.text).toBe("path-a");
  expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("path-b");
  expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("hello");
});

test("model or tool catalog mismatch never attaches", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["other"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const assistant = ((await first.json()) as { content: Array<{ text?: string }> }).content[0]?.text ?? "first";
  const otherModel = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      ...followBody(assistant),
      model: "grok-4.6",
    }),
  });
  expect(otherModel.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(2);
});

test("credential rotation never resumes the original Agent", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["rotated"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    apiKey: "test-key-a",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const assistant = ((await first.json()) as { content: Array<{ text?: string }> }).content[0]?.text ?? "first";
  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    apiKey: "test-key-b",
    body: JSON.stringify(followBody(assistant)),
  });
  expect(follow.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(ctx.sdk.agents[1]?.lastSend?.text).toContain("hello");
});

test("x-cursor-session-id follow-up still reuses the Agent", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "again" }],
    }),
  });
  expect(follow.status).toBe(200);
  expect(follow.headers.get("x-cursor-session-id")).toBe(sessionId);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(2);
});

test("process restart resumes the persisted Agent and sends only the current turn", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-ordinary-"));
  const firstApp = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] },
  });
  const first = await api(firstApp, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const assistant = ((await first.json()) as { content: Array<{ text?: string }> }).content[0]?.text ?? "first";
  const agentId = firstApp.sdk.agents[0]?.agentId;
  await closeTestApp(firstApp);

  ctx = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["second"] }]] },
  });
  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(followBody(assistant)),
  });
  expect(follow.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(0);
  expect(ctx.sdk.resumeCalls).toHaveLength(1);
  expect(ctx.sdk.lastResume?.agentId).toBe(agentId);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toBe("next");
});

test("Responses exact successor sends only the current turn", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hello",
    }),
  });
  expect(first.status).toBe(200);
  const follow = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "first" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "next" }] },
      ],
    }),
  });
  expect(follow.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toBe("next");
});
