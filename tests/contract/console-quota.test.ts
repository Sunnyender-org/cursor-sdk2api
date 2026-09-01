import { createServer, type RequestListener } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { fetchCursorSandQuota } from "../../src/account/cursor-dashboard.js";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const servers: ReturnType<typeof createServer>[] = [];
let ctx: TestContext | undefined;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
  ctx = undefined;
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function dashboardServer(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function grantedSandBaseUrl(): Promise<string> {
  return dashboardServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/auth/exchange_user_api_key") {
      response.end(JSON.stringify({ accessToken: "dashboard-access" }));
      return;
    }
    if (request.url?.endsWith("/GetSandAccessStatus")) {
      response.end(JSON.stringify({ state: "SAND_ACCESS_STATE_GRANTED" }));
      return;
    }
    if (request.url?.endsWith("/GetSandUsageStatus")) {
      response.end(JSON.stringify({
        usagePercent: 12.5,
        grokPlanLabel: "Grok Bot Plan",
        nextResetTimestampUtc: "2026-09-01T10:11:15.817Z",
      }));
      return;
    }
    response.statusCode = 404;
    response.end("{}");
  });
}

test("quota pair stacks at 390px without a wider min-width", () => {
  const css = readFileSync(join(repoRoot, "web/src/styles.css"), "utf8");
  expect(css).toMatch(
    /\.quota-pair\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(0,\s*1fr\)/,
  );
  expect(css).toMatch(
    /@media \(max-width:\s*390px\)\s*\{[\s\S]*?\.quota-pair[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/,
  );
  expect(css).toMatch(/\.quota-meter\s*\{[\s\S]*?padding:\s*16px/);
  expect(css).not.toMatch(/\.quota-meter[^{]*\{[^}]*min-width:\s*(?:3(?:9[1-9]|[0-9]{2,})|[4-9]\d{2,})px/);
});

test("console copy names Cursor quota and Grok Bot quota without internal terms", () => {
  const app = readFileSync(join(repoRoot, "web/src/App.tsx"), "utf8");
  expect(app).toContain("Cursor quota");
  expect(app).toContain("Grok Bot quota");
  expect(app).toContain("Cursor 额度");
  expect(app).toContain("Grok Bot 额度");
  expect(app).toContain("Applies to new sessions only.");
  expect(app).toContain("只对新会话生效。");
  expect(app).not.toMatch(/\bBeefAPI\b/);
  expect(app).not.toMatch(/\btype62\b/i);
  expect(app).not.toMatch(/\bRPC\b/);
});

test("invalid default_profile is rejected with 400", async () => {
  ctx = await startTestApp();
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "profile-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/default_profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, default_profile: "cpu" }),
  });
  const text = await response.text();
  expect(response.status).toBe(400);
  expect(text).toContain("default_profile is invalid");
  expect(text).not.toContain("profile-secret-key");
});

test("Sand default_profile is rejected until Grok Bot access is granted", async () => {
  ctx = await startTestApp();
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sand-blocked-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const response = await fetch(`${ctx.url}/v0/management/accounts/default_profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, default_profile: "sand" }),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("Sand is unavailable until Grok Bot access is granted");
});

test("granted Grok Bot access allows Sand for new sessions only", async () => {
  const baseUrl = await grantedSandBaseUrl();
  ctx = await startTestApp({
    fetchSandQuota: (apiKey) => fetchCursorSandQuota(apiKey, { baseUrl }),
  });
  const created = await fetch(`${ctx.url}/v0/management/accounts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: "sand-grant-secret-key" }),
  });
  const { account } = (await created.json()) as { account: { id: string } };

  const sdk = await fetch(`${ctx.url}/v0/management/accounts/default_profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, default_profile: "sdk" }),
  });
  expect(sdk.status).toBe(200);

  const sand = await fetch(`${ctx.url}/v0/management/accounts/default_profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: account.id, default_profile: "sand" }),
  });
  const text = await sand.text();
  expect(sand.status).toBe(200);
  expect(text).not.toContain("sand-grant-secret-key");
  const body = JSON.parse(text) as {
    default_profile: string;
    account: {
      grok_bot: { available: boolean; used_percent: number };
      runtime: { default_profile: string; applies_to_new_sessions: boolean; sand_selectable: boolean };
      limits?: { used_percent?: number };
    };
  };
  expect(body.default_profile).toBe("sand");
  expect(body.account.runtime).toMatchObject({
    default_profile: "sand",
    applies_to_new_sessions: true,
    sand_selectable: true,
  });
  expect(body.account.grok_bot.available).toBe(true);
  expect(body.account.grok_bot.used_percent).toBe(12.5);

  const probe = await fetch(`${ctx.url}/v0/management/accounts/probe?id=${encodeURIComponent(account.id)}`);
  const probed = await probe.json() as {
    account: { grok_bot: { used_percent: number }; runtime: { default_profile: string } };
  };
  expect(probed.account.runtime.default_profile).toBe("sand");
  expect(probed.account.grok_bot.used_percent).toBe(12.5);
});
