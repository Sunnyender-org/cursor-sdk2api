import { afterEach, expect, test } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../../src/clock.js";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

const STALE_SDK_AUTH = "Authentication error If you are logged in, try logging out and back in.";

let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
});

async function addAccount(context: TestContext, apiKey: string): Promise<string> {
  const response = await fetch(`${context.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { account: { id: string } };
  return body.account.id;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function frozenClock(): FakeClock {
  return new FakeClock(1_000);
}

function messageBody(content: unknown = "hello", tools: unknown[] = []) {
  return {
    model: "composer-2.5",
    max_tokens: 256,
    messages: [{ role: "user", content }],
    tools,
  };
}

test("one gateway key round-robins new sessions across persistent Cursor accounts", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  for (let index = 0; index < 2; index += 1) {
    const response = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody(`hello ${index}`)),
    });
    expect(response.status).toBe(200);
  }

  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-a", "cursor-b"]);
});

test("managed routing chooses an account whose live catalog contains the requested model", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "claude-sonnet-4-6" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify({ ...messageBody(), model: "claude-sonnet-4-6" }),
  });
  expect(response.status).toBe(200);
  expect(ctx.sdk.lastCreate?.apiKey).toBe("cursor-b");
});

test("pre-semantic provider failure retries once on another managed account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "provider connection reset before first event" },
      },
      agentScripts: [[[{ type: "text", chunks: ["served-by-b"] }]]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "served-by-b")).toBe(true);
  expect(ctx.sdk.createCalls.map((call) => call.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-b"]);
});

test("pre-semantic failover reaches a healthy account without repeating one", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-c": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "provider connection reset before first event" },
        "cursor-c": { message: "provider connection reset before first event" },
      },
      scripts: [[{ type: "text", chunks: ["served-by-b"] }]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  await addAccount(ctx, "cursor-c");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "served-by-b")).toBe(true);
  const attempted = ctx.sdk.createCalls.map((call) => call.apiKey);
  expect(attempted).toEqual([...new Set(attempted)]);
  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-b"]);
});

test("a broken first pick cannot starve a healthy managed account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-c": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "provider connection reset before first event" },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  await addAccount(ctx, "cursor-c");

  for (let index = 0; index < 4; index += 1) {
    const response = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody(`hello ${index}`)),
    });
    expect(response.status).toBe(200);
  }

  const served = [...new Set(ctx.sdk.agents.map((agent) => agent.input.apiKey))].sort();
  expect(served).toEqual(["cursor-b", "cursor-c"]);
});

test("a pool-wide pre-semantic failure tries every compatible account once", async () => {
  ctx = await startTestApp({
    clock: frozenClock(),
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-c": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      createErrorsByApiKey: {
        "cursor-a": { message: "provider connection reset before first event" },
        "cursor-b": { message: "provider connection reset before first event" },
        "cursor-c": { message: "provider connection reset before first event" },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  await addAccount(ctx, "cursor-c");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("cursor_upstream_error");
  expect(ctx.sdk.createCalls.map((call) => call.apiKey).sort()).toEqual(["cursor-a", "cursor-b", "cursor-c"]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("stalling managed accounts cannot spend more than one failover budget", async () => {
  const clock = new FakeClock(1_000);
  ctx = await startTestApp({
    clock,
    config: {
      authMode: "managed",
      gatewayAccessKey: "gateway-key",
      managedCursorKey: undefined,
      firstEventTimeoutMs: 40_000,
    },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-c": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-d": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[{ type: "hang" }]],
    },
  });
  for (const apiKey of ["cursor-a", "cursor-b", "cursor-c", "cursor-d"]) await addAccount(ctx, apiKey);

  let settled = false;
  const pending = api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  }).then((response) => {
    settled = true;
    return response;
  });
  await waitFor(() => ctx!.sdk.createCalls.length === 1, "the original account to stall");
  clock.advance(40_000);
  await waitFor(() => ctx!.sdk.createCalls.length === 2, "one alternate account to stall");
  clock.advance(40_000);
  await waitFor(() => settled, "the request to end after one spent failover budget");

  const response = await pending;
  expect(response.status).toBe(504);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("cursor_timeout");
  expect(ctx.sdk.createCalls).toHaveLength(2);
  expect(clock.now() - 1_000).toBe(80_000);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("a pool-wide in-band auth failure probes once and stays a retryable upstream error", async () => {
  ctx = await startTestApp({
    clock: frozenClock(),
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-c": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[{ type: "error", message: STALE_SDK_AUTH, code: "NOT_LOGGED_IN" }]],
      credentialProbeByApiKey: { "cursor-a": "valid", "cursor-b": "valid", "cursor-c": "valid" },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  await addAccount(ctx, "cursor-c");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("cursor_upstream_error");
  const attempted = ctx.sdk.createCalls.map((call) => call.apiKey);
  expect(attempted).toHaveLength(4);
  expect(attempted[1]).toBe(attempted[0]);
  expect([...new Set(attempted)]).toHaveLength(3);
  expect(ctx.sdk.credentialProbeCalls).toEqual([attempted[0]]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("a definitively dead pool credential still exhausts as an authentication error", async () => {
  ctx = await startTestApp({
    clock: frozenClock(),
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: { "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] } },
      createErrorsByApiKey: { "cursor-a": { name: "AuthenticationError", message: "invalid api key" } },
      credentialProbeByApiKey: { "cursor-a": "invalid" },
    },
  });
  await addAccount(ctx, "cursor-a");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(401);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
  expect(ctx.sdk.credentialProbeCalls).toEqual([]);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("a semantic delta before an SDK auth failure keeps the request on one account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[
        { type: "text", chunks: ["partial"] },
        { type: "error", message: STALE_SDK_AUTH, code: "NOT_LOGGED_IN" },
      ]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify({ ...messageBody("hello"), stream: true }),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).toContain("authentication_error");
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.sdk.credentialProbeCalls).toEqual([]);
});

test("a non-streaming semantic delta before a provider failure keeps the request on one account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[
        { type: "text", chunks: ["partial"] },
        { type: "error", message: "provider connection reset after the first assistant delta" },
      ]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("hello")),
  });
  expect(response.status).toBe(502);
  expect(((await response.json()) as { error: { type: string } }).error.type).toBe("cursor_upstream_error");
  expect(ctx.sdk.createCalls).toHaveLength(1);
  expect(ctx.app.registry.activeCount()).toBe(0);
});

test("managed model catalog returns the union from every configured account", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "claude-sonnet-4-6" }, { id: "shared-model" }] },
        "cursor-b": { ok: true, models: [{ id: "grok-4.6" }, { id: "shared-model" }] },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const response = await api(ctx, "/v1/models", { apiKey: "gateway-key" });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { account_pool_size: number; data: Array<{ id: string }> };
  expect(body.account_pool_size).toBe(2);
  expect(body.data.map((model) => model.id).sort()).toEqual([
    "claude-sonnet-4-6",
    "grok-4.6",
    "shared-model",
  ]);
});

test("a busy compatible account returns 429 instead of model-unavailable", async () => {
  ctx = await startTestApp({
    config: {
      authMode: "managed",
      gatewayAccessKey: "gateway-key",
      managedCursorKey: undefined,
      globalActiveRuns: 4,
      perCredentialActiveRuns: 1,
      firstEventTimeoutMs: 10_000,
    },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "grok-4.6" }] },
      },
      agentScripts: [[[ { type: "hang" } ]]],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const abort = new AbortController();
  const hanging = api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    signal: abort.signal,
    body: JSON.stringify(messageBody("occupy composer")),
  });
  try {
    await waitFor(
      () => [...ctx!.app.registry.sessions.values()].some((session) => session.state === "running"),
      "compatible account to become busy",
    );
    const blocked = await api(ctx, "/v1/messages", {
      apiKey: "gateway-key",
      method: "POST",
      body: JSON.stringify(messageBody("retry composer")),
    });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { error: { type: string } }).error.type).toBe("rate_limited");
  } finally {
    abort.abort();
    await hanging.catch(() => undefined);
  }
});

test("tool continuation remains pinned to the original account while another session rotates", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      agentScripts: [
        [
          [
            { type: "tools", calls: [{ name: "lookup", input: { q: "weather" }, id: "sdk_pool_tool" }] },
            { type: "text", chunks: ["continued"] },
          ],
        ],
        [[{ type: "text", chunks: ["other"] }]],
      ],
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");

  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const firstBody = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = firstBody.content.find((item) => item.type === "tool_use")?.id;
  expect(toolId).toBeTruthy();

  const other = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("other session")),
  });
  expect(other.status).toBe(200);

  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody([
      { type: "tool_result", tool_use_id: toolId, content: "sunny" },
    ], [weatherTool()])),
  });
  expect(continued.status).toBe(200);
  expect(ctx.sdk.agents.map((agent) => agent.input.apiKey)).toEqual(["cursor-a", "cursor-b"]);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["sunny"]);
});

test("managed mode rejects the wrong gateway key and reports an empty pool", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
  });
  const wrong = await api(ctx, "/v1/messages", {
    apiKey: "cursor-account-key",
    method: "POST",
    body: JSON.stringify(messageBody()),
  });
  expect(wrong.status).toBe(401);

  const empty = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody()),
  });
  expect(empty.status).toBe(503);
  expect(await empty.text()).toContain("No Cursor accounts are configured");
});

test("managed account endpoint returns every account without exposing raw Cursor keys", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      accountsByApiKey: {
        "cursor-a": { ok: true, identity: { apiKeyName: "A" } },
        "cursor-b": { ok: true, identity: { apiKeyName: "B" } },
      },
    },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const response = await api(ctx, "/v1/account", { apiKey: "gateway-key" });
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).not.toContain("cursor-a");
  expect(text).not.toContain("cursor-b");
  const body = JSON.parse(text) as { pool: boolean; account_count: number; accounts: unknown[] };
  expect(body).toMatchObject({ pool: true, account_count: 2 });
  expect(body.accounts).toHaveLength(2);
});

test("restart recovery resolves the original account from persisted lineage", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-managed-pool-"));
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      scripts: [[
        { type: "tools", calls: [{ name: "lookup", input: { q: "weather" }, id: "sdk_restart_tool" }] },
      ]],
    },
  });
  await addAccount(ctx, "cursor-a");
  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const firstBody = (await first.json()) as { content: Array<{ type: string; id?: string }> };
  const toolId = firstBody.content.find((item) => item.type === "tool_use")?.id;
  expect(toolId).toBeTruthy();
  await closeTestApp(ctx);
  ctx = undefined;

  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { scripts: [[{ type: "text", chunks: ["recovered"] }]] },
  });
  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody([
      { type: "tool_result", tool_use_id: toolId, content: "sunny" },
    ], [weatherTool()])),
  });
  expect(continued.status).toBe(200);
  expect(ctx.sdk.lastResume?.apiKey).toBe("cursor-a");
});

test("full transcript cold-branches a tool continuation when its managed account was removed", async () => {
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined },
    sdk: {
      modelsByApiKey: {
        "cursor-a": { ok: true, models: [{ id: "composer-2.5" }] },
        "cursor-b": { ok: true, models: [{ id: "composer-2.5" }] },
      },
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] }]],
        [[
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["recovered-on-b"] },
        ]],
      ],
    },
  });
  const accountA = await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const opened = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("use tool", [weatherTool()])),
  });
  const openedBody = (await opened.json()) as {
    content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
  };
  const call = openedBody.content.find((item) => item.type === "tool_use");
  expect(ctx.sdk.agents[0]?.input.apiKey).toBe("cursor-a");
  expect(ctx.app.accounts.remove(accountA)).toBe(true);

  const continued = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 64,
      tools: [weatherTool()],
      messages: [
        { role: "user", content: "use tool" },
        { role: "assistant", content: [call] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: call?.id, content: "sunny" }] },
      ],
    }),
  });
  expect(continued.status).toBe(200);
  const body = (await continued.json()) as { content: Array<{ text?: string }> };
  expect(body.content.some((item) => item.text === "recovered-on-b")).toBe(true);
  expect(ctx.sdk.agents[1]?.input.apiKey).toBe("cursor-b");
  expect(ctx.sdk.agents[1]?.runs[0]?.capturedToolResults).toEqual(["sunny"]);
});

test("completed follow-up after restart stays on its original account", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-managed-follow-up-"));
  const modelsByApiKey = {
    "cursor-a": { ok: true as const, models: [{ id: "composer-2.5" }] },
    "cursor-b": { ok: true as const, models: [{ id: "composer-2.5" }] },
  };
  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { modelsByApiKey },
  });
  await addAccount(ctx, "cursor-a");
  await addAccount(ctx, "cursor-b");
  const advance = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("advance round robin")),
  });
  expect(advance.status).toBe(200);
  const first = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    body: JSON.stringify(messageBody("complete first turn")),
  });
  expect(first.status).toBe(200);
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const originalKey = ctx.sdk.lastCreate?.apiKey;
  expect(originalKey).toBe("cursor-b");
  await closeTestApp(ctx);
  ctx = undefined;

  ctx = await startTestApp({
    config: { authMode: "managed", gatewayAccessKey: "gateway-key", managedCursorKey: undefined, stateDir },
    sdk: { modelsByApiKey },
  });
  const followUp = await api(ctx, "/v1/messages", {
    apiKey: "gateway-key",
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify(messageBody("continue after restart")),
  });
  expect(followUp.status).toBe(200);
  expect(ctx.sdk.lastResume?.apiKey).toBe(originalKey);
});
