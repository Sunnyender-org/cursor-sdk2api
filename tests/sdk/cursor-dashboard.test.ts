import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { fetchCursorDashboardQuota } from "../../src/account/cursor-dashboard.js";
import { readAccount } from "../../src/account/service.js";
import type { SdkAccountResult, SdkRuntime } from "../../src/sdk/port.js";
import { formatQuota, formatQuotaBreakdown } from "../../web/src/quota.js";
import type { AccountPayload } from "../../web/src/types.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function dashboardServer(
  handler: RequestListener,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("reads personal plan quota by exchanging the same Cursor user API key", async () => {
  const paths: string[] = [];
  const baseUrl = await dashboardServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      expect(request.headers.authorization).toBe("Bearer cursor-user-key");
      response.end(JSON.stringify({ accessToken: "dashboard-access" }));
      return;
    }
    expect(request.headers.authorization).toBe("Bearer dashboard-access");
    expect(request.headers["connect-protocol-version"]).toBe("1");
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({
        billingCycleStart: "1786520259000",
        billingCycleEnd: "1789198659000",
        planUsage: {
          totalSpend: 1965,
          includedSpend: 1965,
          remaining: 38035,
          limit: 40000,
          autoPercentUsed: 0.307,
          apiPercentUsed: 2.702,
          totalPercentUsed: 0.786,
        },
      }));
      return;
    }
    if (request.url?.endsWith("/GetPlanInfo")) {
      response.end(JSON.stringify({ planInfo: { planName: "Ultra", price: "$200/mo" } }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const quota = await fetchCursorDashboardQuota("cursor-user-key", { baseUrl });

  expect(paths).toEqual([
    "/auth/exchange_user_api_key",
    "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    "/aiserver.v1.DashboardService/GetPlanInfo",
  ]);
  expect(quota).toMatchObject({
    available: true,
    source: "cursor_dashboard_rpc",
    planName: "Ultra",
    planPrice: "$200/mo",
    usedUsd: 19.65,
    remainingUsd: 380.35,
    limitUsd: 400,
    otherModelsPercentUsed: 2.702,
  });
  if (quota.available) expect(quota.usedPercent).toBeCloseTo(4.9125);
  expect(JSON.stringify(quota)).not.toContain("cursor-user-key");
  expect(JSON.stringify(quota)).not.toContain("dashboard-access");
});

test("reports an invalid API key without reflecting the upstream body", async () => {
  const baseUrl = await dashboardServer((_request, response) => {
    response.statusCode = 401;
    response.end(JSON.stringify({ error: "rejected secret-cursor-key" }));
  });

  const quota = await fetchCursorDashboardQuota("secret-cursor-key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_dashboard_rpc",
    reason: "api_key_invalid",
    status: 401,
  });
  expect(JSON.stringify(quota)).not.toContain("secret-cursor-key");
});

test("coalesces simultaneous exchanges for the same credential", async () => {
  let exchanges = 0;
  const baseUrl = await dashboardServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      exchanges += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      response.end(JSON.stringify({ accessToken: "shared-access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { remaining: 900, limit: 1000 } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const [first, second] = await Promise.all([
    fetchCursorDashboardQuota("shared-key", { baseUrl }),
    fetchCursorDashboardQuota("shared-key", { baseUrl }),
  ]);

  expect(exchanges).toBe(1);
  expect(first.available).toBe(true);
  expect(second.available).toBe(true);
});

test("re-exchanges the User API Key when a dashboard token is rejected", async () => {
  let exchanges = 0;
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      exchanges += 1;
      response.end(JSON.stringify({ accessToken: exchanges === 1 ? "stale" : "fresh" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage") && request.headers.authorization !== "Bearer fresh") {
      response.statusCode = 401;
      response.end("expired");
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { remaining: 900, limit: 1000 } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(exchanges).toBe(2);
  expect(quota).toMatchObject({ available: true, remainingUsd: 9, limitUsd: 10 });
});

test("fails closed when dashboard JSON is malformed", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    response.end("not-json");
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_dashboard_rpc",
    reason: "dashboard_invalid_response",
  });
});

test("fails closed when dashboard omits all current-period usage fields", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: {} }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Ultra" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_dashboard_rpc",
    reason: "dashboard_invalid_response",
  });
});

test("does not follow dashboard redirects with a Bearer credential", async () => {
  let redirectedRequests = 0;
  const sink = await dashboardServer((_request, response) => {
    redirectedRequests += 1;
    response.end("{}");
  });
  const baseUrl = await dashboardServer((_request, response) => {
    response.statusCode = 302;
    response.setHeader("location", `${sink}/capture`);
    response.end();
  });

  const quota = await fetchCursorDashboardQuota("secret-key", { baseUrl });

  expect(quota).toMatchObject({ available: false, reason: "exchange_unavailable" });
  expect(redirectedRequests).toBe(0);
});

test("decodes Cursor dashboard Brotli bytes when a proxy strips Content-Encoding", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(brotliCompressSync(Buffer.from(JSON.stringify({
        planUsage: { includedSpend: 100, remaining: 900, limit: 1000 },
      }))));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({
    available: true,
    planName: "Pro",
    usedUsd: 1,
    remainingUsd: 9,
    limitUsd: 10,
  });
});

test("derives an exhausted included allowance that the dashboard omits", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({
        planUsage: {
          totalSpend: 3450,
          includedSpend: 2000,
          bonusSpend: 1450,
          limit: 2000,
          autoPercentUsed: 4,
          apiPercentUsed: 50,
          totalPercentUsed: 10,
        },
      }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro", price: "$20/mo" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({
    available: true,
    usedUsd: 20,
    remainingUsd: 0,
    limitUsd: 20,
    bonusSpendUsd: 14.5,
    usedPercent: 100,
  });
});

test("leaves remaining unreported when the included spend is unknown", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { totalSpend: 1200, limit: 2000, totalPercentUsed: 3.478 } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({ available: true, totalSpendUsd: 12, limitUsd: 20 });
  if (quota.available) expect(quota.remainingUsd).toBeUndefined();
});

test("omits used percent instead of reporting the total usage axis under the same name", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({
        planUsage: { totalSpend: 500, apiPercentUsed: 2.1, totalPercentUsed: 1.449 },
      }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({ available: true, totalSpendUsd: 5, cursorModelsPercentUsed: 1.449 });
  if (quota.available) expect(quota.usedPercent).toBeUndefined();
});

test("treats null-like usage fields as unreported instead of zero", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({
        planUsage: {
          limit: 2000,
          includedSpend: null,
          remaining: "",
          totalSpend: false,
          apiPercentUsed: [],
          autoPercentUsed: {},
          totalPercentUsed: 1.5,
        },
      }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({ available: true, limitUsd: 20, cursorModelsPercentUsed: 1.5 });
  if (quota.available) {
    expect(quota.usedUsd).toBeUndefined();
    expect(quota.remainingUsd).toBeUndefined();
    expect(quota.totalSpendUsd).toBeUndefined();
    expect(quota.usedPercent).toBeUndefined();
    expect(quota.otherModelsPercentUsed).toBeUndefined();
    expect(quota.autoModelsPercentUsed).toBeUndefined();
  }
});

test("fails closed when every current-period usage field is null-like", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({
        planUsage: { limit: null, remaining: "", includedSpend: false, totalSpend: [] },
      }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_dashboard_rpc",
    reason: "dashboard_invalid_response",
  });
});

test("reads a numeric usage string as a number", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { limit: "2000", includedSpend: "500" } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({ available: true, usedUsd: 5, remainingUsd: 15, limitUsd: 20, usedPercent: 25 });
});

test("publishes an over-limit included spend without a percentage and drops a negative one", async () => {
  const usage = async (planUsage: Record<string, unknown>) => {
    const baseUrl = await dashboardServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/auth/exchange_user_api_key") {
        response.end(JSON.stringify({ accessToken: "access" }));
        return;
      }
      if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
        response.end(JSON.stringify({ planUsage }));
        return;
      }
      response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
    });
    return fetchCursorDashboardQuota("key", { baseUrl });
  };

  const overLimit = await usage({ limit: 2000, includedSpend: 2500 });
  const negative = await usage({ limit: 2000, includedSpend: -500 });

  expect(overLimit).toMatchObject({ available: true, usedUsd: 25, limitUsd: 20 });
  if (overLimit.available) {
    expect(overLimit.remainingUsd).toBeUndefined();
    expect(overLimit.usedPercent).toBeUndefined();
  }
  expect(negative).toMatchObject({ available: true, limitUsd: 20 });
  if (negative.available) {
    expect(negative.usedUsd).toBeUndefined();
    expect(negative.remainingUsd).toBeUndefined();
    expect(negative.usedPercent).toBeUndefined();
  }
});

test("leaves used unreported when the remaining amount contradicts the limit", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { limit: 2000, remaining: 5000 } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("key", { baseUrl });

  expect(quota).toMatchObject({ available: true, remainingUsd: 50, limitUsd: 20 });
  if (quota.available) {
    expect(quota.usedUsd).toBeUndefined();
    expect(quota.usedPercent).toBeUndefined();
  }
});

async function consoleQuotaCell(planUsage: Record<string, unknown>): Promise<string> {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });
  const quota = await fetchCursorDashboardQuota("key", { baseUrl });
  if (!quota.available) throw new Error(quota.reason);
  const compactRecord = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  const account: SdkAccountResult = {
    ok: true,
    identity: { apiKeyName: "local-dev" },
    spending: compactRecord({
      source: quota.source,
      plan_name: quota.planName,
      used_usd: quota.usedUsd,
      total_spend_usd: quota.totalSpendUsd,
      bonus_spend_usd: quota.bonusSpendUsd,
    }),
    limits: compactRecord({
      remaining_usd: quota.remainingUsd,
      limit_usd: quota.limitUsd,
      used_percent: quota.usedPercent,
      cursor_models_percent_used: quota.cursorModelsPercentUsed,
      other_models_percent_used: quota.otherModelsPercentUsed,
    }),
  };
  const sdk = { getAccount: async () => account } as unknown as SdkRuntime;
  return formatQuota((await readAccount(sdk, "key")) as unknown as AccountPayload);
}

test("carries adapter output through the account payload into the console quota cell", async () => {
  expect(await consoleQuotaCell({
    totalSpend: 3450,
    includedSpend: 2000,
    bonusSpend: 1450,
    limit: 2000,
    totalPercentUsed: 10,
  })).toBe("$0.00 / $20.00");
  expect(await consoleQuotaCell({ totalSpend: 500, apiPercentUsed: 2.1, totalPercentUsed: 1.449 })).toBe("");
});

async function consoleAccountPayload(usagePayload: Record<string, unknown>): Promise<AccountPayload> {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify(usagePayload));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });
  const quota = await fetchCursorDashboardQuota("key", { baseUrl });
  if (!quota.available) throw new Error(quota.reason);
  const compactRecord = (record: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
  const account: SdkAccountResult = {
    ok: true,
    identity: { apiKeyName: "local-dev" },
    spending: compactRecord({ source: quota.source, on_demand_spend_usd: quota.onDemandSpendUsd }),
    limits: compactRecord({
      cursor_models_percent_used: quota.cursorModelsPercentUsed,
      other_models_percent_used: quota.otherModelsPercentUsed,
      auto_models_percent_used: quota.autoModelsPercentUsed,
      on_demand_limit_type: quota.onDemandLimitType,
      on_demand_individual_limit: quota.onDemandIndividualLimit,
      on_demand_individual_used: quota.onDemandIndividualUsed,
      on_demand_individual_remaining: quota.onDemandIndividualRemaining,
      on_demand_pooled_limit: quota.onDemandPooledLimit,
      on_demand_pooled_used: quota.onDemandPooledUsed,
      on_demand_pooled_remaining: quota.onDemandPooledRemaining,
    }),
  };
  const sdk = { getAccount: async () => account } as unknown as SdkRuntime;
  return (await readAccount(sdk, "key")) as unknown as AccountPayload;
}

test("carries the auto meter and both on-demand scopes into the console breakdown", async () => {
  const payload = await consoleAccountPayload({
    planUsage: { includedSpend: 1250, remaining: 750, limit: 2000, totalPercentUsed: 30, autoPercentUsed: 10, apiPercentUsed: 20 },
    spendLimitUsage: { limitType: "individual", totalSpend: 300, individualLimit: 5000, individualUsed: 300, individualRemaining: 4700 },
  });

  expect(payload.spending?.on_demand_spend_usd).toBe(3);
  expect(formatQuotaBreakdown(payload)).toBe(
    "Cursor Models 30.0% · Other Models 20.0% · Auto 10.0% · On-demand (individual) $3.00 used, $47.00 remaining, $50.00 limit",
  );
});

test("never renders an on-demand dollar the spend limit payload reported as null", async () => {
  const payload = await consoleAccountPayload({
    planUsage: { totalPercentUsed: 1.04, apiPercentUsed: 5.16, autoPercentUsed: 0.31 },
    spendLimitUsage: { limitType: "individual", individualLimit: 5000, individualUsed: null, individualRemaining: null },
  });

  expect(payload.limits).not.toHaveProperty("on_demand_individual_used");
  expect(payload.limits).not.toHaveProperty("on_demand_individual_remaining");
  expect(formatQuotaBreakdown(payload)).toBe(
    "Cursor Models 1.0% · Other Models 5.2% · Auto 0.3% · On-demand (individual) $50.00 limit",
  );
});
