import { expect, test } from "vitest";
import {
  cursorAgentTurnFromParsed,
  cursorAgentTurnLineageKey,
  digestAssistantAnchor,
  nextCursorAgentTurnLineageKey,
} from "../../src/core/cursor-agent-turn.js";
import { decideOrdinaryTurn } from "../../src/core/ordinary-turn.js";
import { OrdinaryTurnJournal } from "../../src/core/ordinary-turn-journal.js";
import { parseMessagesRequest } from "../../src/protocols/anthropic/parse.js";

const TENANT = "c".repeat(64);

function turn(messages: Array<{ role: string; content: string }>, extras: { model?: string } = {}) {
  return cursorAgentTurnFromParsed(
    parseMessagesRequest({
      model: extras.model ?? "composer-2.5",
      max_tokens: 16,
      messages,
    }),
    { tenantScope: TENANT },
  );
}

function makeJournal() {
  return new OrdinaryTurnJournal("", { now: () => 10 });
}

function completedRecord(first: ReturnType<typeof turn>, assistant = "first") {
  const assistantAnchor = digestAssistantAnchor(assistant);
  return {
    lineageKey: cursorAgentTurnLineageKey(first),
    requestDigest: first.lineage.requestDigest,
    nextLineageKey: nextCursorAgentTurnLineageKey(first, assistantAnchor),
    tenantScope: first.tenantScope,
    route: first.route,
    channelId: first.channelId,
    effectiveModel: first.effectiveModel,
    parentAssistantAnchor: first.lineage.parentAssistantAnchor,
    turnIndex: first.lineage.turnIndex,
    toolCatalogDigest: first.lineage.toolCatalogDigest,
    sessionPolicyFingerprint: first.lineage.sessionPolicyFingerprint,
    assistantAnchor,
    agentId: "agent-1",
    credentialFingerprint: TENANT,
    state: "completed" as const,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 1_000_000,
  };
}

test("unknown first turn rebuilds", () => {
  const store = makeJournal();
  const decision = decideOrdinaryTurn({
    turn: turn([{ role: "user", content: "hello" }]),
    journal: store,
    inflight: new Set(),
    now: 10,
    enabled: true,
    hasReplay: false,
  });
  expect(decision).toEqual({ action: "rebuild", reason: "unknown_or_first" });
});

test("exact successor resumes", () => {
  const store = makeJournal();
  const first = turn([{ role: "user", content: "hello" }]);
  store.upsert(completedRecord(first));
  const follow = turn([
    { role: "user", content: "hello" },
    { role: "assistant", content: "first" },
    { role: "user", content: "next" },
  ]);
  const decision = decideOrdinaryTurn({
    turn: follow,
    journal: store,
    inflight: new Set(),
    now: 10,
    enabled: true,
    hasReplay: false,
  });
  expect(decision.action).toBe("resume");
  expect(decision.reason).toBe("exact_successor");
});

test("forked successor rebuilds", () => {
  const store = makeJournal();
  const first = turn([{ role: "user", content: "hello" }]);
  store.upsert(completedRecord(first));
  const pathA = turn([
    { role: "user", content: "hello" },
    { role: "assistant", content: "first" },
    { role: "user", content: "path-a" },
  ]);
  store.upsert({
    ...completedRecord(first),
    lineageKey: cursorAgentTurnLineageKey(pathA),
    requestDigest: pathA.lineage.requestDigest,
    parentAssistantAnchor: pathA.lineage.parentAssistantAnchor,
    turnIndex: pathA.lineage.turnIndex,
  });
  const pathB = turn([
    { role: "user", content: "hello" },
    { role: "assistant", content: "first" },
    { role: "user", content: "path-b" },
  ]);
  const decision = decideOrdinaryTurn({
    turn: pathB,
    journal: store,
    inflight: new Set(),
    now: 10,
    enabled: true,
    hasReplay: false,
  });
  expect(decision).toMatchObject({ action: "rebuild", reason: "fork" });
});

test("identical digest without in-memory replay fails closed", () => {
  const store = makeJournal();
  const first = turn([{ role: "user", content: "hello" }]);
  store.upsert(completedRecord(first));
  const decision = decideOrdinaryTurn({
    turn: first,
    journal: store,
    inflight: new Set(),
    now: 10,
    enabled: true,
    hasReplay: false,
  });
  expect(decision.action).toBe("fail_closed");
});

test("exact replay validates the stored session policy before replaying", () => {
  const store = makeJournal();
  const first = turn([{ role: "user", content: "hello" }]);
  store.upsert({ ...completedRecord(first), sessionPolicyFingerprint: "a".repeat(64) });

  expect(decideOrdinaryTurn({
    turn: first,
    journal: store,
    inflight: new Set(),
    now: 10,
    enabled: true,
    hasReplay: true,
  })).toMatchObject({ action: "rebuild", reason: "lineage_mismatch" });
});

test("disabled coordinator always rebuilds", () => {
  const decision = decideOrdinaryTurn({
    turn: turn([{ role: "user", content: "hello" }]),
    journal: new OrdinaryTurnJournal(),
    inflight: new Set(),
    now: 10,
    enabled: false,
    hasReplay: false,
  });
  expect(decision).toEqual({ action: "rebuild", reason: "coordinator_disabled" });
});

test("ordinary successor rebuilds when the stored policy fingerprint is absent or changed", () => {
  const first = turn([{ role: "user", content: "hello" }]);
  const follow = turn([
    { role: "user", content: "hello" },
    { role: "assistant", content: "first" },
    { role: "user", content: "next" },
  ]);
  for (const sessionPolicyFingerprint of [undefined, "a".repeat(64)]) {
    const store = makeJournal();
    store.upsert({ ...completedRecord(first), sessionPolicyFingerprint });
    expect(
      decideOrdinaryTurn({
        turn: follow,
        journal: store,
        inflight: new Set(),
        now: 10,
        enabled: true,
        hasReplay: false,
      }),
    ).toMatchObject({ action: "rebuild", reason: "lineage_mismatch" });
  }
});
