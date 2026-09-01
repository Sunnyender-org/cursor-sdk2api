import { expect, test } from "vitest";
import { parseResponsesRequest } from "../../src/protocols/openai-responses/parse.js";
import { parseChatCompletionsRequest } from "../../src/protocols/openai-chat/parse.js";
import { api, closeTestApp, startTestApp } from "../helpers/app.js";

test("hosted search stays fail closed by default", () => {
  expect(() =>
    parseResponsesRequest({
      model: "composer-2.5",
      input: "search",
      tools: [{ type: "web_search" }],
    }),
  ).toThrow(/web_search is not supported/);
});

test("HOSTED_SEARCH_MODE=auto accepts a bare web_search tool and rejects filters, required, named, and Chat options", () => {
  const parsed = parseResponsesRequest(
    {
      model: "composer-2.5",
      input: "search the web",
      tools: [{ type: "web_search" }, { type: "function", name: "lookup", parameters: { type: "object", properties: {} } }],
    },
    { hostedSearchMode: "auto" },
  );
  expect(parsed.parsed.hostedSearch).toBe(true);
  expect(parsed.parsed.tools.some((tool) => tool.name === "lookup")).toBe(true);
  expect(parsed.parsed.tools.some((tool) => tool.name === "web_search")).toBe(false);

  expect(() =>
    parseResponsesRequest(
      {
        model: "composer-2.5",
        input: "search",
        tools: [{ type: "web_search", user_location: { type: "approximate" } }],
      },
      { hostedSearchMode: "auto" },
    ),
  ).toThrow(/filters are not supported/);

  expect(() =>
    parseResponsesRequest(
      {
        model: "composer-2.5",
        input: "search",
        tools: [
          { type: "web_search" },
          { type: "function", name: "lookup", parameters: { type: "object", properties: {} } },
        ],
        tool_choice: "required",
      },
      { hostedSearchMode: "auto" },
    ),
  ).toThrow(/cannot be required or named/);

  expect(() =>
    parseResponsesRequest(
      {
        model: "composer-2.5",
        input: "search",
        tools: [{ type: "x_search" }],
      },
      { hostedSearchMode: "auto" },
    ),
  ).toThrow(/x_search is not supported/);

  expect(() =>
    parseChatCompletionsRequest({
      model: "composer-2.5",
      messages: [{ role: "user", content: "hi" }],
      web_search_options: { search_context_size: "low" },
    }),
  ).toThrow(/web_search_options is not supported/);
});

test("auto hosted search enables SDK webSearch allowlist on a live request", async () => {
  const ctx = await startTestApp({
    config: { runtimePolicy: { defaultProfile: "sdk", allowRequestOverride: false, hostedSearchMode: "auto" } },
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  try {
    const res = await api(ctx, "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "composer-2.5",
        input: "search the web",
        tools: [{ type: "web_search" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(ctx.sdk.createCalls[0]?.hostedSearch).toBe(true);
    expect(ctx.sdk.lastAllowlist).toEqual(["webSearch", "webFetch"]);
  } finally {
    await closeTestApp(ctx);
  }
});
