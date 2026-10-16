import { afterEach, expect, test } from "vitest";
import { api, closeTestApp, startTestApp, weatherTool, type TestContext } from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

test("usage is deferred on tool turns and confirmed once on the final turn", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "u" } }] },
          { type: "text", chunks: ["answer"] },
        ],
      ],
      liveUsage: { inputTokens: 99, outputTokens: 99, cacheReadTokens: 7, cacheWriteTokens: 3 },
      finalUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 4 },
    },
  });
  const first = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "go" }],
      tools: [weatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    content: Array<{ type: string; id?: string }>;
    usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number };
    usage_deferred?: boolean;
  };
  expect(toolTurn.usage.input_tokens).toBe(0);
  expect(toolTurn.usage.output_tokens).toBe(0);
  expect(toolTurn.usage.cache_creation_input_tokens).toBeUndefined();
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const id = toolTurn.content.find((block) => block.type === "tool_use")?.id;
  const second = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
      ],
    }),
  });
  const final = (await second.json()) as {
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  expect(second.status).toBe(200);
  // Cursor's SDK reports inputTokens as the TOTAL prompt size; Anthropic's
  // input_tokens excludes the cache fields, so 11 total - 2 cacheRead - 4 cacheWrite.
  expect(final.usage.input_tokens).toBe(5);
  expect(final.usage.output_tokens).toBe(5);
  expect(final.usage.cache_creation_input_tokens).toBe(4);
  expect(final.usage.cache_read_input_tokens).toBe(2);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);
});

test("usage fields are omitted as unavailable when the SDK does not report them", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["plain"] }]],
    },
  });
  const res = await api(ctx, "/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as {
    usage: { input_tokens: number; cache_creation_input_tokens?: number };
  };
  expect(body.usage.input_tokens).toBe(0);
  expect(body.usage.cache_creation_input_tokens).toBeUndefined();
  expect(JSON.stringify(body)).not.toContain("estimated");
});
