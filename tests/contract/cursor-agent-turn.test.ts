import { expect, test } from "vitest";
import {
  cursorAgentTurnFromParsed,
  cursorAgentTurnLineageKey,
  currentTurnSendPayload,
  digestAssistantAnchor,
  nextCursorAgentTurnLineageKey,
} from "../../src/core/cursor-agent-turn.js";
import { parseMessagesRequest } from "../../src/protocols/anthropic/parse.js";

test("string and block assistant content share an anchor", () => {
  expect(digestAssistantAnchor("hello world")).toBe(
    digestAssistantAnchor([{ type: "text", text: "hello world" }]),
  );
});

test("current-turn payload is only the latest user text", () => {
  const parsed = parseMessagesRequest({
    model: "grok-4.6",
    reasoning_effort: "xhigh",
    max_tokens: 16,
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "first" },
      { role: "user", content: "next" },
    ],
  });
  const turn = cursorAgentTurnFromParsed(parsed, { tenantScope: "a".repeat(64) });
  expect(turn.lineage.turnIndex).toBe(2);
  expect(turn.lineage.parentAssistantAnchor).toBe(digestAssistantAnchor("first"));
  expect(currentTurnSendPayload(turn)).toEqual({ text: "next", images: [] });
  expect(turn.effectiveModel).toContain("grok-4.6");
  expect(turn.effectiveModel).toContain("xhigh");
});

test("next lineage key is the successor parent/turn index", () => {
  const tenant = "b".repeat(64);
  const first = cursorAgentTurnFromParsed(
    parseMessagesRequest({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hello" }],
    }),
    { tenantScope: tenant },
  );
  const anchor = digestAssistantAnchor("first");
  const follow = cursorAgentTurnFromParsed(
    parseMessagesRequest({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "first" },
        { role: "user", content: "next" },
      ],
    }),
    { tenantScope: tenant },
  );
  expect(cursorAgentTurnLineageKey(follow)).toBe(nextCursorAgentTurnLineageKey(first, anchor));
});
