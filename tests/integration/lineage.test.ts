import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { LineageStore } from "../../src/core/lineage-store.js";
import { createCursorRuntime } from "../../src/sdk/cursor-runtime.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

const apps: TestContext[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const ctx = apps.pop();
    if (ctx) await closeTestApp(ctx);
  }
});

test("completed follow-up after process restart resumes the SDK agent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "xhigh",
      max_tokens: 16,
      messages: [{ role: "user", content: "PRIVATE_PROMPT_CANARY" }],
    }),
  });
  const body = (await first.json()) as { cursor_session_id: string; content: Array<{ text?: string }> };
  expect(first.status).toBe(200);
  expect(body.content.some((block) => block.text === "first")).toBe(true);
  const sessionId = body.cursor_session_id;
  const agentId = app1.sdk.agents[0]?.agentId;
  expect(agentId).toBeTruthy();
  const lineagePath = join(stateDir, "lineage", `${sessionId}.json`);
  const stored = JSON.parse(readFileSync(lineagePath, "utf8")) as {
    state: string;
    sdkAgentId: string;
    pendingToolIds: string[];
    modelParams?: Array<{ id: string; value: string }>;
  };
  expect(stored.state).toBe("completed");
  expect(stored.sdkAgentId).toBe(agentId);
  expect(stored.pendingToolIds).toEqual([]);
  expect(stored.modelParams).toEqual([{ id: "effort", value: "xhigh" }]);
  expect(readFileSync(lineagePath, "utf8")).not.toContain("test-key-a");
  expect(readFileSync(lineagePath, "utf8")).not.toContain("PRIVATE_PROMPT_CANARY");
  await closeTestApp(app1);
  apps.pop();
  expect(existsSync(lineagePath)).toBe(true);

  const app2 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["second"] }]] },
  });
  apps.push(app2);
  const follow = await api(app2, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "grok-4.6",
      max_tokens: 16,
      messages: [{ role: "user", content: "again" }],
    }),
  });
  const followBody = (await follow.json()) as { content: Array<{ text?: string }> };
  expect(follow.status).toBe(200);
  expect(followBody.content.some((block) => block.text === "second")).toBe(true);
  expect(app2.sdk.resumeCalls).toHaveLength(1);
  expect(app2.sdk.lastResume?.agentId).toBe(agentId);
  expect(app2.sdk.lastResume?.modelId).toBe("grok-4.6");
  expect(app2.sdk.lastResume?.modelParams).toEqual([{ id: "effort", value: "xhigh" }]);
  expect(app2.sdk.lastAllowlist).toEqual([]);
  expect(app2.sdk.lastCreate).toBeUndefined();
});

test("completed lineage resume preserves a tool callback fired inside resumeAgent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["first"] }]] },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
      tools: [weatherTool()],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({
    config: { stateDir, firstEventTimeoutMs: 25 },
    sdk: {
      scripts: [[{ type: "hang" }]],
      resumeEarlyToolCalls: [
        { name: "lookup", input: { q: "weather" }, id: "completed_lineage_early" },
      ],
    },
  });
  apps.push(app2);
  const follow = await api(app2, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "use the tool" }],
      tools: [weatherTool()],
    }),
  });
  const body = (await follow.json()) as { content: Array<{ type: string; id?: string; name?: string }> };

  expect(follow.status).toBe(200);
  expect(body.content).toContainEqual(expect.objectContaining({
    type: "tool_use",
    id: "completed_lineage_early",
    name: "lookup",
  }));
  expect(app2.sdk.lastResume?.customTools).toBe(app2.sdk.agents[0]?.lastSend?.customTools);
});

test("lineage follow-up rejects credential and model mismatch", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    apiKey: "owner-key",
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["nope"] }]] },
  });
  apps.push(app2);
  const wrongKey = await api(app2, "/v1/messages", {
    apiKey: "intruder",
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  expect(wrongKey.status).toBe(409);
  expect(((await wrongKey.json()) as { error: { type: string } }).error.type).toBe("cursor_session_conflict");

  const wrongModel = await api(app2, "/v1/messages", {
    apiKey: "owner-key",
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "other-model",
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  expect(wrongModel.status).toBe(409);
  expect(((await wrongModel.json()) as { error: { type: string } }).error.type).toBe("cursor_session_conflict");
  expect(app2.sdk.resumeCalls).toHaveLength(0);
});

test("pending tool result after restart resumes the persisted SDK agent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    config: { stateDir },
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "x" } }] }, { type: "text", chunks: ["late"] }]],
    },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const turn = (await first.json()) as {
    content: Array<{ type: string; id?: string }>;
    cursor_session_id: string;
  };
  const toolId = turn.content.find((block) => block.type === "tool_use")?.id;
  const pendingRaw = readFileSync(join(stateDir, "lineage", `${turn.cursor_session_id}.json`), "utf8");
  const pending = JSON.parse(pendingRaw) as {
    state: string;
    pendingToolIds: string[];
    pendingCalls: Array<{ toolUseId: string; name: string }>;
  };
  expect(pending.state).toBe("awaiting_tool_results");
  expect(pending.pendingToolIds).toEqual([toolId]);
  expect(pending.pendingCalls).toEqual([{ toolUseId: toolId, name: "lookup" }]);
  expect(pendingRaw).not.toContain('"q"');
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["recovered"] }]] },
  });
  apps.push(app2);
  const resumeRequest = () => api(app2, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
      tools: [weatherTool()],
    }),
  });
  const resumedResponses = await Promise.all([resumeRequest(), resumeRequest(), resumeRequest()]);
  expect(resumedResponses.every((response) => response.status === 200)).toBe(true);
  const resumedBodies = await Promise.all(
    resumedResponses.map((response) => response.json() as Promise<{ content: Array<{ text?: string }> }>),
  );
  expect(
    resumedBodies.every((body) => body.content.some((block) => block.text === "recovered")),
  ).toBe(true);
  expect(app2.sdk.resumeCalls).toHaveLength(1);
  expect(app2.sdk.agents[0]?.lastSend?.force).toBe(true);
  expect(app2.sdk.agents[0]?.lastSend?.text).toContain(`tool_use_id=${toolId}`);
  expect(app2.sdk.agents[0]?.lastSend?.text).toContain("tool=lookup");
});

test("corrupted lineage is isolated and does not grant resume", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  await closeTestApp(app1);
  apps.pop();

  const file = join(stateDir, "lineage", `${sessionId}.json`);
  writeFileSync(file, "{not-json", "utf8");

  const app2 = await startTestApp({
    config: { stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["stolen"] }]] },
  });
  apps.push(app2);
  const follow = await api(app2, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  expect(follow.status).toBe(409);
  expect(((await follow.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
  expect(app2.sdk.resumeCalls).toHaveLength(0);
  const names = readdirSync(join(stateDir, "lineage"));
  expect(names.some((name) => name.includes(".corrupt"))).toBe(true);
});

test("lineage files are owner-only and expire", async () => {
  const clock = new FakeClock(5_000);
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const store = new LineageStore(stateDir, clock);
  store.put({
    version: 2,
    sessionId: "ses_perm",
    sdkAgentId: "agent-1",
    credentialFingerprint: "fp",
    modelId: "composer-2.5",
    sessionPolicyFingerprint: "a".repeat(64),
    executableToolCatalogFingerprint: "b".repeat(64),
    state: "completed",
    pendingToolIds: [],
    createdAt: 5_000,
    lastActivityAt: 5_000,
    expiresAt: 6_000,
  });
  expect(store.dirMode()).toBe(0o700);
  expect(store.fileMode("ses_perm")).toBe(0o600);
  const raw = readFileSync(join(stateDir, "lineage", "ses_perm.json"), "utf8");
  expect(raw).not.toContain("sk-");
  expect(raw).not.toContain("prompt");
  clock.advance(2_000);
  store.sweep();
  expect(store.get("ses_perm")).toBeUndefined();
});

test("lineage expiry blocks follow-up after TTL", async () => {
  const clock = new FakeClock(1_000);
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-lineage-"));
  const app1 = await startTestApp({
    clock,
    config: { stateDir, sessionTtlMs: 500, sweepIntervalMs: 10_000 },
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  apps.push(app1);
  const first = await api(app1, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  await closeTestApp(app1);
  apps.pop();

  clock.advance(1_000);
  const app2 = await startTestApp({
    clock,
    config: { stateDir, sessionTtlMs: 500, sweepIntervalMs: 10_000 },
    sdk: { scripts: [[{ type: "text", chunks: ["late"] }]] },
  });
  apps.push(app2);
  app2.app.lineage.sweep();
  const follow = await api(app2, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 8,
      messages: [{ role: "user", content: "x" }],
    }),
  });
  expect(follow.status).toBe(409);
  expect(((await follow.json()) as { error: { type: string } }).error.type).toBe("cursor_session_lost");
  expect(app2.sdk.resumeCalls).toHaveLength(0);
});

test("createCursorRuntime opens JsonlLocalAgentStore under STATE_DIR", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-sdk-store-"));
  const runtime = createCursorRuntime({ stateDir });
  expect(runtime.sdkVersion).toBe("1.0.30");
  expect(existsSync(join(stateDir, "sdk-store"))).toBe(true);
});
