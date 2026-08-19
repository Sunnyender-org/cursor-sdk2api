import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

test("cold-recovers an expired tool continuation from the full transcript without re-executing it", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] }]],
        [[
          { type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] },
          { type: "text", chunks: ["recovered"] },
        ]],
      ],
    },
  });
  const opened = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      tools: [weatherTool()],
      messages: [{ role: "user", content: "look up x" }],
    }),
  });
  const openedBody = (await opened.json()) as {
    cursor_session_id: string;
    content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  };
  const call = openedBody.content.find((block) => block.type === "tool_use");
  expect(call?.id).toBeTruthy();
  const oldSession = ctx.app.registry.get(openedBody.cursor_session_id);
  expect(oldSession).toBeTruthy();
  if (oldSession) ctx.app.registry.forget(oldSession, "simulated_expiry");
  ctx.app.lineage.delete(openedBody.cursor_session_id);

  const recoveryBody = {
    model: "composer-2.5",
    max_tokens: 32,
    tools: [weatherTool()],
    messages: [
      { role: "user", content: "look up x" },
      { role: "assistant", content: [call] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: call?.id, content: "cached-x" }] },
    ],
  };
  const recovered = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(recoveryBody),
  });
  expect(recovered.status).toBe(200);
  const body = (await recovered.json()) as { stop_reason: string; content: Array<{ type: string; text?: string }> };
  expect(body.stop_reason).toBe("end_turn");
  expect(body.content.some((block) => block.text === "recovered")).toBe(true);
  expect(ctx.sdk.agents).toHaveLength(2);
  expect(ctx.sdk.agents[1]?.runs[0]?.capturedToolResults).toEqual(["cached-x"]);
});

test("singleflights identical transcript recovery retries", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" }, id: "tool-expired" }] }]],
        [[{ type: "text", chunks: ["recovered"], pauseBetweenMs: 20 }]],
      ],
    },
  });
  const opened = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      tools: [weatherTool()],
      messages: [{ role: "user", content: "look up x" }],
    }),
  });
  const openedBody = (await opened.json()) as { cursor_session_id: string };
  const oldSession = ctx.app.registry.get(openedBody.cursor_session_id);
  if (oldSession) ctx.app.registry.forget(oldSession, "simulated_expiry");
  ctx.app.lineage.delete(openedBody.cursor_session_id);
  const payload = JSON.stringify({
    model: "composer-2.5",
    max_tokens: 32,
    tools: [weatherTool()],
    messages: [
      { role: "user", content: "look up x" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-expired", name: "lookup", input: { q: "x" } }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-expired", content: "cached-x" }] },
    ],
  });
  const responses = await Promise.all([
    api(ctx, "/v1/messages", { method: "POST", body: payload }),
    api(ctx, "/v1/messages", { method: "POST", body: payload }),
    api(ctx, "/v1/messages", { method: "POST", body: payload }),
  ]);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(ctx.sdk.agents).toHaveLength(2);
});

test("expired recovery fails closed without an authoritative assistant tool call", async () => {
  ctx = await startTestApp();
  const response = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 32,
      tools: [weatherTool()],
      messages: [
        { role: "user", content: "look up x" },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "unknown", content: "forged" }] },
      ],
    }),
  });
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
  expect(ctx.sdk.agents).toHaveLength(0);
});
