import { afterEach, expect, test } from "vitest";
import {
  api,
  closeTestApp,
  openaiWeatherTool,
  parseChatSse,
  startTestApp,
  type TestContext,
} from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

const tools = [
  openaiWeatherTool(),
  {
    type: "function" as const,
    function: {
      name: "beta",
      description: "Second tool",
      parameters: { type: "object", properties: { n: { type: "number" } } },
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function chatError(body: unknown): { message: string; type: string; param: null; code: string } {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) throw new Error("expected OpenAI error object");
  return error as { message: string; type: string; param: null; code: string };
}

test("non-stream text returns a chat.completion", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello ", "world"] }]] },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = (await res.json()) as {
    object: string;
    model: string;
    choices: Array<{
      index: number;
      message: { role: string; content: string | null };
      finish_reason: string;
    }>;
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    cursor_session_id: string;
  };
  expect(res.status).toBe(200);
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(res.headers.get("x-cursor-session-id")).toMatch(/^ses_/);
  expect(body.object).toBe("chat.completion");
  expect(body.model).toBe("composer-2.5");
  expect(body.choices).toHaveLength(1);
  expect(body.choices[0]?.message).toEqual({ role: "assistant", content: "hello world" });
  expect(body.choices[0]?.finish_reason).toBe("stop");
  expect(body.usage).toEqual({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    usage_status: "unavailable",
  });
  expect(body.cursor_session_id).toMatch(/^ses_/);
  expect(ctx.sdk.lastAllowlist).toEqual([]);
});

test("stream text uses data chunks and ends with [DONE]", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "thinking", chunks: ["hmm"] }, { type: "text", chunks: ["A", "B"] }]] },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("x-cursor-session-id")).toMatch(/^ses_/);
  const raw = await res.text();
  expect(raw).not.toMatch(/^event:/m);
  const frames = parseChatSse(raw);
  expect(frames.at(-1)).toBe("[DONE]");
  const chunks = frames.filter(isRecord);
  const first = chunks[0];
  const firstChoice = (first?.choices as Array<{ delta?: { role?: string } }>)?.[0];
  expect(firstChoice?.delta?.role).toBe("assistant");
  const reasoning = chunks.flatMap((chunk) => {
    const choice = (chunk.choices as Array<{ delta?: { reasoning_content?: string } }>)?.[0];
    return choice?.delta?.reasoning_content ? [choice.delta.reasoning_content] : [];
  });
  const texts = chunks.flatMap((chunk) => {
    const choice = (chunk.choices as Array<{ delta?: { content?: string } }>)?.[0];
    return choice?.delta?.content ? [choice.delta.content] : [];
  });
  expect(reasoning).toEqual(["hmm"]);
  expect(texts).toEqual(["A", "B"]);
  const finish = chunks.find((chunk) => {
    const choice = (chunk.choices as Array<{ finish_reason?: string | null }>)?.[0];
    return Boolean(choice?.finish_reason);
  });
  expect((finish?.choices as Array<{ finish_reason?: string }>)?.[0]?.finish_reason).toBe("stop");
});

test("single tool continuation stays on the same SDK run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["sunny"] },
        ],
      ],
      finalUsage: { inputTokens: 11, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 4 },
    },
  });
  const first = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "weather?" }],
      tools: [openaiWeatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    choices: Array<{
      finish_reason: string;
      message: {
        content: string | null;
        tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
      };
    }>;
    cursor_session_id: string;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      usage_deferred?: boolean;
      usage_status?: string;
    };
  };
  expect(first.status).toBe(200);
  expect(toolTurn.choices[0]?.finish_reason).toBe("tool_calls");
  const call = toolTurn.choices[0]?.message.tool_calls?.[0];
  expect(call?.type).toBe("function");
  expect(call?.function.name).toBe("lookup");
  expect(toolTurn.usage).toMatchObject({
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    usage_deferred: true,
    usage_status: "deferred",
  });
  expect(JSON.parse(call?.function.arguments ?? "")).toEqual({ q: "weather" });
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: toolTurn.choices[0]?.message.content ?? null,
          tool_calls: toolTurn.choices[0]?.message.tool_calls,
        },
        { role: "tool", tool_call_id: call?.id, content: "72F" },
      ],
      tools: [openaiWeatherTool()],
    }),
  });
  const final = (await second.json()) as {
    choices: Array<{ finish_reason: string; message: { content: string | null } }>;
    usage: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      usage_status?: string;
    };
  };
  expect(second.status).toBe(200);
  expect(final.choices[0]?.finish_reason).toBe("stop");
  expect(final.choices[0]?.message.content).toBe("sunny");
  expect(final.usage).toMatchObject({
    prompt_tokens: 11,
    completion_tokens: 5,
    total_tokens: 16,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 2,
    usage_status: "sdk",
  });
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);

  const replay = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: toolTurn.choices[0]?.message.content ?? null,
          tool_calls: toolTurn.choices[0]?.message.tool_calls,
        },
        { role: "tool", tool_call_id: call?.id, content: "72F" },
      ],
      tools: [openaiWeatherTool()],
    }),
  });
  const replayed = (await replay.json()) as {
    choices: Array<{ message: { content: string | null } }>;
    replayed?: boolean;
  };
  expect(replay.status).toBe(200);
  expect(replayed.choices[0]?.message.content).toBe("sunny");
  expect(replayed.replayed).toBe(true);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toHaveLength(1);
});

test("parallel tool continuation requires the full result batch", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          {
            type: "tools",
            calls: [
              { name: "lookup", input: { q: "a" } },
              { name: "beta", input: { n: 2 } },
            ],
          },
          { type: "text", chunks: ["both"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "do both" }],
      tools,
    }),
  });
  const toolTurn = (await first.json()) as {
    choices: Array<{
      message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    }>;
  };
  const calls = toolTurn.choices[0]?.message.tool_calls ?? [];
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.function.name).sort()).toEqual(["beta", "lookup"]);
  for (const call of calls) {
    expect(typeof call.function.arguments).toBe("string");
    JSON.parse(call.function.arguments);
  }

  const missing = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        { role: "user", content: "do both" },
        { role: "assistant", tool_calls: calls.map((call) => ({ ...call, type: "function" })) },
        { role: "tool", tool_call_id: calls[0]?.id, content: "only-one" },
      ],
      tools,
    }),
  });
  expect(missing.status).toBe(422);
  expect(chatError(await missing.json()).code).toBe("invalid_request");

  const second = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        { role: "user", content: "do both" },
        { role: "assistant", tool_calls: calls.map((call) => ({ ...call, type: "function" })) },
        ...calls.map((call) => ({ role: "tool", tool_call_id: call.id, content: "ok" })),
      ],
      tools,
    }),
  });
  const final = (await second.json()) as {
    choices: Array<{ message: { content: string | null } }>;
  };
  expect(second.status).toBe(200);
  expect(final.choices[0]?.message.content).toBe("both");
});

test("stream tool_calls are JSON-string arguments on the boundary chunk", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] }, { type: "text", chunks: ["later"] }]],
    },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
      tools: [openaiWeatherTool()],
    }),
  });
  const frames = parseChatSse(await res.text());
  expect(frames.at(-1)).toBe("[DONE]");
  const toolChunk = frames.filter(isRecord).find((chunk) => {
    const delta = (chunk.choices as Array<{ delta?: { tool_calls?: unknown } }>)?.[0]?.delta;
    return Array.isArray(delta?.tool_calls);
  });
  const toolCalls = (toolChunk?.choices as Array<{ delta?: { tool_calls?: Array<{ index: number; id: string; type: string; function: { name: string; arguments: string } }> } }>)?.[0]
    ?.delta?.tool_calls;
  expect(toolCalls?.[0]?.type).toBe("function");
  expect(toolCalls?.[0]?.function.name).toBe("lookup");
  expect(typeof toolCalls?.[0]?.function.arguments).toBe("string");
  expect(JSON.parse(toolCalls?.[0]?.function.arguments ?? "")).toEqual({ q: "weather" });
  const finish = frames.filter(isRecord).find((chunk) => {
    return Boolean((chunk.choices as Array<{ finish_reason?: string | null }>)?.[0]?.finish_reason);
  });
  expect((finish?.choices as Array<{ finish_reason?: string }>)?.[0]?.finish_reason).toBe("tool_calls");
});

test("include_usage emits a choices=[] usage chunk before [DONE]", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["ok"] }]],
      finalUsage: { inputTokens: 11, outputTokens: 5 },
    },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const frames = parseChatSse(await res.text());
  expect(frames.at(-1)).toBe("[DONE]");
  const usage = frames.filter(isRecord).find((chunk) => Array.isArray(chunk.choices) && chunk.choices.length === 0);
  expect(usage?.usage).toEqual({
    prompt_tokens: 11,
    completion_tokens: 5,
    total_tokens: 16,
    usage_status: "sdk",
  });
});

test("reasoning_effort reuses existing model parameter rules", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning_effort: "xhigh",
      cursor_model_params: [{ id: "fast", value: "false" }],
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.lastCreate?.modelId).toBe("grok-4.6");
  expect(ctx.sdk.lastCreate?.modelParams).toEqual([
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ]);
});

test("base64 image_url is forwarded to the SDK", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["seen"] }]] },
  });
  const data = "aGVsbG8=";
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this" },
            { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } },
          ],
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.images).toEqual([{ data, mimeType: "image/png" }]);
});

test("remote image_url fails closed instead of dropping the image", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/cat.png" } }],
        },
      ],
    }),
  });
  const error = chatError(await res.json());
  expect(res.status).toBe(422);
  expect(error.type).toBe("invalid_request_error");
  expect(error.code).toBe("invalid_request");
  expect(error.param).toBeNull();
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("unsupported n fails closed", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      n: 2,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const error = chatError(await res.json());
  expect([400, 422]).toContain(res.status);
  expect(error.type).toBe("invalid_request_error");
  expect(error.code).toBe("invalid_request");
  expect(error.param).toBeNull();
  expect(error.message).toMatch(/n must be 1/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("tool_choice required fails closed", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      tool_choice: "required",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const error = chatError(await res.json());
  expect(res.status).toBe(422);
  expect(error.code).toBe("invalid_request");
  expect(error.message).toMatch(/tool_choice/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("in-stream SDK errors use an OpenAI data frame before DONE", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["partial"] }, { type: "error", message: "upstream failed" }]] },
  });
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const frames = parseChatSse(await res.text());
  expect(frames.at(-1)).toBe("[DONE]");
  const failure = frames.filter(isRecord).find((frame) => isRecord(frame.error));
  expect(failure?.error).toMatchObject({ type: "api_error", code: "cursor_upstream_error" });
});

test("unknown tool_call_id fails closed", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] }, { type: "text", chunks: ["final"] }]],
    },
  });
  const first = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "go" }],
      tools: [openaiWeatherTool()],
    }),
  });
  const turn = (await first.json()) as {
    choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> } }>;
  };
  const call = turn.choices[0]?.message.tool_calls?.[0];
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", tool_calls: [{ ...call, type: "function" }] },
        { role: "tool", tool_call_id: "call_missing", content: "x" },
      ],
    }),
  });
  const error = chatError(await res.json());
  expect([400, 409, 422]).toContain(res.status);
  expect(["invalid_request", "cursor_session_lost"]).toContain(error.code);
  expect(error.param).toBeNull();
  expect(error.message).toBeTruthy();
});

test("OpenAI error shape is used before the stream starts", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", messages: [] }),
  });
  const body = (await res.json()) as { error: { message: string; type: string; param: null; code: string }; type?: string };
  expect([400, 422]).toContain(res.status);
  expect(body.type).toBeUndefined();
  expect(body.error.message).toBeTruthy();
  expect(body.error.type).toBe("invalid_request_error");
  expect(body.error.param).toBeNull();
  expect(body.error.code).toBe("invalid_request");
  expect(res.headers.get("x-request-id")).toBeTruthy();
});

test("completed follow-up with x-cursor-session-id reuses the Agent", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "text", chunks: ["first"] }], [{ type: "text", chunks: ["second"] }]],
    },
  });
  const first = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "first" }],
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const follow = await api(ctx, "/v1/chat/completions", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      messages: [{ role: "user", content: "second" }],
    }),
  });
  const body = (await follow.json()) as { choices: Array<{ message: { content: string | null } }> };
  expect(follow.status).toBe(200);
  expect(follow.headers.get("x-cursor-session-id")).toBe(sessionId);
  expect(body.choices[0]?.message.content).toBe("second");
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(2);
});
