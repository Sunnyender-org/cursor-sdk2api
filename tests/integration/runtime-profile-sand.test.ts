import { afterEach, expect, test } from "vitest";
import { agentResourceDirs } from "../../src/sdk/cursor-runtime.js";
import { inspectSandLoader } from "../../src/sdk/sand-loader.js";
import { api, closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

const TEXT_BODY = {
  model: "composer-2.5",
  max_tokens: 16,
  messages: [{ role: "user", content: "hello" }],
};

test("sdk and sand isolate store and workspace directories", () => {
  const sdk = agentResourceDirs({
    stateDir: "/tmp/state",
    sdkWorkspaceRoot: "/tmp/empty",
    apiKey: "key-a",
    profile: "sdk",
  });
  const sand = agentResourceDirs({
    stateDir: "/tmp/state",
    sdkWorkspaceRoot: "/tmp/empty",
    apiKey: "key-a",
    profile: "sand",
  });
  expect(sdk.storeDir).toContain("sdk-store");
  expect(sand.storeDir).toContain("/sand/store/");
  expect(sand.workspaceDir).toContain("/sand/workspace/");
  expect(sdk.storeDir).not.toBe(sand.storeDir);
  expect(sdk.workspaceDir).not.toBe(sand.workspaceDir);
});

test("inspectSandLoader reports ready without leaking filesystem paths", () => {
  const health = inspectSandLoader();
  expect(health.sdk_version).toBe("1.0.30");
  expect(health.patch_contract_version).toBe("1.0.30");
  expect(JSON.stringify(health)).not.toMatch(/\/Users\/|node_modules|sand-sdk/);
});

test("Sand run is refused when Grok Bot access is not granted", async () => {
  ctx = await startTestApp({
    config: { runtimePolicy: { defaultProfile: "sand", allowRequestOverride: false, hostedSearchMode: "off" } },
    sdk: { scripts: [[{ type: "text", chunks: ["nope"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(res.status).toBe(403);
  expect(await res.text()).toMatch(/Sand is unavailable until Grok Bot access is granted/);
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("Sand run is refused when the loader is not ready", async () => {
  ctx = await startTestApp({
    config: { runtimePolicy: { defaultProfile: "sand", allowRequestOverride: false, hostedSearchMode: "off" } },
    sandHealth: {
      ready: false,
      sdk_version: "1.0.30",
      patch_contract_version: "1.0.30",
      reason: "original_hash",
    },
    assertSandAccess: async () => undefined,
    sdk: { scripts: [[{ type: "text", chunks: ["nope"] }]] },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(res.status).toBe(403);
  expect(await res.text()).toMatch(/Sand runtime is not ready/);
  expect(ctx.sdk.createCalls).toHaveLength(0);
});

test("granted Sand new session uses the sand workspace and does not attach an sdk session", async () => {
  ctx = await startTestApp({
    config: {
      runtimePolicy: { defaultProfile: "sdk", allowRequestOverride: true, hostedSearchMode: "off" },
    },
    assertSandAccess: async () => undefined,
    sdk: { scripts: [[{ type: "text", chunks: ["sand-hi"] }], [{ type: "text", chunks: ["sdk-hi"] }]] },
  });
  const sand = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: { "x-cursor-runtime-profile": "sand" },
    body: JSON.stringify(TEXT_BODY),
  });
  expect(sand.status).toBe(200);
  expect(ctx.sdk.createCalls[0]?.runtimeProfile).toBe("sand");
  expect(ctx.sdk.createCalls[0]?.workspaceDir).toMatch(/sand[/\\]workspace/);

  const follow = await api(ctx, "/v1/messages", {
    method: "POST",
    headers: {
      "x-cursor-runtime-profile": "sdk",
      "x-cursor-session-id": sand.headers.get("x-cursor-session-id") ?? "",
    },
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "again" }],
    }),
  });
  expect(follow.status).toBe(409);
  expect(await follow.text()).toMatch(/runtime profile does not match the session owner/);
});
