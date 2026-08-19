import { afterEach, expect, test } from "vitest";
import { closeTestApp, startTestApp, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("health reports runtime capability truth without account data", async () => {
  ctx = await startTestApp({
    config: {
      capabilities: {
        messages: true,
        count_tokens: true,
        chat_completions: true,
        responses: true,
        streaming: true,
        thinking: true,
        images: true,
        tools: true,
        parallel_tools: true,
        replay: true,
        agent_resume: true,
        pending_tool_restart_resume: false,
        streaming_impl: "sdk_onDelta",
        store_backend: "jsonl",
      },
    },
  });
  const res = await fetch(`${ctx.url}/health`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    status: string;
    service: string;
    sdk_version: string;
    runtime: string;
    network: { proxy_configured: boolean; agent_transport: string; fetch_transport: string };
    capabilities: Record<string, boolean>;
    verification: Record<string, unknown>;
  };
  expect(body.status).toBe("ok");
  expect(body.service).toBe("cursor-sdk2api");
  expect(body.sdk_version).toBe("1.0.28");
  expect(body.runtime).toBe("local");
  expect(body.network).toEqual({
    proxy_configured: ctx.app.config.proxyConfigured,
    agent_transport: ctx.app.config.agentTransport,
    fetch_transport: ctx.app.config.fetchTransport,
  });
  expect(body.capabilities).toMatchObject({
    messages: true,
    count_tokens: true,
    chat_completions: true,
    responses: true,
    streaming: true,
    thinking: true,
    images: true,
    tools: true,
    parallel_tools: true,
    agent_resume: true,
    pending_tool_restart_resume: false,
    transcript_tool_recovery: true,
    stale_auth_recovery: true,
    managed_account_failover: true,
    streaming_impl: "sdk_onDelta",
    store_backend: "jsonl",
  });
  expect(body.verification).toMatchObject({
    live_smoke: false,
    streaming: "sdk_onDelta",
    thinking: "implemented_unverified_live",
    images: "implemented_unverified_live",
    parallel_tools: "implemented_unverified_live",
    chat_completions: "contract_tested_unverified_live",
    responses: "contract_tested_unverified_live",
  });
  expect(body.verification).not.toHaveProperty("contract_tests");
  expect(JSON.stringify(body)).not.toContain("spending");
  expect(JSON.stringify(body)).not.toContain("email");
});

test("health capabilities follow runtime config, not marketing constants", async () => {
  ctx = await startTestApp({
    config: {
      capabilities: {
        messages: true,
        count_tokens: true,
        chat_completions: false,
        responses: false,
        streaming: false,
        thinking: false,
        images: false,
        tools: true,
        parallel_tools: false,
        replay: false,
        agent_resume: false,
        pending_tool_restart_resume: false,
      },
    },
  });
  const body = (await (await fetch(`${ctx.url}/health`)).json()) as {
    capabilities: Record<string, boolean>;
  };
  expect(body.capabilities.streaming).toBe(false);
  expect(body.capabilities.parallel_tools).toBe(false);
  expect(body.capabilities.pending_tool_restart_resume).toBe(false);
});
