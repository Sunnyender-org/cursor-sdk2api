import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("Claude count_tokens returns a local sizing estimate without starting an SDK run", async () => {
  ctx = await startTestApp();
  const response = await api(ctx, "/v1/messages/count_tokens", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      system: "You are Claude Code.",
      messages: [{ role: "user", content: "Count this context before sending it." }],
      tools: [{
        name: "read_file",
        description: "Read a local file",
        input_schema: { type: "object", properties: { path: { type: "string" } } },
      }],
    }),
  });
  const body = (await response.json()) as { input_tokens: number };

  expect(response.status).toBe(200);
  expect(response.headers.get("x-cursor-sdk2api-token-count")).toBe("estimated");
  expect(body.input_tokens).toBeGreaterThan(10);
  expect(ctx.sdk.agents).toHaveLength(0);
});

test("base64 image bytes do not inflate the text estimate", async () => {
  ctx = await startTestApp();
  const request = (data: string) => api(ctx, "/v1/messages/count_tokens", {
    method: "POST",
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      }],
    }),
  });
  const small = (await (await request("YQ==".repeat(100))).json()) as { input_tokens: number };
  const large = (await (await request("YQ==".repeat(10_000))).json()) as { input_tokens: number };

  expect(Math.abs(large.input_tokens - small.input_tokens)).toBeLessThan(20);
});

test("count_tokens requires gateway authentication", async () => {
  ctx = await startTestApp();
  const response = await fetch(`${ctx.url}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Count this." }],
    }),
  });

  expect(response.status).toBe(401);
});
