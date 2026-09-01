import { afterEach, expect, test } from "vitest";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.js";
import { parseResponsesRequest } from "../../src/protocols/openai-responses/parse.js";
import { COMPACT_TOKEN_PREFIX } from "../../src/core/compact-anchor.js";
import {
  api,
  closeTestApp,
  parseSse,
  responsesWeatherTool,
  startTestApp,
  type TestContext,
} from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined as never;
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function openaiError(body: unknown): { message: string; type: string; param: null; code: string } {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) throw new Error("expected OpenAI error object");
  return error as { message: string; type: string; param: null; code: string };
}

function compactionItem(body: { output?: unknown[] }): { type: string; encrypted_content: string } {
  const output = body.output ?? [];
  expect(output).toHaveLength(1);
  const item = output[0];
  if (!isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string") {
    throw new Error("expected a single compaction item");
  }
  return item as { type: string; encrypted_content: string };
}

function sendCount(): number {
  return ctx.sdk.agents.reduce((sum, agent) => sum + agent.runs.length, 0);
}

test("POST /v1/responses/compact returns exactly one csgw1 item without SDK send", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["should not run"] }]] },
    captureLogs: true,
  });
  const res = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "long conversation that must not be stored as transcript",
    }),
  });
  const body = (await res.json()) as { object: string; status: string; output: unknown[] };
  expect(res.status).toBe(200);
  expect(body.object).toBe("response");
  expect(body.status).toBe("completed");
  const item = compactionItem(body);
  expect(item.encrypted_content.startsWith(COMPACT_TOKEN_PREFIX)).toBe(true);
  expect(item.encrypted_content.startsWith("v3.")).toBe(false);
  expect(ctx.sdk.createCalls).toHaveLength(0);
  expect(sendCount()).toBe(0);

  const compactDir = join(ctx.app.config.stateDir, "compacts");
  for (const name of readdirSync(compactDir)) {
    const raw = readFileSync(join(compactDir, name), "utf8");
    expect(raw).not.toContain("long conversation that must not be stored as transcript");
  }
  const key = readFileSync(join(ctx.app.config.stateDir, "compact-hmac.key"));
  expect(ctx.logs.join("\n")).not.toContain(key.toString("hex"));
  expect(ctx.logs.join("\n")).not.toContain(key.toString("base64"));
});

test("compact stream still emits exactly one compaction item", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      input: [{ type: "input_text", text: "history" }],
    }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events = parseSse(await res.text());
  expect(events.map((event) => event.event).slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
  expect(events.at(-1)?.event).toBe("response.completed");
  const completed = events.at(-1)?.data;
  const output =
    isRecord(completed) && isRecord(completed.response) ? (completed.response.output as unknown[]) : [];
  expect(compactionItem({ output }).encrypted_content.startsWith(COMPACT_TOKEN_PREFIX)).toBe(true);
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("compaction_trigger locally compacts without a second Send", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] },
  });
  const inferred = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "hello" }),
  });
  expect(inferred.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(sendCount()).toBe(1);

  const trigger = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction_trigger" },
        { type: "message", role: "user", content: "hello" },
      ],
    }),
  });
  expect(trigger.status).toBe(200);
  const item = compactionItem((await trigger.json()) as { output: unknown[] });
  expect(item.encrypted_content.startsWith(COMPACT_TOKEN_PREFIX)).toBe(true);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(sendCount()).toBe(1);
});

test("valid compact anchor can continue with one later Send and drops the raw transcript", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["after compact"] }]] },
  });
  const compact = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "secret history that must not be resent",
    }),
  });
  const token = compactionItem((await compact.json()) as { output: unknown[] }).encrypted_content;
  expect(ctx.sdk.createCalls).toHaveLength(0);

  const follow = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue from the compact note" },
      ],
    }),
  });
  const body = (await follow.json()) as {
    status: string;
    output: Array<{ type: string; content?: Array<{ text?: string }> }>;
  };
  expect(follow.status).toBe(200);
  expect(body.status).toBe("completed");
  expect(body.output.some((item) => item.type === "compaction")).toBe(false);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(sendCount()).toBe(1);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("continue from the compact note");
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("secret history that must not be resent");
});

test("tampered, cross-account, and cross-profile compact anchors fail closed", async () => {
  ctx = await startTestApp({
    config: {
      runtimePolicy: { defaultProfile: "sdk", allowRequestOverride: true, hostedSearchMode: "off" },
    },
  });
  const compact = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "history" }),
  });
  const token = compactionItem((await compact.json()) as { output: unknown[] }).encrypted_content;

  const tampered = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: `${token.slice(0, -1)}x` },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(tampered.status).toBe(422);
  const tamperedError = openaiError(await tampered.json());
  expect(tamperedError.code).toBe("invalid_request");
  expect(tamperedError.message).not.toMatch(/BeefAPI|v3\./i);

  const crossed = await api(ctx, "/v1/responses", {
    method: "POST",
    apiKey: "test-key-b",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(crossed.status).toBe(409);
  expect(openaiError(await crossed.json()).code).toBe("cursor_session_conflict");

  const profile = await api(ctx, "/v1/responses", {
    method: "POST",
    headers: { "x-cursor-runtime-profile": "sand" },
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(profile.status).toBe(409);
  expect(openaiError(await profile.json()).code).toBe("cursor_session_conflict");
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("cross-model compact continuation and missing local state fail closed", async () => {
  ctx = await startTestApp({
    sdk: { models: { ok: true, models: [{ id: "composer-2.5" }, { id: "grok-4.6" }] } },
  });
  const compact = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "history" }),
  });
  const token = compactionItem((await compact.json()) as { output: unknown[] }).encrypted_content;

  const crossed = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(crossed.status).toBe(409);
  expect(openaiError(await crossed.json()).code).toBe("cursor_session_conflict");

  rmSync(join(ctx.app.config.stateDir, "compacts"), { recursive: true, force: true });
  const missing = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(missing.status).toBe(409);
  expect(openaiError(await missing.json()).message).toMatch(/no longer available/);
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("expired compact context fails closed", async () => {
  const clock = new FakeClock(1_000_000);
  ctx = await startTestApp({ clock });
  const compact = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "history" }),
  });
  const token = compactionItem((await compact.json()) as { output: unknown[] }).encrypted_content;
  clock.advance(8 * 24 * 60 * 60 * 1000);
  const expired = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(expired.status).toBe(409);
  expect(openaiError(await expired.json()).message).toMatch(/expired/);
});

test("unsupported document audio video and hosted search stay 4xx on compact", async () => {
  ctx = await startTestApp();
  const cases: Array<{ body: Record<string, unknown>; status: number; match: RegExp }> = [
    {
      body: {
        model: "composer-2.5",
        input: [{ type: "message", role: "user", content: [{ type: "document", text: "doc" }] }],
      },
      status: 400,
      match: /document is not supported/,
    },
    {
      body: {
        model: "composer-2.5",
        input: [{ type: "audio", data: "aaa" }],
      },
      status: 400,
      match: /audio is not supported/,
    },
    {
      body: {
        model: "composer-2.5",
        input: [{ type: "video", data: "bbb" }],
      },
      status: 400,
      match: /video is not supported/,
    },
    {
      body: { model: "composer-2.5", input: "hi", audio: { voice: "alloy" } },
      status: 400,
      match: /audio is not supported/,
    },
    {
      body: { model: "composer-2.5", input: "search", tools: [{ type: "web_search" }] },
      status: 400,
      match: /web_search/,
    },
    {
      body: { model: "composer-2.5", input: "search", tools: [{ type: "x_search" }] },
      status: 400,
      match: /x_search/,
    },
    {
      body: { model: "composer-2.5", input: "search", web_search_options: { search_context_size: "low" } },
      status: 400,
      match: /web_search_options/,
    },
    {
      body: { model: "composer-2.5", previous_response_id: "resp_stored", input: "hi" },
      status: 400,
      match: /previous_response_id/,
    },
  ];
  for (const item of cases) {
    const res = await api(ctx, "/v1/responses/compact", {
      method: "POST",
      body: JSON.stringify(item.body),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect([item.status, 400, 422]).toContain(res.status);
    expect(openaiError(await res.json()).message).toMatch(item.match);
  }
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("stored-response fields stay fail-closed when mixed with compaction_trigger", () => {
  expect(() =>
    parseResponsesRequest({
      model: "composer-2.5",
      previous_response_id: "resp_stored",
      input: [{ type: "compaction_trigger" }, { type: "input_text", text: "hi" }],
    }),
  ).toThrowError(/previous_response_id/);
  expect(() =>
    parseResponsesRequest({
      model: "composer-2.5",
      store: true,
      input: [{ type: "compaction", encrypted_content: "csgw1.token" }, { type: "input_text", text: "hi" }],
    }),
  ).toThrowError(/store=true/);
});

test("cross-tool policy compact continuation is a conflict", async () => {
  ctx = await startTestApp();
  const compact = await api(ctx, "/v1/responses/compact", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "history",
      tools: [responsesWeatherTool()],
    }),
  });
  const token = compactionItem((await compact.json()) as { output: unknown[] }).encrypted_content;
  const crossed = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "compaction", encrypted_content: token },
        { type: "input_text", text: "continue" },
      ],
    }),
  });
  expect(crossed.status).toBe(409);
  expect(openaiError(await crossed.json()).code).toBe("cursor_session_conflict");
});
