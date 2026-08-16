import { describe, expect, test } from "vitest";
import {
  buildGrokContinuation,
  buildGrokFirstRequest,
  buildSonnetContinuation,
  buildSonnetFirstRequest,
  buildTextRequest,
} from "../../integrations/new-api/smoke.mjs";

describe("new-api smoke contracts", () => {
  test("text targets the OpenAI-compatible endpoint", () => {
    const request = buildTextRequest("model-a");
    expect(request.path).toBe("/v1/chat/completions");
    expect(request.body.model).toBe("model-a");
  });

  test("Sonnet continuation preserves the tool_use id", () => {
    const first = buildSonnetFirstRequest("claude-sonnet-4-6");
    expect(first.path).toBe("/v1/messages");
    const continuation = buildSonnetContinuation("claude-sonnet-4-6", {
      content: [{ type: "tool_use", id: "toolu_1", name: "lookup_temperature", input: { value: "72F" } }],
    });
    expect(continuation.body.messages.at(-1)?.content[0].tool_use_id).toBe("toolu_1");
  });

  test("Grok continuation requires and returns both tool ids", () => {
    const first = buildGrokFirstRequest("grok-4.6");
    expect(first.body.parallel_tool_calls).toBe(true);
    const continuation = buildGrokContinuation("grok-4.6", {
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_a", type: "function", function: { name: "lookup_alpha", arguments: "{\"value\":\"A\"}" } },
            { id: "call_b", type: "function", function: { name: "lookup_beta", arguments: "{\"value\":\"B\"}" } },
          ],
        },
      }],
    });
    expect(continuation.body.messages.slice(-2).map((message: { tool_call_id: string }) => message.tool_call_id)).toEqual(["call_a", "call_b"]);
  });
});
