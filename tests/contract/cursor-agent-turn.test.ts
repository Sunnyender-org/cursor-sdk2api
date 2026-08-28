import { expect, test } from "vitest";
import {
  cursorAgentTurnFromParsed,
  cursorAgentTurnLineageKey,
  currentTurnSendPayload,
  digestAssistantAnchor,
  nextCursorAgentTurnLineageKey,
  ordinaryReplayKey,
} from "../../src/core/cursor-agent-turn.js";
import { parseMessagesRequest } from "../../src/protocols/anthropic/parse.js";
import { parseResponsesRequest } from "../../src/protocols/openai-responses/parse.js";
import { sessionPolicyFingerprint } from "../../src/core/session-policy.js";

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

test("ordinary replay identity includes system and full conversation history", () => {
  const tenantScope = "d".repeat(64);
  const makeTurn = (system: string, firstUser: string) => cursorAgentTurnFromParsed(
    parseMessagesRequest({
      model: "composer-2.5",
      max_tokens: 16,
      system,
      messages: [
        { role: "user", content: firstUser },
        { role: "assistant", content: "same assistant anchor" },
        { role: "user", content: "same current text" },
      ],
    }),
    { tenantScope },
  );

  const systemA = makeTurn("system A", "same earlier user");
  const systemB = makeTurn("system B", "same earlier user");
  const historyB = makeTurn("system A", "different earlier user");

  expect(ordinaryReplayKey(systemB)).not.toBe(ordinaryReplayKey(systemA));
  expect(ordinaryReplayKey(historyB)).not.toBe(ordinaryReplayKey(systemA));
});

test("Responses executable tool identity changes cannot hit an old ordinary replay", () => {
  const tenantScope = "e".repeat(64);
  const namespaceTool = (namespace: string, parameters: Record<string, unknown>) => ({
    type: "namespace",
    name: namespace,
    tools: [{
      type: "function",
      name: "lookup",
      description: "Lookup",
      parameters,
    }],
  });
  const makeTurn = (additionalTool: Record<string, unknown>) => cursorAgentTurnFromParsed(
    parseResponsesRequest({
      model: "composer-2.5",
      input: [
        { type: "additional_tools", tools: [additionalTool] },
        { type: "message", role: "user", content: "same input" },
      ],
    }).parsed,
    { tenantScope, sourceProtocol: "responses" },
  );
  const schema = {
    type: "object",
    properties: { q: { type: "string", description: "query" } },
    required: ["q"],
  };
  const base = makeTurn(namespaceTool("mcp__exa", schema));
  const changedNamespace = makeTurn(namespaceTool("mcp__other", schema));
  const changedSdkName = structuredClone(base);
  changedSdkName.tools[0]!.sdk_name = "mcp__exa__search";
  changedSdkName.lineage.sessionPolicyFingerprint = sessionPolicyFingerprint({
    modelId: changedSdkName.originalModel,
    modelParams: [],
    tools: changedSdkName.tools,
    toolChoice: changedSdkName.toolChoice,
  });
  const changedKind = structuredClone(base);
  changedKind.tools[0]!.tool_kind = "custom";
  changedKind.lineage.sessionPolicyFingerprint = sessionPolicyFingerprint({
    modelId: changedKind.originalModel,
    modelParams: [],
    tools: changedKind.tools,
    toolChoice: changedKind.toolChoice,
  });
  const changedSchema = makeTurn(namespaceTool("mcp__exa", {
    type: "object",
    properties: { q: { type: "number", description: "query" } },
    required: ["q"],
  }));

  for (const changed of [changedNamespace, changedSdkName, changedKind, changedSchema]) {
    expect(ordinaryReplayKey(changed)).not.toBe(ordinaryReplayKey(base));
  }
});

test("ordinary replay identity is stable across equivalent object key order", () => {
  const tenantScope = "f".repeat(64);
  const makeTurn = (parameters: Record<string, unknown>) => cursorAgentTurnFromParsed(
    parseResponsesRequest({
      model: "composer-2.5",
      input: "same input",
      tools: [{ type: "function", name: "lookup", parameters }],
    }).parsed,
    { tenantScope, sourceProtocol: "responses" },
  );
  const original = makeTurn({
    type: "object",
    properties: { q: { type: "string", description: "query" } },
    required: ["q"],
  });
  const reordered = makeTurn({
    required: ["q"],
    properties: { q: { description: "query", type: "string" } },
    type: "object",
  });

  expect(ordinaryReplayKey(reordered)).toBe(ordinaryReplayKey(original));
});
