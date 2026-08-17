import { afterEach, expect, test } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { parseResponsesRequest } from "../../src/protocols/openai-responses/parse.js";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function openaiError(body: unknown): { message: string; type: string; param: null; code: string } {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) throw new Error("expected OpenAI error object");
  return error as { message: string; type: string; param: null; code: string };
}

const jsonSchemaFormat = {
  type: "json_schema",
  name: "codex_output_schema",
  strict: true,
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
};

const additionalToolsItem = {
  type: "additional_tools",
  role: "developer",
  tools: [
    {
      type: "function",
      name: "lookup",
      description: "Look something up",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    },
    { type: "namespace", name: "default" },
    { type: "web_search" },
  ],
};

test("text.format json_schema is accepted and omitted by the parser", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    input: "hi",
    text: { verbosity: "medium", format: jsonSchemaFormat },
  });
  expect(parsed.parsed.messages).toEqual([{ role: "user", content: "hi" }]);
  expect(parsed.parsed.systemText).toBe("");
});

test("malformed text still fails closed at parse time", () => {
  try {
    parseResponsesRequest({
      model: "composer-2.5",
      input: "hi",
      text: "nope",
    });
    expect.unreachable("expected malformed text to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      message: "text must be an object if provided",
      code: "invalid_request",
    });
  }
});

test("additional_tools input items are skipped and do not lift nested hosted tools", () => {
  const parsed = parseResponsesRequest({
    model: "composer-2.5",
    tools: null,
    input: [
      additionalToolsItem,
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello from user" }] },
    ],
  });
  expect(parsed.parsed.messages).toEqual([{ role: "user", content: "hello from user" }]);
  expect(parsed.parsed.tools).toEqual([]);
});

test("top-level hosted tools still fail closed at parse time", () => {
  try {
    parseResponsesRequest({
      model: "composer-2.5",
      input: "search",
      tools: [{ type: "web_search" }],
    });
    expect.unreachable("expected hosted tool to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({
      code: "invalid_request",
    });
    expect((error as Error).message).toMatch(/web_search/);
  }
});

test("previous_response_id and store=true still fail closed at parse time", () => {
  try {
    parseResponsesRequest({
      model: "composer-2.5",
      previous_response_id: "resp_pretend",
      input: "hi",
    });
    expect.unreachable("expected previous_response_id to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as Error).message).toMatch(/previous_response_id/);
  }

  try {
    parseResponsesRequest({
      model: "composer-2.5",
      store: true,
      input: "hi",
    });
    expect.unreachable("expected store=true to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as Error).message).toMatch(/store=true/);
  }
});

test("text.format json_schema returns a normal text turn", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello world"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      text: { format: jsonSchemaFormat },
    }),
  });
  const body = (await res.json()) as {
    status: string;
    output: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
  };
  expect(res.status).toBe(200);
  expect(body.status).toBe("completed");
  expect(body.output[0]).toMatchObject({
    type: "message",
    content: [{ type: "output_text", text: "hello world" }],
  });
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("user:\nhi");
});

test("text.verbosity medium still returns 200", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      text: { verbosity: "medium" },
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.lastCreate).toBeDefined();
});

test("additional_tools plus a user message returns 200 and forwards user text", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      tools: null,
      input: [
        additionalToolsItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: "hello from user" }] },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.lastCreate).toBeDefined();
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("user:\nhello from user");
  expect(ctx.sdk.lastAllowlist).toEqual([]);
});

test("top-level tools web_search still fail closed", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "search",
      tools: [{ type: "web_search" }],
    }),
  });
  const error = openaiError(await res.json());
  expect([400, 422]).toContain(res.status);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toMatch(/web_search/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("previous_response_id and store=true still fail closed over HTTP", async () => {
  ctx = await startTestApp();
  const previous = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      previous_response_id: "resp_pretend",
      input: "hi",
    }),
  });
  expect([400, 422]).toContain(previous.status);
  expect(openaiError(await previous.json()).message).toMatch(/previous_response_id/);

  const stored = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      store: true,
      input: "hi",
    }),
  });
  expect([400, 422]).toContain(stored.status);
  expect(openaiError(await stored.json()).message).toMatch(/store=true/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("malformed text still errors over HTTP", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      text: "nope",
    }),
  });
  const error = openaiError(await res.json());
  expect([400, 422]).toContain(res.status);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toMatch(/text must be an object/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});
