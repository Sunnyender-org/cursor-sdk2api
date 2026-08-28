import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  api,
  closeTestApp,
  openaiWeatherTool,
  responsesWeatherTool,
  startTestApp,
  weatherTool,
  type TestContext,
} from "../helpers/app.js";

const apps: TestContext[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    if (app) await closeTestApp(app);
  }
});

test("Messages, Chat, and Responses share one equivalent executable session policy", async () => {
  const ctx = await startTestApp({
    sdk: {
      scripts: [
        [{ type: "text", chunks: ["messages"] }],
        [{ type: "text", chunks: ["chat"] }],
        [{ type: "text", chunks: ["responses"] }],
      ],
    },
  });
  apps.push(ctx);

  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "first" }],
      tools: [weatherTool()],
    }),
  });
  const sessionId = first.headers.get("x-cursor-session-id");
  expect(first.status).toBe(200);
  expect(sessionId).toMatch(/^ses_/);

  const chatTool = openaiWeatherTool();
  chatTool.function.parameters = {
    required: ["q"],
    properties: { q: { type: "string" } },
    type: "object",
  };
  const chat = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId as string },
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "second" }],
      tools: [chatTool],
    }),
  });
  expect(chat.status).toBe(200);

  const responses = await api(ctx, "/v1/responses", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId as string },
    body: JSON.stringify({
      model: "composer-2.5",
      input: "third",
      tools: [responsesWeatherTool()],
    }),
  });
  expect(responses.status).toBe(200);
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(3);
});

test.each([
  ["Messages", "/v1/messages", (tool: ReturnType<typeof weatherTool>) => ({
    model: "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content: "next" }],
    tools: [tool],
  })],
  ["Chat", "/v1/chat/completions", (tool: ReturnType<typeof weatherTool>) => ({
    model: "composer-2.5",
    messages: [{ role: "user", content: "next" }],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
  })],
  ["Responses", "/v1/responses", (tool: ReturnType<typeof weatherTool>) => ({
    model: "composer-2.5",
    input: "next",
    tools: [{ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema }],
  })],
])("%s explicit follow-up rejects a changed tool schema", async (_name, path, body) => {
  const ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["unsafe"] }]] },
  });
  apps.push(ctx);
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "first" }],
      tools: [weatherTool()],
    }),
  });
  const sessionId = first.headers.get("x-cursor-session-id") as string;
  const changed = weatherTool();
  changed.input_schema.properties.q.type = "number";
  const follow = await api(ctx, path, {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify(body(changed)),
  });
  expect(follow.status).toBe(409);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(1);
});

test("explicit follow-up rejects changed model parameters and namespace", async () => {
  const ctx = await startTestApp({ sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] } });
  apps.push(ctx);
  const namespaceTool = (namespace: string) => ({
    type: "namespace",
    name: namespace,
    tools: [{
      type: "function",
      name: "search",
      description: "Search",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    }],
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning: { effort: "high" },
      input: [{ type: "additional_tools", tools: [namespaceTool("mcp__exa")] }, { type: "message", role: "user", content: "first" }],
    }),
  });
  const sessionId = first.headers.get("x-cursor-session-id") as string;

  const changedParams = await api(ctx, "/v1/responses", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning: { effort: "low" },
      input: [{ type: "additional_tools", tools: [namespaceTool("mcp__exa")] }, { type: "message", role: "user", content: "next" }],
    }),
  });
  expect(changedParams.status).toBe(409);

  const changedNamespace = await api(ctx, "/v1/responses", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning: { effort: "high" },
      input: [{ type: "additional_tools", tools: [namespaceTool("mcp__other")] }, { type: "message", role: "user", content: "next" }],
    }),
  });
  expect(changedNamespace.status).toBe(409);
  expect(ctx.sdk.agents[0]?.runs).toHaveLength(1);
});

test("pending lineage rejects a changed catalog before resume or transcript recovery", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-policy-pending-"));
  const firstApp = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" }, id: "call_policy" }] }]] },
  });
  apps.push(firstApp);
  const first = await api(firstApp, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  expect(first.status).toBe(200);
  await closeTestApp(firstApp);
  apps.pop();

  const secondApp = await startTestApp({ config: { stateDir } });
  apps.push(secondApp);
  const changed = weatherTool();
  changed.description = "Changed execution contract";
  const resumed = await api(secondApp, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_policy", content: "ok" }] }],
      tools: [changed],
    }),
  });
  expect(resumed.status).toBe(409);
  expect(secondApp.sdk.resumeCalls).toHaveLength(0);
  expect(secondApp.sdk.createCalls).toHaveLength(0);
});

test("legacy lineage without a policy fingerprint cannot resume", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-policy-legacy-"));
  const firstApp = await startTestApp({ config: { stateDir } });
  apps.push(firstApp);
  const first = await api(firstApp, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "first" }],
    }),
  });
  const sessionId = first.headers.get("x-cursor-session-id") as string;
  await closeTestApp(firstApp);
  apps.pop();

  const lineagePath = join(stateDir, "lineage", `${sessionId}.json`);
  const legacy = JSON.parse(readFileSync(lineagePath, "utf8")) as Record<string, unknown>;
  legacy.version = 1;
  delete legacy.sessionPolicyFingerprint;
  writeFileSync(lineagePath, JSON.stringify(legacy), "utf8");

  const secondApp = await startTestApp({ config: { stateDir } });
  apps.push(secondApp);
  const follow = await api(secondApp, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "next" }],
    }),
  });
  expect(follow.status).toBe(409);
  expect(secondApp.sdk.resumeCalls).toHaveLength(0);
});
