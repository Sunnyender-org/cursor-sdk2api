import { afterEach, expect, test } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { parseMessagesRequest } from "../../src/protocols/anthropic/parse.js";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

function parseError(body: unknown): () => ParsedMessages {
  return () => parseMessagesRequest(body);
}

type ParsedMessages = ReturnType<typeof parseMessagesRequest>;

test("user and assistant messages stay unchanged", () => {
  const parsed = parseMessagesRequest({
    model: "composer-2.5",
    system: "base",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
  });
  expect(parsed.systemText).toBe("base");
  expect(parsed.messages).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
  ]);
});

test("system and developer roles fold into systemText and are not kept as chat messages", () => {
  const parsed = parseMessagesRequest({
    model: "composer-2.5",
    system: "from field",
    messages: [
      { role: "system", content: "from system message" },
      { role: "developer", content: [{ type: "text", text: "from developer" }] },
      { role: "user", content: "hi" },
    ],
  });
  expect(parsed.systemText).toBe("from field\nfrom system message\nfrom developer");
  expect(parsed.messages).toEqual([{ role: "user", content: "hi" }]);
});

test("tool and function roles become user tool_result messages", () => {
  const parsed = parseMessagesRequest({
    model: "composer-2.5",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
      { role: "tool", tool_call_id: "call_1", content: "tool-out", is_error: true },
      { role: "function", name: "lookup", content: "fn-out" },
      { role: "tool", id: "id_only", content: "id-out" },
      { role: "function", content: "fallback" },
    ],
  });
  expect(parsed.messages).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "tool-out", is_error: true }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "lookup", content: "fn-out", is_error: false }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "id_only", content: "id-out", is_error: false }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tool", content: "fallback", is_error: false }],
    },
  ]);
});

test("unknown roles still fail with the original 422", () => {
  try {
    parseError({
      model: "composer-2.5",
      messages: [{ role: "spectator", content: "nope" }],
    })();
    expect.unreachable("expected invalid role to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      message: "message.role must be user or assistant",
      httpStatus: 422,
      code: "invalid_request",
    });
  }
});

test("system-only messages are still a non-empty-array error", () => {
  try {
    parseError({
      model: "composer-2.5",
      messages: [
        { role: "system", content: "only system" },
        { role: "developer", content: "only developer" },
      ],
    })();
    expect.unreachable("expected system-only payload to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      message: "messages must be a non-empty array",
      code: "invalid_request",
    });
  }
});

test("/v1/messages accepts system and developer roles and folds them into the prompt", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      system: "top rule",
      messages: [
        { role: "system", content: "system rule" },
        { role: "developer", content: [{ type: "text", text: "developer rule" }] },
        { role: "user", content: "hello" },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("System:\ntop rule\nsystem rule\ndeveloper rule");
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("user:\nhello");
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("user:\nsystem rule");
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("user:\ndeveloper rule");
});

test("/v1/messages accepts tool and function roles as tool_result user turns", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "tool", tool_call_id: "call_1", content: "72F" },
        { role: "function", name: "lookup", content: "fn" },
        { role: "user", content: "hello" },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("[tool_result call_1]");
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("[tool_result lookup]");
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("user:\nhello");
});

test("/v1/messages still rejects unknown roles with 422", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "spectator", content: "nope" }],
    }),
  });
  const body = (await res.json()) as { error: { type: string; message: string } };
  expect(res.status).toBe(422);
  expect(body.error.type).toBe("invalid_request");
  expect(body.error.message).toBe("message.role must be user or assistant");
});
