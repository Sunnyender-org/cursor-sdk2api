import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import { fetchCursorDashboardQuota, fetchCursorSandQuota } from "../../src/account/cursor-dashboard.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

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
    expect(request.headers["x-cursor-client-type"]).toBeUndefined();
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

const GRANTED_ACCESS = {
  state: "SAND_ACCESS_STATE_GRANTED",
  blockReason: "SAND_ACCESS_BLOCK_REASON_NONE",
};

const USAGE_FIXTURE = {
  usagePercent: 12.5,
  hasAvailableUsage: true,
  hasNonZeroIncludedLimit: true,
  grokPlanLabel: "Grok Bot Plan",
  currentPeriodStart: "2026-08-25T10:11:15.817Z",
  nextResetTimestampUtc: "2026-09-01T10:11:15.817Z",
};

test("reads Grok Bot weekly quota from Sand access and usage RPCs", async () => {
  const paths: string[] = [];
  const clientTypes: Array<string | undefined> = [];
  const baseUrl = await dashboardServer((request, response) => {
    paths.push(request.url ?? "");
    clientTypes.push(headerValue(request.headers["x-cursor-client-type"]));
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      expect(request.headers.authorization).toBe("Bearer cursor-user-key");
      response.end(JSON.stringify({ accessToken: "dashboard-access" }));
      return;
    }
    expect(request.headers.authorization).toBe("Bearer dashboard-access");
    expect(request.headers["connect-protocol-version"]).toBe("1");
    expect(request.headers["x-cursor-client-type"]).toBe("sand");
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify(GRANTED_ACCESS));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify(USAGE_FIXTURE));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const quota = await fetchCursorSandQuota("cursor-user-key", { baseUrl });

  expect(paths).toEqual([
    "/auth/exchange_user_api_key",
    "/aiserver.v1.DashboardService/GetSandAccessStatus",
    "/aiserver.v1.DashboardService/GetSandUsageStatus",
  ]);
  expect(clientTypes).toEqual([undefined, "sand", "sand"]);
  expect(quota).toEqual({
    available: true,
    source: "cursor_sand_rpc",
    accessState: "SAND_ACCESS_STATE_GRANTED",
    blockReason: "SAND_ACCESS_BLOCK_REASON_NONE",
    usedPercent: 12.5,
    remainingPercent: 87.5,
    planLabel: "Grok Bot Plan",
    currentPeriodStart: "2026-08-25T10:11:15.817Z",
    nextResetTimestampUtc: "2026-09-01T10:11:15.817Z",
    hasAvailableUsage: true,
    hasNonZeroIncludedLimit: true,
  });
  expect(JSON.stringify(quota)).not.toContain("cursor-user-key");
  expect(JSON.stringify(quota)).not.toContain("dashboard-access");
});

test("fails closed when Sand access is revoked or not granted", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "dashboard-access" }));
      return;
    }
    expect(request.headers["x-cursor-client-type"]).toBe("sand");
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify({
        state: "SAND_ACCESS_STATE_REVOKED",
        blockReason: "SAND_ACCESS_BLOCK_REASON_UNPAID",
      }));
      return;
    }
    response.statusCode = 500;
    response.end("{}");
  });

  const quota = await fetchCursorSandQuota("secret-sand-key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_sand_rpc",
    reason: "sand_access_not_granted",
    accessState: "SAND_ACCESS_STATE_REVOKED",
    blockReason: "SAND_ACCESS_BLOCK_REASON_UNPAID",
  });
  expect(JSON.stringify(quota)).not.toContain("secret-sand-key");
  expect(JSON.stringify(quota)).not.toContain("dashboard-access");
});

test("fails closed when Sand usage omits usagePercent", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify(GRANTED_ACCESS));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify({
        hasAvailableUsage: true,
        hasNonZeroIncludedLimit: true,
        grokPlanLabel: "Grok Bot Plan",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const quota = await fetchCursorSandQuota("key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_sand_rpc",
    reason: "sand_usage_percent_missing",
    accessState: "SAND_ACCESS_STATE_GRANTED",
    blockReason: "SAND_ACCESS_BLOCK_REASON_NONE",
  });
});

test("returns structured Sand usage when included limit is zero and usage is exhausted", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify({
        ...GRANTED_ACCESS,
        purchaseChannel: "web",
        isPaidTrialPlan: false,
        purchasableTiers: ["pro_plus", "ultra"],
      }));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify({
        usagePercent: 100,
        hasAvailableUsage: false,
        hasNonZeroIncludedLimit: false,
        includedLimitZero: true,
        usesPooledEnterpriseAllowance: false,
        grokPlanLabel: "Grok Bot Plan",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const quota = await fetchCursorSandQuota("zero-limit-key", { baseUrl });

  expect(quota).toEqual({
    available: true,
    source: "cursor_sand_rpc",
    accessState: "SAND_ACCESS_STATE_GRANTED",
    blockReason: "SAND_ACCESS_BLOCK_REASON_NONE",
    purchaseChannel: "web",
    isPaidTrialPlan: false,
    purchasableTiers: ["pro_plus", "ultra"],
    usedPercent: 100,
    remainingPercent: 0,
    planLabel: "Grok Bot Plan",
    hasAvailableUsage: false,
    hasNonZeroIncludedLimit: false,
    includedLimitZero: true,
    usesPooledEnterpriseAllowance: false,
  });
});

test("reuses in-memory granted Sand quota within the cache TTL", async () => {
  const paths: string[] = [];
  const baseUrl = await dashboardServer((request, response) => {
    paths.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "cached-access" }));
      return;
    }
    expect(request.headers["x-cursor-client-type"]).toBe("sand");
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify(GRANTED_ACCESS));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify(USAGE_FIXTURE));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const first = await fetchCursorSandQuota("sand-cache-key", { baseUrl });
  const second = await fetchCursorSandQuota("sand-cache-key", { baseUrl });

  expect(first.available).toBe(true);
  expect(second).toEqual(first);
  expect(paths.filter((path) => path.endsWith("/GetSandAccessStatus"))).toHaveLength(1);
  expect(paths.filter((path) => path.endsWith("/GetSandUsageStatus"))).toHaveLength(1);
  expect(JSON.stringify(second)).not.toContain("sand-cache-key");
  expect(JSON.stringify(second)).not.toContain("cached-access");
});

test("invalidates granted Sand cache after a later not-granted access response", async () => {
  let granted = true;
  const accessCalls: string[] = [];
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      accessCalls.push(granted ? "granted" : "revoked");
      response.end(JSON.stringify(granted
        ? GRANTED_ACCESS
        : { state: "SAND_ACCESS_STATE_NOT_GRANTED", blockReason: "SAND_ACCESS_BLOCK_REASON_NONE" }));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify(USAGE_FIXTURE));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const first = await fetchCursorSandQuota("sand-revoke-key", { baseUrl });
  granted = false;
  const revoked = await fetchCursorSandQuota("sand-revoke-key", { baseUrl, bypassCache: true });
  const after = await fetchCursorSandQuota("sand-revoke-key", { baseUrl });

  expect(first.available).toBe(true);
  expect(revoked).toMatchObject({ available: false, reason: "sand_access_not_granted" });
  expect(after).toMatchObject({ available: false, reason: "sand_access_not_granted" });
  expect(accessCalls).toEqual(["granted", "revoked", "revoked"]);
});

test("reports rejected Sand access without leaking credentials", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access-token-secret" }));
      return;
    }
    response.statusCode = 503;
    response.end(JSON.stringify({ error: "secret-sand-key denied" }));
  });

  const quota = await fetchCursorSandQuota("secret-sand-key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_sand_rpc",
    reason: "sand_access_rejected",
    status: 503,
  });
  expect(JSON.stringify(quota)).not.toContain("secret-sand-key");
  expect(JSON.stringify(quota)).not.toContain("access-token-secret");
});

test("reports unreachable Sand usage without treating it as granted", async () => {
  const baseUrl = await dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify(GRANTED_ACCESS));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      request.socket.destroy();
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });

  const quota = await fetchCursorSandQuota("usage-down-key", { baseUrl });

  expect(quota).toEqual({
    available: false,
    source: "cursor_sand_rpc",
    reason: "sand_usage_unreachable",
  });
});

test("does not send a Sand client type when reading current-period usage", async () => {
  const sandHeaders: Array<string | undefined> = [];
  const baseUrl = await dashboardServer((request, response) => {
    sandHeaders.push(headerValue(request.headers["x-cursor-client-type"]));
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "access" }));
      return;
    }
    if (request.url?.endsWith("/GetCurrentPeriodUsage")) {
      response.end(JSON.stringify({ planUsage: { remaining: 900, limit: 1000 } }));
      return;
    }
    response.end(JSON.stringify({ planInfo: { planName: "Pro" } }));
  });

  const quota = await fetchCursorDashboardQuota("period-key", { baseUrl });

  expect(quota.available).toBe(true);
  expect(sandHeaders.every((value) => value === undefined)).toBe(true);
});
