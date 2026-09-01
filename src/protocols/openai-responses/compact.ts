import type { ServerResponse } from "node:http";
import type { Clock } from "../../clock.js";
import {
  CompactAnchorStore,
  compactPolicyDigest,
  type CompactRecord,
} from "../../core/compact-anchor.js";
import type { RuntimeProfile } from "../../core/runtime-profile.js";
import { messageId, responseId } from "../../ids.js";
import { sendJson } from "../../server/http-util.js";
import { beginResponsesSse, writeResponsesEvent } from "./sse.js";
import type { ParsedResponses } from "./types.js";

export function mintLocalCompact(input: {
  store: CompactAnchorStore;
  account: string;
  profile: RuntimeProfile;
  parsed: ParsedResponses;
  sessionHint?: string;
}): { token: string; record: CompactRecord } {
  return input.store.mint({
    account: input.account,
    profile: input.profile,
    policyDigest: compactPolicyDigest(input.parsed.parsed, input.profile),
    model: input.parsed.parsed.model,
    transcriptDigest: input.parsed.compaction.sourceDigest,
    sessionId: input.sessionHint,
  });
}

export function bindCompactContinuation(input: {
  store: CompactAnchorStore;
  token: string;
  account: string;
  profile: RuntimeProfile;
  parsed: ParsedResponses;
}): CompactRecord {
  return input.store.verify(input.token, {
    account: input.account,
    profile: input.profile,
    policyDigest: compactPolicyDigest(input.parsed.parsed, input.profile),
    model: input.parsed.parsed.model,
  });
}

export function writeLocalCompactResponse(input: {
  res: ServerResponse;
  clock: Clock;
  requestId: string;
  stream: boolean;
  model: string;
  token: string;
  compactId: string;
  sessionId?: string;
}): void {
  const createdAt = Math.floor(input.clock.now() / 1000);
  const response = encodeCompactionResponse({
    compactId: input.compactId,
    token: input.token,
    model: input.model,
    createdAt,
    sessionId: input.sessionId,
  });
  if (!input.stream) {
    sendJson(
      input.res,
      200,
      response,
      input.requestId,
      input.sessionId ? { "x-cursor-session-id": input.sessionId } : {},
    );
    return;
  }
  beginResponsesSse(input.res, input.requestId, input.sessionId ?? "");
  const inProgress = {
    ...response,
    status: "in_progress",
    output: [],
    usage: null,
  };
  let sequence = 0;
  writeResponsesEvent(input.res, "response.created", { response: inProgress }, sequence++);
  writeResponsesEvent(input.res, "response.in_progress", { response: inProgress }, sequence++);
  const item = (response.output as Record<string, unknown>[])[0]!;
  writeResponsesEvent(input.res, "response.output_item.added", { output_index: 0, item }, sequence++);
  writeResponsesEvent(input.res, "response.output_item.done", { output_index: 0, item }, sequence++);
  writeResponsesEvent(input.res, "response.completed", { response }, sequence++);
  input.res.end();
}

export function encodeCompactionResponse(input: {
  compactId: string;
  token: string;
  model: string;
  createdAt: number;
  sessionId?: string;
}): Record<string, unknown> {
  const id = input.compactId.startsWith("cmp_") ? `resp_${input.compactId.slice(4)}` : responseId(messageId());
  const item = {
    id: input.compactId,
    type: "compaction",
    encrypted_content: input.token,
  };
  return {
    id,
    object: "response",
    created_at: input.createdAt,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: input.model,
    output: [item],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      usage_status: "unavailable",
    },
    ...(input.sessionId ? { cursor_session_id: input.sessionId } : {}),
  };
}
