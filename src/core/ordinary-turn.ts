import {
  cursorAgentTurnLineageKey,
  ordinaryReplayKey,
  type CursorAgentTurn,
} from "./cursor-agent-turn.js";
import type { OrdinaryTurnJournal, OrdinaryTurnRecord } from "./ordinary-turn-journal.js";

export type OrdinaryTurnDecision =
  | { action: "tool_continuation"; reason: "legacy_tool_result" }
  | { action: "replay"; reason: "identical_digest"; record: OrdinaryTurnRecord }
  | { action: "fail_closed"; reason: "completed_without_in_memory_response"; record: OrdinaryTurnRecord }
  | {
      action: "singleflight";
      reason: "identical_digest" | "identical_digest_running";
      lineageKey: string;
      requestDigest: string;
      record?: OrdinaryTurnRecord;
    }
  | {
      action: "resume";
      reason: "exact_successor";
      record: OrdinaryTurnRecord;
    }
  | {
      action: "rebuild";
      reason:
        | "coordinator_disabled"
        | "concurrent_successor_fork"
        | "fork"
        | "ambiguous_parent"
        | "lineage_mismatch"
        | "expired"
        | "unknown_or_first";
      record?: OrdinaryTurnRecord;
    };

export function decideOrdinaryTurn(input: {
  turn: CursorAgentTurn;
  journal: OrdinaryTurnJournal;
  inflight: ReadonlySet<string>;
  now: number;
  enabled: boolean;
  hasReplay: boolean;
}): OrdinaryTurnDecision {
  const { turn, journal, inflight, now, enabled, hasReplay } = input;
  if (!enabled) return { action: "rebuild", reason: "coordinator_disabled" };
  if (turn.continuationToolIds.length > 0) {
    return { action: "tool_continuation", reason: "legacy_tool_result" };
  }

  journal.sweepExpired();
  const lineageKey = cursorAgentTurnLineageKey(turn);
  const requestDigest = turn.lineage.requestDigest;
  const key = ordinaryReplayKey(turn);
  if (inflight.has(key)) {
    return { action: "singleflight", reason: "identical_digest", lineageKey, requestDigest };
  }

  const exact = journal.findExact(lineageKey, requestDigest);
  if (exact?.state === "completed") {
    if (hasReplay) return { action: "replay", reason: "identical_digest", record: exact };
    return { action: "fail_closed", reason: "completed_without_in_memory_response", record: exact };
  }
  if (exact?.state === "running") {
    return {
      action: "singleflight",
      reason: "identical_digest_running",
      lineageKey,
      requestDigest,
      record: exact,
    };
  }

  const sameParent = journal.findByLineageKey(lineageKey);
  const runningOther = sameParent.find(
    (record) => record.state === "running" && record.requestDigest !== requestDigest,
  );
  if (runningOther) {
    return { action: "rebuild", reason: "concurrent_successor_fork", record: runningOther };
  }
  const completedOther = sameParent.find(
    (record) => record.state === "completed" && record.requestDigest !== requestDigest,
  );
  if (completedOther) {
    return { action: "rebuild", reason: "fork", record: completedOther };
  }

  const successors = journal.findByNextLineageKey(lineageKey);
  if (successors.length > 1) {
    return { action: "rebuild", reason: "ambiguous_parent" };
  }
  if (successors.length === 1) {
    const parent = successors[0]!;
    if (
      parent.tenantScope !== turn.tenantScope ||
      parent.effectiveModel !== turn.effectiveModel ||
      parent.toolCatalogDigest !== turn.lineage.toolCatalogDigest ||
      Number(parent.channelId || 0) !== Number(turn.channelId || 0)
    ) {
      return { action: "rebuild", reason: "lineage_mismatch", record: parent };
    }
    if (parent.expiresAt <= now) {
      return { action: "rebuild", reason: "expired", record: parent };
    }
    return { action: "resume", reason: "exact_successor", record: parent };
  }
  return { action: "rebuild", reason: "unknown_or_first" };
}
