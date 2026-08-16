import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
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
