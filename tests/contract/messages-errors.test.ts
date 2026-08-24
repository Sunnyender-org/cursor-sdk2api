import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

const STALE_SDK_AUTH = "Authentication error If you are logged in, try logging out and back in.";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("regional model unavailability is a forbidden capability error", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "send-error", message: "Model not available: provider is not supported in your region" }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(403);
  expect(body.error.type).toBe("forbidden");
});

test("SDK create authentication failures map to 401 and release capacity", async () => {
  ctx = await startTestApp({
    sdk: { createError: { name: "AuthenticationError", message: "invalid credential" } },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(401);
  expect(body.error.type).toBe("authentication_error");
  expect(ctx.app.registry.activeCount()).toBe(0);
  expect(ctx.sdk.credentialProbeCalls).toHaveLength(0);
});

test("stale SDK authentication retries once after the official credential probe succeeds", async () => {
  ctx = await startTestApp({
    sdk: {
      createErrorsByApiKey: {
        "test-key-a": [{ name: "AuthenticationError", message: "authentication error" }],
      },
      credentialProbeByApiKey: { "test-key-a": "valid" },
      scripts: [[{ type: "text", chunks: ["reauthenticated"] }]],
    },
  });
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "reauthenticated")).toBe(true);
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(ctx.sdk.credentialProbeCalls).toEqual(["test-key-a"]);
});

test("an in-band run auth code reaches the credential probe and recovers", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "error", message: "Session ended.", code: "AUTH_TOKEN_EXPIRED" }]],
        [[{ type: "text", chunks: ["reauthenticated"] }]],
      ],
      credentialProbeByApiKey: { "test-key-a": "valid" },
    },
  });
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "reauthenticated")).toBe(true);
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(ctx.sdk.credentialProbeCalls).toEqual(["test-key-a"]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("a rehydrated in-band run auth error without a code still recovers", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "error", message: STALE_SDK_AUTH }]],
        [[{ type: "text", chunks: ["reauthenticated"] }]],
      ],
      credentialProbeByApiKey: { "test-key-a": "valid" },
    },
  });
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "reauthenticated")).toBe(true);
  expect(ctx.sdk.credentialProbeCalls).toEqual(["test-key-a"]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("an in-band revoked-credential run error stays a 401 without a credential probe", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "error", message: "Authentication error This credential was revoked; you are not logged in." }]],
    },
  });
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  const body = (await response.json()) as { error: { type: string; message: string } };
  expect(response.status).toBe(401);
  expect(body.error.type).toBe("authentication_error");
  expect(body.error.message).toContain("revoked");
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.credentialProbeCalls).toEqual([]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("completed follow-up send failure releases the active-run slot", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [{ type: "text", chunks: ["first"] }],
        [{ type: "send-error", message: "transport failed" }],
      ],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "first" }] }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const failed = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({ model: "composer-2.5", max_tokens: 16, messages: [{ role: "user", content: "again" }] }),
  });
  expect(failed.status).toBe(502);
  expect(ctx.app.registry.activeCount()).toBe(0);
  expect(ctx.app.registry.get(sessionId)).toBeUndefined();
});

async function openToolSession(
  calls: Array<{ name: string; input: Record<string, unknown> }>,
  apiKey = "test-key-a",
) {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls }, { type: "text", chunks: ["final"] }]],
    },
  });
  const first = await api(ctx, "/v1/messages", {
    apiKey,
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool(), { name: "beta", input_schema: { type: "object" } }],
    }),
  });
  const turn = (await first.json()) as {
    content: Array<{ type: string; id?: string; name?: string }>;
    cursor_session_id: string;
  };
  const toolIds = turn.content.filter((block) => block.type === "tool_use").map((block) => block.id as string);
  return { turn, toolIds };
}

test("unknown tool_use_id fails closed", async () => {
  const { turn } = await openToolSession([{ name: "lookup", input: { q: "1" } }]);
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_missing", content: "x" }] },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect([400, 409, 422]).toContain(res.status);
  expect(["invalid_request", "cursor_session_lost"]).toContain(body.error.type);
});

test("missing required tool result fails closed", async () => {
  const { turn, toolIds } = await openToolSession([
    { name: "lookup", input: { q: "1" } },
    { name: "beta", input: { n: 2 } },
  ]);
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "only-one" }] },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(422);
  expect(body.error.type).toBe("invalid_request");
});

test("mixed-session tool ids fail closed", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] }, { type: "text", chunks: ["z"] }]],
    },
  });
  const bodyFor = async (apiKey: string) => {
    const res = await api(ctx, "/v1/messages", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        model: "composer-2.5",
        max_tokens: 16,
        messages: [{ role: "user", content: "go" }],
        tools: [weatherTool()],
      }),
    });
    const turn = (await res.json()) as { content: Array<{ type: string; id?: string }> };
    return turn.content.find((block) => block.type === "tool_use")?.id as string;
  };
  const idA = await bodyFor("key-one");
  const idB = await bodyFor("key-two");
  const res = await api(ctx, "/v1/messages", {
    apiKey: "key-two",
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: idA, content: "a" },
            { type: "tool_result", tool_use_id: idB, content: "b" },
          ],
        },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_conflict");
});

test("duplicate same result is idempotent and does not resolve twice", async () => {
  const { turn, toolIds } = await openToolSession([{ name: "lookup", input: { q: "1" } }]);
  const payload = {
    model: "composer-2.5",
    max_tokens: 16,
    messages: [
      { role: "assistant", content: turn.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "same" }] },
    ],
  };
  const first = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  const firstBody = await first.json();
  const second = await api(ctx, "/v1/messages", { method: "POST", body: JSON.stringify(payload) });
  const secondBody = await second.json();
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(secondBody).toMatchObject({ stop_reason: "end_turn" });
  expect(firstBody).toMatchObject({ stop_reason: "end_turn" });
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("duplicate different result fails closed", async () => {
  const { turn, toolIds } = await openToolSession([{ name: "lookup", input: { q: "1" } }]);
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "one" }] },
      ],
    }),
  });
  expect(first.status).toBe(200);
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "two" }] },
      ],
    }),
  });
  const body = (await second.json()) as { error: { type: string } };
  expect(second.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_conflict");
});

test("credential mismatch cannot continue another tenant session", async () => {
  const { turn, toolIds } = await openToolSession([{ name: "lookup", input: { q: "1" } }], "owner-key");
  const res = await api(ctx, "/v1/messages", {
    apiKey: "intruder-key",
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "x" }] },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_conflict");
});

test("model mismatch fails closed", async () => {
  const { turn, toolIds } = await openToolSession([{ name: "lookup", input: { q: "1" } }]);
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "other-model",
      max_tokens: 16,
      messages: [
        { role: "assistant", content: turn.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolIds[0], content: "x" }] },
      ],
    }),
  });
  const body = (await res.json()) as { error: { type: string } };
  expect(res.status).toBe(409);
  expect(body.error.type).toBe("cursor_session_conflict");
});
