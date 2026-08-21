import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { GatewayError } from "../../src/errors.js";
import { Session } from "../../src/core/session.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

const apps: TestContext[] = [];

afterEach(async () => {
  while (apps.length > 0) {
    const ctx = apps.pop();
    if (ctx) await closeTestApp(ctx);
  }
});

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function textBody(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: extra.model ?? "composer-2.5",
    max_tokens: 16,
    messages: [{ role: "user", content }],
    ...extra,
  });
}

let sessionSeq = 0;

async function completeSession(ctx: TestContext, apiKey = "test-key-a"): Promise<string> {
  sessionSeq += 1;
  const res = await api(ctx, "/v1/messages", {
    apiKey,
    method: "POST",
    body: textBody(`hi-${sessionSeq}`),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { cursor_session_id: string }).cursor_session_id;
}

test("completed follow-up is limited by global and per-credential active runs", async () => {
  const ctx = await startTestApp({
    config: { globalActiveRuns: 1, perCredentialActiveRuns: 1, firstEventTimeoutMs: 10_000 },
    sdk: {
      scripts: [[{ type: "text", chunks: ["ok"] }], [{ type: "hang" }]],
    },
  });
  apps.push(ctx);
  const firstId = await completeSession(ctx);
  const secondId = await completeSession(ctx);

  const hangAbort = new AbortController();
  const hanging = api(ctx, "/v1/messages", {
    method: "POST",
    signal: hangAbort.signal,
    headers: { "x-cursor-session-id": firstId },
    body: textBody("again"),
  });
  await waitFor(() => ctx.app.registry.get(firstId)?.state === "running", "first follow-up running");

  const blocked = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": secondId },
    body: textBody("nope"),
  });
  expect(blocked.status).toBe(429);
  expect(((await blocked.json()) as { error: { type: string } }).error.type).toBe("rate_limited");

  const otherCred = await api(ctx, "/v1/messages", {
    apiKey: "other-key",
    method: "POST",
    body: textBody("new"),
  });
  expect(otherCred.status).toBe(429);

  hangAbort.abort();
  await hanging.catch(() => undefined);
});

test("global=2 allows a different credential while per-credential stays 1", async () => {
  const ctx = await startTestApp({
    config: { globalActiveRuns: 2, perCredentialActiveRuns: 1, firstEventTimeoutMs: 10_000 },
    sdk: {
      scripts: [[{ type: "text", chunks: ["ok"] }], [{ type: "hang" }]],
    },
  });
  apps.push(ctx);
  const ownerA = await completeSession(ctx, "owner-a");
  const ownerA2 = await completeSession(ctx, "owner-a");

  const hangAbort = new AbortController();
  const hanging = api(ctx, "/v1/messages", {
    apiKey: "owner-a",
    method: "POST",
    signal: hangAbort.signal,
    headers: { "x-cursor-session-id": ownerA },
    body: textBody("again"),
  });
  await waitFor(() => ctx.app.registry.get(ownerA)?.state === "running", "owner-a running");

  const sameCred = await api(ctx, "/v1/messages", {
    apiKey: "owner-a",
    method: "POST",
    headers: { "x-cursor-session-id": ownerA2 },
    body: textBody("nope"),
  });
  expect(sameCred.status).toBe(429);

  const otherCred = await api(ctx, "/v1/messages", {
    apiKey: "owner-b",
    method: "POST",
    body: textBody("hello"),
  });
  expect(otherCred.status).toBe(200);
  expect(((await otherCred.json()) as { content: Array<{ text?: string }> }).content.some((block) => block.text === "ok")).toBe(
    true,
  );

  hangAbort.abort();
  await hanging.catch(() => undefined);
});

test("persisted resume checks capacity before resumeAgent", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-cap-"));
  const app1 = await startTestApp({
    config: { stateDir, globalActiveRuns: 1, perCredentialActiveRuns: 1 },
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  apps.push(app1);
  const sessionId = await completeSession(app1);
  await closeTestApp(app1);
  apps.pop();

  const app2 = await startTestApp({
    config: { stateDir, globalActiveRuns: 1, perCredentialActiveRuns: 1, firstEventTimeoutMs: 10_000 },
    sdk: { scripts: [[{ type: "hang" }]] },
  });
  apps.push(app2);
  const hangAbort = new AbortController();
  const hanging = api(app2, "/v1/messages", {
    method: "POST",
    signal: hangAbort.signal,
    body: textBody("occupy"),
  });
  await waitFor(
    () => [...app2.app.registry.sessions.values()].some((session) => session.state === "running"),
    "occupying run",
  );
  expect(app2.sdk.resumeCalls).toHaveLength(0);

  const resumed = await api(app2, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: textBody("resume"),
  });
  expect(resumed.status).toBe(429);
  expect(app2.sdk.resumeCalls).toHaveLength(0);
  expect(app2.sdk.lastResume).toBeUndefined();

  hangAbort.abort();
  await hanging.catch(() => undefined);
});

test("drain rejects completed follow-up but still accepts awaiting tool_result", async () => {
  const ctx = await startTestApp({
    config: { firstEventTimeoutMs: 10_000 },
    sdk: {
      agentScripts: [
        [[{ type: "text", chunks: ["done"] }]],
        [
          [
            { type: "tools", calls: [{ name: "lookup", input: { q: "drain" } }] },
            { type: "text", chunks: ["drained"] },
          ],
        ],
      ],
    },
  });
  apps.push(ctx);
  const completedId = await completeSession(ctx);
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
  expect(opened.status).toBe(200);
  expect(toolId).toBeTruthy();

  ctx.app.beginShutdown();

  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-session-id": completedId },
    body: textBody("again"),
  });
  expect(follow.status).toBe(429);

  const continued = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "ok" }] }],
    }),
  });
  expect(continued.status).toBe(200);
  expect(((await continued.json()) as { content: Array<{ text?: string }> }).content.some((block) => block.text === "drained")).toBe(
    true,
  );
});

test("adopt refuses to replace a different live session", async () => {
  const ctx = await startTestApp();
  apps.push(ctx);
  const live = ctx.app.registry.create({ credentialFingerprint: "fp", modelId: "composer-2.5" });
  const other = new Session({
    sessionId: live.sessionId,
    credentialFingerprint: "fp",
    modelId: "composer-2.5",
    instanceId: ctx.app.registry.instanceId,
    clock: ctx.clock,
  });
  expect(() => ctx.app.registry.adopt(other)).toThrow(GatewayError);
  try {
    ctx.app.registry.adopt(other);
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect((error as GatewayError).code).toBe("cursor_session_conflict");
  }
  expect(ctx.app.registry.get(live.sessionId)).toBe(live);
});
