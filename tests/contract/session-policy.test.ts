import { expect, test } from "vitest";
import {
  sessionPolicyFingerprint,
  type SessionPolicyInput,
} from "../../src/core/session-policy.js";
import type { AnthropicTool } from "../../src/protocols/anthropic/types.js";

const baseTool: AnthropicTool = {
  name: "lookup",
  sdk_name: "mcp__exa__lookup",
  tool_kind: "function",
  namespace: "mcp__exa",
  description: "Look up a value",
  input_schema: {
    type: "object",
    properties: {
      q: { type: "string", description: "query" },
      limit: { type: "integer" },
    },
    required: ["q"],
  },
};

const secondTool: AnthropicTool = {
  name: "fetch",
  description: "Fetch a value",
  input_schema: { type: "object", properties: { id: { type: "string" } } },
};

const base: SessionPolicyInput = {
  modelId: "composer-2.5",
  modelParams: [
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
  tools: [baseTool, secondTool],
  toolChoice: { mode: "named" as const, name: "mcp__exa__lookup", disableParallel: true },
};

test("session policy is stable across object keys, model params, and tool order", () => {
  const reordered = {
    ...base,
    modelParams: [...base.modelParams].reverse(),
    tools: [
      secondTool,
      {
        ...baseTool,
        input_schema: {
          required: ["q"],
          properties: {
            limit: { type: "integer" },
            q: { description: "query", type: "string" },
          },
          type: "object",
        },
      },
    ],
  };
  expect(sessionPolicyFingerprint(reordered)).toBe(sessionPolicyFingerprint(base));
});

const changes: Array<[string, Partial<SessionPolicyInput>]> = [
  ["model id", { modelId: "grok-4.6" }],
  ["model params", { modelParams: [{ id: "effort", value: "low" }] }],
  ["public tool name", { tools: [{ ...baseTool, name: "search" }, secondTool] }],
  ["SDK tool name", { tools: [{ ...baseTool, sdk_name: "mcp__exa__search" }, secondTool] }],
  ["tool kind", { tools: [{ ...baseTool, tool_kind: "custom" }, secondTool] }],
  ["namespace", { tools: [{ ...baseTool, namespace: "mcp__other" }, secondTool] }],
  ["description", { tools: [{ ...baseTool, description: "Different" }, secondTool] }],
  [
    "schema",
    {
      tools: [
        {
          ...baseTool,
          input_schema: { type: "object", properties: { q: { type: "number" } } },
        },
        secondTool,
      ],
    },
  ],
  ["choice policy", { toolChoice: { mode: "auto" as const, disableParallel: false } }],
];

test.each(changes)("session policy changes with %s", (_label, change) => {
  expect(sessionPolicyFingerprint({ ...base, ...change })).not.toBe(sessionPolicyFingerprint(base));
});
