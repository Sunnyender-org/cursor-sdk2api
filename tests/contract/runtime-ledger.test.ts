import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import { LineageStore } from "../../src/core/lineage-store.js";
import {
  RuntimeLedger,
  RuntimeLedgerError,
} from "../../src/core/runtime-ledger.js";

const FP = "ab".repeat(32);
const POLICY = "cd".repeat(32);
const CATALOG = "ef".repeat(32);
const DIGEST = "11".repeat(32);

const ledgers: RuntimeLedger[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (ledgers.length > 0) {
    ledgers.pop()?.close();
  }
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function openLedger(clock = new FakeClock(1_000_000), migrateLegacy = false): {
  ledger: RuntimeLedger;
  stateDir: string;
  clock: FakeClock;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-runtime-ledger-"));
  dirs.push(stateDir);
  const ledger = RuntimeLedger.open(stateDir, { clock, migrateLegacy });
  ledgers.push(ledger);
  return { ledger, stateDir, clock };
}

function seedAgent(ledger: RuntimeLedger, extras: { sdkAgentId?: string; profile?: "sdk" | "sand" } = {}) {
  return ledger.upsertAgent({
    credentialFingerprint: FP,
    runtimeProfile: extras.profile ?? "sdk",
    sdkAgentId: extras.sdkAgentId ?? "sdk-agent-1",
    model: "composer-2.5",
    policyDigest: POLICY,
  });
}

test("unique agent identity is fingerprint, profile, and sdk agent id", () => {
  const { ledger } = openLedger();
  const first = seedAgent(ledger);
  const again = seedAgent(ledger);
  expect(again.id).toBe(first.id);
  const otherAgent = seedAgent(ledger, { sdkAgentId: "sdk-agent-2" });
  expect(otherAgent.id).not.toBe(first.id);
  const sand = seedAgent(ledger, { profile: "sand" });
  expect(sand.id).not.toBe(first.id);
});

test("duplicate logical claim reconnects to the same owner", () => {
  const { ledger } = openLedger();
  const agent = seedAgent(ledger);
  const first = ledger.claimLogicalRun("logical-1", 0, {
    agentId: agent.id,
    runtimeProfile: "sdk",
  });
  expect(first.outcome).toBe("created");
  const second = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-1",
    runtimeProfile: "sdk",
    generation: 0,
  });
  expect(second.outcome).toBe("existing");
  expect(second.run.id).toBe(first.run.id);
  expect(second.run.generation).toBe(0);
});

test("finalizeRunWithReceipt is idempotent for the same run", () => {
  const { ledger } = openLedger();
  const agent = seedAgent(ledger);
  const claimed = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-receipt",
    runtimeProfile: "sdk",
    generation: 0,
  });
  const first = ledger.finalizeRunWithReceipt({
    runId: claimed.run.id,
    generation: 0,
    receiptId: "rct_same",
    terminalDigest: DIGEST,
    state: "finished",
    usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1 },
  });
  const second = ledger.finalizeRunWithReceipt({
    runId: claimed.run.id,
    generation: 0,
    receiptId: "rct_same",
    terminalDigest: DIGEST,
    state: "finished",
    usage: { inputTokens: 3, outputTokens: 5, cacheReadTokens: 1 },
  });
  expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
  expect(second.receipt.state).toBe("finalized");
  expect(ledger.getReceipt("rct_same")?.runId).toBe(claimed.run.id);
  expect(ledger.getRun(claimed.run.id)?.receiptId).toBe("rct_same");
  expect(() =>
    ledger.finalizeRunWithReceipt({
      runId: claimed.run.id,
      generation: 0,
      receiptId: "rct_other",
      terminalDigest: DIGEST,
      state: "finished",
      usage: { inputTokens: 3, outputTokens: 5 },
    }),
  ).toThrow(RuntimeLedgerError);
});

test("generation CAS rejects a stale owner", () => {
  const { ledger } = openLedger();
  const agent = seedAgent(ledger);
  const claimed = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-cas",
    runtimeProfile: "sdk",
    generation: 0,
  });
  ledger.persistObserveOffset(claimed.run.id, "offset-0", 0);
  const takeover = ledger.claimLogicalRun("logical-cas", 1, {
    agentId: agent.id,
    runtimeProfile: "sdk",
  });
  expect(takeover.outcome).toBe("existing");
  expect(takeover.run.id).toBe(claimed.run.id);
  expect(takeover.run.generation).toBe(1);
  try {
    ledger.persistObserveOffset(claimed.run.id, "stale", 0);
    throw new Error("expected stale generation to conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeLedgerError);
    expect((error as RuntimeLedgerError).code).toBe("conflict");
  }
  expect(() =>
    ledger.claimRun({
      agentId: agent.id,
      logicalKey: "logical-cas",
      runtimeProfile: "sdk",
      generation: 0,
    }),
  ).toThrow(RuntimeLedgerError);
  const live = ledger.persistObserveOffset(claimed.run.id, "offset-1", 1);
  expect(live.observeOffset).toBe("offset-1");
});

test("closing DatabaseSync and reopening restores run and receipt", () => {
  const { ledger, stateDir, clock } = openLedger();
  const agent = seedAgent(ledger);
  const claimed = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-reopen",
    runtimeProfile: "sdk",
    generation: 2,
    sdkRunId: "sdk-run-9",
  });
  ledger.recordInteractionDigests({
    runId: claimed.run.id,
    generation: 2,
    toolCallId: "toolu_1",
    toolName: "lookup",
    argsDigest: DIGEST,
    state: "delivered",
  });
  ledger.finalizeRunWithReceipt({
    runId: claimed.run.id,
    generation: 2,
    receiptId: "rct_reopen",
    terminalDigest: DIGEST,
    state: "finished",
    usage: { inputTokens: 9, outputTokens: 4 },
  });
  const runId = claimed.run.id;
  ledger.close();
  ledgers.pop();

  const reopened = RuntimeLedger.open(stateDir, { clock, migrateLegacy: false });
  ledgers.push(reopened);
  const run = reopened.getRun(runId);
  const receipt = reopened.getReceipt("rct_reopen");
  expect(run?.logicalKey).toBe("logical-reopen");
  expect(run?.sdkRunId).toBe("sdk-run-9");
  expect(run?.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  expect(run?.receiptId).toBe("rct_reopen");
  expect(receipt?.state).toBe("finalized");
  expect(receipt?.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
});

test("runtime_lost keeps a provisional receipt without fabricating usage", () => {
  const { ledger } = openLedger();
  const agent = seedAgent(ledger);
  const claimed = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-lost",
    runtimeProfile: "sdk",
    generation: 0,
  });
  expect(() =>
    ledger.finalizeRunWithReceipt({
      runId: claimed.run.id,
      generation: 0,
      receiptId: "rct_lost",
      terminalDigest: DIGEST,
      state: "runtime_lost",
      usage: { inputTokens: 99, outputTokens: 99 },
    }),
  ).toThrow(RuntimeLedgerError);
  const lost = ledger.finalizeRunWithReceipt({
    runId: claimed.run.id,
    generation: 0,
    receiptId: "rct_lost",
    terminalDigest: DIGEST,
    state: "runtime_lost",
  });
  expect(lost.run.state).toBe("runtime_lost");
  expect(lost.run.usage).toBeUndefined();
  expect(lost.receipt.state).toBe("provisional");
  expect(lost.receipt.usage).toBeUndefined();
  expect(lost.receipt.finalizedAt).toBeUndefined();
});

test("truncated lineage JSON is quarantined and the original file remains", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-runtime-ledger-"));
  dirs.push(stateDir);
  const lineageDir = join(stateDir, "lineage");
  mkdirSync(lineageDir, { recursive: true });
  const truncated = join(lineageDir, "ses_truncated.json");
  writeFileSync(truncated, "{not-json", "utf8");
  const clock = new FakeClock(1_000_000);
  const ledger = RuntimeLedger.open(stateDir, { clock, migrateLegacy: true });
  ledgers.push(ledger);
  expect(existsSync(truncated)).toBe(true);
  const quarantined = ledger.listQuarantine();
  expect(quarantined.some((row) => row.reason === "truncated_json")).toBe(true);
  expect(readdirSync(ledger.quarantineDir).length).toBeGreaterThan(0);
  expect(ledger.getRunByLogicalKey("ses_truncated")).toBeUndefined();
});

test("compatible lineage v2 imports and expired records quarantine", () => {
  const { ledger, stateDir, clock } = openLedger();
  const store = new LineageStore(stateDir, clock);
  store.put({
    version: 2,
    sessionId: "ses_ok",
    sdkAgentId: "sdk-agent-live",
    credentialFingerprint: FP,
    modelId: "composer-2.5",
    sessionPolicyFingerprint: POLICY,
    executableToolCatalogFingerprint: CATALOG,
    state: "awaiting_tool_results",
    pendingToolIds: ["toolu_live"],
    pendingCalls: [{ toolUseId: "toolu_live", name: "lookup" }],
    createdAt: clock.now(),
    lastActivityAt: clock.now(),
    expiresAt: clock.now() + 60_000,
  });
  store.put({
    version: 2,
    sessionId: "ses_expired",
    sdkAgentId: "sdk-agent-expired",
    credentialFingerprint: FP,
    modelId: "composer-2.5",
    sessionPolicyFingerprint: POLICY,
    executableToolCatalogFingerprint: CATALOG,
    state: "completed",
    pendingToolIds: [],
    createdAt: clock.now(),
    lastActivityAt: clock.now(),
    expiresAt: clock.now() - 1,
  });
  const report = ledger.importLegacyLineage();
  expect(report.importedRuns).toBe(1);
  expect(report.importedInteractions).toBe(1);
  expect(report.quarantined).toBe(1);
  const imported = ledger.getRunByLogicalKey("ses_ok");
  expect(imported?.state).toBe("awaiting_tool_results");
  expect(imported?.runtimeProfile).toBe("sdk");
  expect(existsSync(join(stateDir, "lineage", "ses_ok.json"))).toBe(true);
  expect(existsSync(join(stateDir, "lineage", "ses_expired.json"))).toBe(true);
  expect(ledger.listQuarantine().some((row) => row.logicalKey === "ses_expired" && row.reason === "expired")).toBe(
    true,
  );
});

test("usage API rejects prompt fields and secret-like strings", () => {
  const { ledger } = openLedger();
  const agent = seedAgent(ledger);
  const claimed = ledger.claimRun({
    agentId: agent.id,
    logicalKey: "logical-usage",
    runtimeProfile: "sdk",
    generation: 0,
  });
  const forbidden = {
    runId: claimed.run.id,
    generation: 0,
    receiptId: "rct_secret",
    terminalDigest: DIGEST,
    state: "finished" as const,
  };
  expect(() =>
    ledger.finalizeRunWithReceipt({
      ...forbidden,
      usage: { inputTokens: 1, outputTokens: 1, prompt: "hello" } as never,
    }),
  ).toThrow(RuntimeLedgerError);
  expect(() =>
    ledger.finalizeRunWithReceipt({
      ...forbidden,
      usage: { inputTokens: 1, outputTokens: 1, apiKey: "sk-testkey-ABCDEFGH" } as never,
    }),
  ).toThrow(RuntimeLedgerError);
  expect(() =>
    ledger.recordInteractionDigests({
      runId: claimed.run.id,
      generation: 0,
      toolCallId: "toolu_secret",
      toolName: "lookup",
      args: { q: "secret" },
      state: "delivered",
    } as never),
  ).toThrow(RuntimeLedgerError);
  expect(ledger.getReceipt("rct_secret")).toBeUndefined();
});

test("db file mode is owner-only when the filesystem honors chmod", () => {
  const { ledger } = openLedger();
  seedAgent(ledger);
  const mode = ledger.fileMode();
  expect(mode).toBeTypeOf("number");
  if (mode !== 0o600) {
    // match lineage-store: some filesystems ignore mode
    expect(statSync(ledger.dbPath).mode & 0o777).toBe(mode);
    return;
  }
  expect(mode).toBe(0o600);
});

test("RUNTIME_LEDGER_V2=0 still constructs a usable ledger", () => {
  const previous = process.env.RUNTIME_LEDGER_V2;
  process.env.RUNTIME_LEDGER_V2 = "0";
  try {
    const stateDir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-runtime-ledger-"));
    dirs.push(stateDir);
    const constructed = RuntimeLedger.open(stateDir, { clock: new FakeClock(1_000_000) });
    ledgers.push(constructed);
    const agent = seedAgent(constructed);
    expect(agent.id).toBeTruthy();
    expect(constructed.getRunByLogicalKey("missing")).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.RUNTIME_LEDGER_V2;
    else process.env.RUNTIME_LEDGER_V2 = previous;
  }
});
