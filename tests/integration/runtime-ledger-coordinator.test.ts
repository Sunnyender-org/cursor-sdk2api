import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RUNTIME_DB_FILENAME } from "../../src/core/runtime-ledger.js";
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

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  if (!condition()) throw new Error("timed out waiting for condition");
}

function bound(appCtx: TestContext) {
  const ledger = appCtx.app.ledger;
  const session = [...appCtx.app.registry.sessions.values()].find((item) => item.logicalKey);
  if (!ledger) throw new Error("runtime ledger is not open");
  if (!session?.logicalKey) throw new Error("session is not bound to a logical key");
  const run = ledger.getRunByLogicalKey(session.logicalKey);
  if (!run) throw new Error("ledger run is missing");
  return { ledger, session, run };
}

test("runtimeLedgerV2 claims one logical request and finalizes one receipt", async () => {
  ctx = await startTestApp({
    config: { runtimeLedgerV2: true },
    sdk: {
      scripts: [[{ type: "text", chunks: ["hello"] }]],
      finalUsage: { inputTokens: 4, outputTokens: 6 },
    },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(res.status).toBe(200);
  const { ledger, run } = bound(ctx);
  expect(run.state).toBe("finished");
  const receipt = ledger.getReceiptByRunId(run.id);
  expect(receipt?.state).toBe("finalized");
  expect(receipt?.usage).toEqual({ inputTokens: 4, outputTokens: 6 });
  expect(JSON.stringify(receipt)).not.toMatch(/sk-|prompt/i);
  expect(ledger.claimRun({
    agentId: run.agentId,
    logicalKey: run.logicalKey,
    runtimeProfile: "sdk",
    generation: run.generation,
  }).outcome).toBe("existing");
});

test("duplicate reconnect reuses the claim and does not send again", async () => {
  ctx = await startTestApp({
    config: { runtimeLedgerV2: true },
    sdk: {
      scripts: [[{ type: "text", chunks: ["hello"] }]],
      finalUsage: { inputTokens: 2, outputTokens: 3 },
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(first.status).toBe(200);
  const { ledger, run } = bound(ctx);
  const creates = ctx.sdk.createCalls.length;
  const sends = ctx.sdk.agents.reduce((total, agent) => total + agent.sendCount, 0);
  expect(creates).toBe(1);
  expect(sends).toBe(1);

  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.createCalls.length).toBe(creates);
  expect(ctx.sdk.agents.reduce((total, agent) => total + agent.sendCount, 0)).toBe(sends);
  const reconnect = ledger.claimRun({
    agentId: run.agentId,
    logicalKey: run.logicalKey,
    runtimeProfile: "sdk",
    generation: run.generation,
  });
  expect(reconnect.outcome).toBe("existing");
  expect(reconnect.run.id).toBe(run.id);
  expect(ledger.getReceiptByRunId(run.id)?.state).toBe("finalized");
});

test("disconnect after partial text detaches the writer but still finalizes a receipt", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let atGate!: () => void;
  const gated = new Promise<void>((resolve) => {
    atGate = resolve;
  });

  ctx = await startTestApp({
    config: { runtimeLedgerV2: true, firstEventTimeoutMs: 10_000 },
    sdk: {
      scripts: [[{ type: "text", chunks: ["HELLO", "WORLD"], pauseBetweenMs: 40 }]],
      finalUsage: { inputTokens: 3, outputTokens: 9 },
    },
    beforeApplyBoundary: async () => {
      atGate();
      await held;
    },
  });

  const ac = new AbortController();
  const pending = api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      ...TEXT_BODY,
      stream: true,
    }),
    signal: ac.signal,
  });
  const res = await pending;
  const reader = res.body?.getReader();
  if (!reader) throw new Error("missing body");
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    if (buf.includes("HELLO")) break;
  }
  expect(buf).toContain("HELLO");
  await gated;
  const fakeRun = ctx.sdk.agents[0]?.runs[0];
  expect(fakeRun).toBeTruthy();
  expect(fakeRun?.cancelled).toBe(false);
  ac.abort();
  await pending.catch(() => undefined);
  expect(fakeRun?.cancelled).toBe(false);
  expect(fakeRun?.waitCalls).toBeGreaterThanOrEqual(1);
  release();
  await waitFor(() => {
    const session = [...ctx.app.registry.sessions.values()].find((item) => item.ledgerRunId);
    return Boolean(session?.ledgerRunId && ctx.app.ledger?.getReceiptByRunId(session.ledgerRunId));
  });
  const { run, ledger } = bound(ctx);
  expect(fakeRun?.cancelled).toBe(false);
  expect(ledger.getReceiptByRunId(run.id)?.state).toBe("finalized");
  expect(ledger.getReceiptByRunId(run.id)?.usage).toEqual({ inputTokens: 3, outputTokens: 9 });
});

test("runtimeLedgerV2 false does not open or write the sqlite ledger", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello"] }]] },
  });
  expect(ctx.app.config.runtimeLedgerV2).toBe(false);
  expect(ctx.app.ledger).toBeUndefined();
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify(TEXT_BODY),
  });
  expect(res.status).toBe(200);
  expect(existsSync(join(ctx.app.config.stateDir, RUNTIME_DB_FILENAME))).toBe(false);
});
