import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { fetchCursorSandQuota } from "../../src/account/cursor-dashboard.js";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;
const dashboardServers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  await Promise.all(dashboardServers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

test("account is partial when dashboard spending and limits are unavailable", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/account");
  const body = (await res.json()) as {
    status: string;
    identity: { api_key_name?: string };
    spending?: unknown;
    limits?: unknown;
    remaining?: unknown;
    capabilities: { identity: boolean; spending: boolean; limits: boolean };
    reasons: Record<string, string>;
  };
  expect(res.status).toBe(200);
  expect(body.status).toBe("partial");
  expect(body.identity.api_key_name).toBe("test-key");
  expect(body.spending).toBeUndefined();
  expect(body.limits).toBeUndefined();
  expect(body.remaining).toBeUndefined();
  expect(body.capabilities.identity).toBe(true);
  expect(body.capabilities.spending).toBe(false);
  expect(body.capabilities.limits).toBe(false);
  expect(body.reasons.spending).toBe("cursor_dashboard_unavailable");
});

test("account returns Cursor dashboard quota without exposing credentials", async () => {
  ctx = await startTestApp({
    sdk: {
      account: {
        ok: true,
        identity: { apiKeyName: "svc" },
        spending: { source: "cursor_dashboard_rpc", plan_name: "Ultra", used_usd: 19.65 },
        limits: { remaining_usd: 380.35, limit_usd: 400, used_percent: 4.9125 },
      },
    },
  });
  const raw = await (await api(ctx, "/v1/account", { apiKey: "secret-cursor-key" })).text();
  const body = JSON.parse(raw) as {
    status: string;
    spending: Record<string, unknown>;
    limits: Record<string, unknown>;
    capabilities: { spending: boolean; limits: boolean };
  };
  expect(body.status).toBe("ok");
  expect(body.spending.plan_name).toBe("Ultra");
  expect(body.limits.remaining_usd).toBe(380.35);
  expect(body.capabilities).toMatchObject({ spending: true, limits: true });
  expect(raw).not.toContain("secret-cursor-key");
});

test("account degrades when identity itself is unavailable", async () => {
  ctx = await startTestApp({
    sdk: { account: { ok: false, reason: "cursor_account_unavailable", message: "no me()" } },
  });
  const body = (await (await api(ctx, "/v1/account")).json()) as {
    status: string;
    identity: unknown;
    capabilities: { identity: boolean };
  };
  expect(body.status).toBe("unavailable");
  expect(body.identity).toBeNull();
  expect(body.capabilities.identity).toBe(false);
});

test("account never fabricates remaining quota when spending is missing", async () => {
  ctx = await startTestApp({
    sdk: {
      account: {
        ok: true,
        identity: { apiKeyName: "svc" },
      },
    },
  });
  const raw = await (await api(ctx, "/v1/account")).text();
  expect(raw).not.toContain("remaining");
  expect(raw).not.toContain("hard_limit");
});

async function dashboardServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  dashboardServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("account keeps Cursor period percent separate from Grok Bot weekly percent", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "dashboard-access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify({
        state: "SAND_ACCESS_STATE_GRANTED",
        blockReason: "SAND_ACCESS_BLOCK_REASON_NONE",
      }));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify({
        usagePercent: 12.5,
        hasAvailableUsage: true,
        grokPlanLabel: "Grok Bot Plan",
        nextResetTimestampUtc: "2026-09-01T10:11:15.817Z",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  ctx = await startTestApp({
    fetchSandQuota: (apiKey) => fetchCursorSandQuota(apiKey, { baseUrl }),
    sdk: {
      account: {
        ok: true,
        identity: { apiKeyName: "svc" },
        spending: { source: "cursor_dashboard_rpc", plan_name: "Ultra", used_usd: 19.65 },
        limits: { remaining_usd: 380.35, limit_usd: 400, used_percent: 4.9125 },
      },
    },
  });
  const raw = await (await api(ctx, "/v1/account", { apiKey: "grok-bot-secret-key" })).text();
  const body = JSON.parse(raw) as {
    limits: { used_percent: number };
    grok_bot: {
      available: boolean;
      used_percent: number;
      remaining_percent: number;
      plan_label?: string;
    };
    runtime: { default_profile: string; sand_selectable: boolean; applies_to_new_sessions: boolean };
    capabilities: { limits: boolean; grok_bot: boolean };
  };

  expect(body.capabilities).toMatchObject({ limits: true, grok_bot: true });
  expect(body.limits.used_percent).toBe(4.9125);
  expect(body.grok_bot).toMatchObject({
    available: true,
    used_percent: 12.5,
    remaining_percent: 87.5,
    plan_label: "Grok Bot Plan",
  });
  expect(body.limits.used_percent).not.toBe(body.grok_bot.used_percent);
  expect(raw).not.toContain("merged");
  expect(raw).not.toContain("grok-bot-secret-key");
  expect(raw).not.toContain("dashboard-access");
  expect(body.runtime).toMatchObject({
    default_profile: "sdk",
    sand_selectable: true,
    applies_to_new_sessions: true,
  });
});
