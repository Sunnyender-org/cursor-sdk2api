import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { fetchCursorDashboardQuota } from "../../src/account/cursor-dashboard.js";

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
