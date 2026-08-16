import { afterEach, expect, test } from "vitest";
import {
  api,
  closeTestApp,
  parseSse,
  responsesWeatherTool,
  startTestApp,
  type TestContext,
} from "../helpers/app.js";

let ctx: TestContext;

afterEach(async () => {
  if (ctx) await closeTestApp(ctx);
});

const tools = [
  responsesWeatherTool(),
  {
    type: "function" as const,
    name: "beta",
    description: "Second tool",
    parameters: { type: "object", properties: { n: { type: "number" } } },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function openaiError(body: unknown): { message: string; type: string; param: null; code: string } {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) throw new Error("expected OpenAI error object");
  return error as { message: string; type: string; param: null; code: string };
}

function outputOfType(body: { output?: unknown[] }, type: string): Record<string, unknown>[] {
  return (body.output ?? []).filter((item): item is Record<string, unknown> => isRecord(item) && item.type === type);
}

test("non-stream text returns a response object", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["hello ", "world"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
    }),
  });
  const body = (await res.json()) as {
    object: string;
    model: string;
    status: string;
    output: Array<{ type: string; role?: string; content?: Array<{ type: string; text?: string }> }>;
    usage: { input_tokens: number; output_tokens: number; total_tokens: number; usage_status?: string };
    cursor_session_id: string;
  };
  expect(res.status).toBe(200);
  expect(res.headers.get("x-request-id")).toBeTruthy();
  expect(res.headers.get("x-cursor-session-id")).toMatch(/^ses_/);
  expect(body.object).toBe("response");
  expect(body.model).toBe("composer-2.5");
  expect(body.status).toBe("completed");
  expect(body.output).toHaveLength(1);
  expect(body.output[0]).toMatchObject({
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "hello world", annotations: [] }],
  });
  expect(body.usage).toEqual({
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
    usage_status: "unavailable",
  });
  expect(body.cursor_session_id).toMatch(/^ses_/);
  expect(ctx.sdk.lastAllowlist).toEqual([]);
});

test("instructions and developer items stay in system context", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      instructions: "top rule",
      input: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "developer rule" }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("System:\ntop rule\ndeveloper rule");
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("user:\nhello");
  expect(ctx.sdk.agents[0]?.lastSend?.text).not.toContain("user:\ndeveloper rule");
});

test("stream lifecycle uses Responses event names and ends with response.completed", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "thinking", chunks: ["hmm"] }, { type: "text", chunks: ["A", "B"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      input: [{ type: "input_text", text: "hi" }],
    }),
  });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  expect(res.headers.get("x-cursor-session-id")).toMatch(/^ses_/);
  const raw = await res.text();
  expect(raw).not.toContain("data: [DONE]");
  const events = parseSse(raw);
  expect(events.every((event) => isRecord(event.data) && Number.isInteger(event.data.sequence_number))).toBe(true);
  expect(events.map((event) => event.event).slice(0, 2)).toEqual(["response.created", "response.in_progress"]);
  expect(events.at(-1)?.event).toBe("response.completed");
  expect(events.some((event) => event.event === "error")).toBe(false);

  const names = events.map((event) => event.event);
  const createdAt = names.indexOf("response.created");
  const reasoningAdded = names.indexOf("response.output_item.added");
  const reasoningDelta = names.indexOf("response.reasoning_summary_text.delta");
  const textDelta = names.indexOf("response.output_text.delta");
  const completedAt = names.lastIndexOf("response.completed");
  expect(createdAt).toBeLessThan(reasoningAdded);
  expect(reasoningAdded).toBeLessThan(reasoningDelta);
  expect(reasoningDelta).toBeLessThan(textDelta);
  expect(textDelta).toBeLessThan(completedAt);

  const reasoning = events
    .filter((event) => event.event === "response.reasoning_summary_text.delta")
    .map((event) => (isRecord(event.data) ? event.data.delta : undefined));
  const texts = events
    .filter((event) => event.event === "response.output_text.delta")
    .map((event) => (isRecord(event.data) ? event.data.delta : undefined));
  expect(reasoning).toEqual(["hmm"]);
  expect(texts).toEqual(["A", "B"]);

  const completed = events.at(-1)?.data;
  expect(isRecord(completed) && isRecord(completed.response)).toBe(true);
  const response = isRecord(completed) ? (completed.response as Record<string, unknown>) : {};
  expect(response.status).toBe("completed");
  expect(outputOfType({ output: response.output as unknown[] }, "reasoning")[0]).toMatchObject({
    type: "reasoning",
    summary: [{ type: "summary_text", text: "hmm" }],
  });
  expect(outputOfType({ output: response.output as unknown[] }, "message")[0]).toMatchObject({
    content: [{ type: "output_text", text: "AB" }],
  });
});

test("single function_call continuation stays on the same SDK run", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["sunny"] },
        ],
      ],
      finalUsage: {
        inputTokens: 11,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 4,
        reasoningTokens: 3,
      },
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "weather?",
      tools: [responsesWeatherTool()],
    }),
  });
  const toolTurn = (await first.json()) as {
    status: string;
    output: Array<{
      type: string;
      call_id?: string;
      name?: string;
      arguments?: string;
    }>;
    cursor_session_id: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      usage_deferred?: boolean;
      usage_status?: string;
    };
  };
  expect(first.status).toBe(200);
  expect(toolTurn.status).toBe("completed");
  const call = outputOfType(toolTurn, "function_call")[0];
  expect(call?.name).toBe("lookup");
  expect(call?.call_id).toBeTruthy();
  expect(JSON.parse(String(call?.arguments ?? ""))).toEqual({ q: "weather" });
  expect(toolTurn.usage).toMatchObject({
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    usage_deferred: true,
    usage_status: "deferred",
  });
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls ?? 0).toBe(0);

  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "message", role: "user", content: "weather?" },
        {
          type: "function_call",
          call_id: call?.call_id,
          name: call?.name,
          arguments: call?.arguments,
        },
        { type: "function_call_output", call_id: call?.call_id, output: "72F" },
      ],
      tools: [responsesWeatherTool()],
    }),
  });
  const final = (await second.json()) as {
    id: string;
    status: string;
    output: Array<{ type: string; content?: Array<{ text?: string }> }>;
    usage: {
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      input_tokens_details?: { cached_tokens: number };
      output_tokens_details?: { reasoning_tokens: number };
      usage_status?: string;
    };
  };
  expect(second.status).toBe(200);
  expect(final.status).toBe("completed");
  expect(outputOfType(final, "message")[0]?.content).toEqual([
    { type: "output_text", text: "sunny", annotations: [] },
  ]);
  expect(final.usage).toMatchObject({
    input_tokens: 11,
    output_tokens: 5,
    total_tokens: 16,
    cache_creation_input_tokens: 4,
    cache_read_input_tokens: 2,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 3 },
    usage_status: "sdk",
  });
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs[0]?.waitCalls).toBe(1);

  const replayPayload = {
    model: "composer-2.5",
    input: [{ type: "function_call_output", call_id: call?.call_id, output: "72F" }],
    tools: [responsesWeatherTool()],
  };
  const replay = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify(replayPayload),
  });
  const replayed = (await replay.json()) as {
    output: Array<{ type: string; content?: Array<{ text?: string }> }>;
    replayed?: boolean;
  };
  expect(replay.status).toBe(200);
  expect(outputOfType(replayed, "message")[0]?.content).toEqual([
    { type: "output_text", text: "sunny", annotations: [] },
  ]);
  expect(replayed.replayed).toBe(true);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toHaveLength(1);

  const streamReplay = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ ...replayPayload, stream: true }),
  });
  const replayEvents = parseSse(await streamReplay.text());
  const created = replayEvents.find((event) => event.event === "response.created")?.data;
  const completed = replayEvents.find((event) => event.event === "response.completed")?.data;
  expect(isRecord(created) && isRecord(created.response) && created.response.id).toBe(final.id);
  expect(isRecord(completed) && isRecord(completed.response) && completed.response.id).toBe(final.id);
  expect(isRecord(completed) && isRecord(completed.response) && completed.response.replayed).toBe(true);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toHaveLength(1);
});

test("parallel function calls require the full output batch", async () => {
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
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "do both" }] }],
      tools,
    }),
  });
  const toolTurn = (await first.json()) as {
    output: Array<{ call_id?: string; name?: string; arguments?: string; type: string }>;
  };
  const calls = outputOfType(toolTurn, "function_call");
  expect(calls).toHaveLength(2);
  expect(calls.map((call) => call.name).sort()).toEqual(["beta", "lookup"]);
  for (const call of calls) {
    expect(typeof call.arguments).toBe("string");
    JSON.parse(String(call.arguments));
  }

  const missing = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "function_call_output", call_id: calls[0]?.call_id, output: "only-one" }],
      tools,
    }),
  });
  expect(missing.status).toBe(422);
  expect(openaiError(await missing.json()).code).toBe("invalid_request");

  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: calls.map((call) => ({
        type: "function_call_output",
        call_id: call.call_id,
        output: "ok",
      })),
      tools,
    }),
  });
  const final = (await second.json()) as { output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(second.status).toBe(200);
  expect(outputOfType(final, "message")[0]?.content).toEqual([
    { type: "output_text", text: "both", annotations: [] },
  ]);
});

test("function_call_output text content arrays are passed as tool text", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "weather?", tools: [responsesWeatherTool()] }),
  });
  const call = outputOfType((await first.json()) as { output: unknown[] }, "function_call")[0];
  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        {
          type: "function_call_output",
          call_id: call?.call_id,
          output: [
            { type: "input_text", text: "72F" },
            { type: "input_text", text: "sunny" },
          ],
        },
      ],
      tools: [responsesWeatherTool()],
    }),
  });
  expect(second.status).toBe(200);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["72F\nsunny"]);
});

test("unsupported function_call_output image and file parts fail closed without consuming the tool", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] },
          { type: "text", chunks: ["done"] },
        ],
      ],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "weather?", tools: [responsesWeatherTool()] }),
  });
  const call = outputOfType((await first.json()) as { output: unknown[] }, "function_call")[0];
  const unsupported = [
    { type: "input_image", image_url: "data:image/png;base64,YQ==" },
    { type: "input_file", file_id: "file_test" },
    { type: "unknown", value: "nope" },
  ];
  for (const output of unsupported) {
    const rejected = await api(ctx, "/v1/responses", {
      method: "POST",
      body: JSON.stringify({
        model: "composer-2.5",
        input: [{ type: "function_call_output", call_id: call?.call_id, output: [output] }],
        tools: [responsesWeatherTool()],
      }),
    });
    expect(rejected.status).toBe(422);
    expect(openaiError(await rejected.json()).message).toMatch(/function_call_output/);
    expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toHaveLength(0);
  }
  const accepted = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "function_call_output", call_id: call?.call_id, output: "72F" }],
      tools: [responsesWeatherTool()],
    }),
  });
  expect(accepted.status).toBe(200);
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toEqual(["72F"]);
});

test("interleaved thinking and text keep one stable item per output kind", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [
        [
          { type: "thinking", chunks: ["a"] },
          { type: "text", chunks: ["answer"] },
          { type: "thinking", chunks: ["b"] },
        ],
      ],
    },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", stream: true, input: "hi" }),
  });
  const events = parseSse(await res.text());
  const added = events.filter((event) => event.event === "response.output_item.added");
  const done = events.filter((event) => event.event === "response.output_item.done");
  expect(added).toHaveLength(2);
  expect(done).toHaveLength(2);
  const addedIds = added.map((event) => (isRecord(event.data) && isRecord(event.data.item) ? event.data.item.id : undefined));
  expect(new Set(addedIds).size).toBe(2);
  const completed = events.find((event) => event.event === "response.completed")?.data;
  const output = isRecord(completed) && isRecord(completed.response) ? (completed.response.output as unknown[]) : [];
  expect(outputOfType({ output }, "reasoning")[0]).toMatchObject({
    summary: [{ type: "summary_text", text: "ab" }],
  });
  expect(outputOfType({ output }, "message")[0]).toMatchObject({
    content: [{ type: "output_text", text: "answer" }],
  });
});

test("stream function_call arguments are JSON on the done event", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "weather" } }] }, { type: "text", chunks: ["later"] }]],
    },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      input: "weather?",
      tools: [responsesWeatherTool()],
    }),
  });
  const events = parseSse(await res.text());
  const sequences = events.map((event) => (isRecord(event.data) ? event.data.sequence_number : undefined));
  expect(sequences).toEqual(sequences.map((_, index) => index));
  expect(events.at(-1)?.event).toBe("response.completed");
  const done = events.find((event) => event.event === "response.function_call_arguments.done");
  expect(isRecord(done?.data)).toBe(true);
  expect(isRecord(done?.data) && done.data.name).toBe("lookup");
  expect(JSON.parse(String(isRecord(done?.data) ? done?.data.arguments : ""))).toEqual({ q: "weather" });
  const completed = events.at(-1)?.data;
  const output = isRecord(completed) && isRecord(completed.response) ? (completed.response.output as unknown[]) : [];
  expect(outputOfType({ output }, "function_call")[0]).toMatchObject({
    type: "function_call",
    name: "lookup",
  });
});

test("reasoning_effort reuses existing model parameter rules", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "grok-4.6",
      reasoning: { effort: "xhigh" },
      cursor_model_params: [{ id: "fast", value: "false" }],
      input: "hi",
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.lastCreate?.modelId).toBe("grok-4.6");
  expect(ctx.sdk.lastCreate?.modelParams).toEqual([
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ]);
});

test("base64 input_image is forwarded to the SDK", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["seen"] }]] },
  });
  const data = "aGVsbG8=";
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: `data:image/png;base64,${data}` },
          ],
        },
      ],
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.images).toEqual([{ data, mimeType: "image/png" }]);
});

test("remote input_image fails closed instead of dropping the image", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: "https://example.com/cat.png" }],
        },
      ],
    }),
  });
  const error = openaiError(await res.json());
  expect(res.status).toBe(422);
  expect(error.type).toBe("invalid_request_error");
  expect(error.code).toBe("invalid_request");
  expect(error.param).toBeNull();
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("known optional include is accepted without expansion and unknown includes fail closed", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      include: ["reasoning.encrypted_content"],
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { output?: unknown };
  expect(body.output).toBeDefined();
  expect(ctx.sdk.lastCreate).toBeDefined();

  const unsupported = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      include: ["file_search_call.results"],
    }),
  });
  expect(unsupported.status).toBe(400);
  expect(openaiError(await unsupported.json()).message).toMatch(/unsupported include/);
});

test("previous_response_id and hosted tools fail closed", async () => {
  ctx = await startTestApp();
  const previous = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      previous_response_id: "resp_pretend",
      input: "hi",
    }),
  });
  const previousError = openaiError(await previous.json());
  expect([400, 422]).toContain(previous.status);
  expect(previousError.code).toBe("invalid_request");
  expect(previousError.message).toMatch(/previous_response_id/);

  const hosted = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "search",
      tools: [{ type: "web_search" }],
    }),
  });
  const hostedError = openaiError(await hosted.json());
  expect([400, 422]).toContain(hosted.status);
  expect(hostedError.code).toBe("invalid_request");
  expect(hostedError.message).toMatch(/web_search/);
  expect(ctx.sdk.lastCreate).toBeUndefined();
});

test("Responses required and named function tool_choice render harness directives", async () => {
  ctx = await startTestApp({ sdk: { scripts: [[{ type: "text", chunks: ["ok"] }]] } });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "hi",
      tool_choice: "required",
      tools,
    }),
  });
  expect(res.status).toBe(200);
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("must call at least one available custom MCP tool");
  expect(ctx.sdk.agents[0]?.lastSend?.text).toContain("Never use the SDK runtime cwd in tool arguments");

  const named = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "title this",
      tool_choice: { type: "function", name: "lookup" },
      tools,
    }),
  });
  expect(named.status).toBe(200);
  expect(ctx.sdk.agents.at(-1)?.lastSend?.text).toContain("must call the custom MCP tool lookup");
});

test("store=true fails closed while earlier function outputs may remain in full history", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] }, { type: "text", chunks: ["final"] }]],
        [[{ type: "text", chunks: ["new turn"] }]],
      ],
    },
  });
  const stored = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      store: true,
      input: "hi",
    }),
  });
  expect(openaiError(await stored.json()).message).toMatch(/store=true/);

  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "go",
      tools: [responsesWeatherTool()],
    }),
  });
  const call = outputOfType((await first.json()) as { output: unknown[] }, "function_call")[0];
  const history = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "function_call_output", call_id: call?.call_id, output: "x" },
        { type: "message", role: "user", content: "also this" },
      ],
    }),
  });
  expect(history.status).toBe(200);
  expect(outputOfType((await history.json()) as { output: unknown[] }, "message")[0]).toMatchObject({
    content: [{ text: "new turn" }],
  });
});

test("full Responses history resumes from only the latest trailing function outputs", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[
        { type: "tools", calls: [{ name: "lookup", input: { q: "latest" }, id: "call_latest" }] },
        { type: "text", chunks: ["continued"] },
      ]],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "go", tools: [responsesWeatherTool()] }),
  });
  expect(first.status).toBe(200);

  const resumed = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      tools: [responsesWeatherTool()],
      input: [
        { type: "message", role: "user", content: "old request" },
        { type: "function_call", call_id: "call_old", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_old", output: "old result" },
        { type: "message", role: "assistant", content: "old answer" },
        { type: "message", role: "user", content: "latest request" },
        { type: "function_call", call_id: "call_latest", name: "lookup", arguments: "{}" },
        { type: "function_call_output", call_id: "call_latest", output: "latest result" },
      ],
    }),
  });
  expect(resumed.status).toBe(200);
  expect(outputOfType((await resumed.json()) as { output: unknown[] }, "message")[0]).toMatchObject({
    content: [{ text: "continued" }],
  });
});

test("unknown and missing function_call_output ids fail closed", async () => {
  ctx = await startTestApp({
    sdk: {
      scripts: [[{ type: "tools", calls: [{ name: "lookup", input: { q: "1" } }] }, { type: "text", chunks: ["final"] }]],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "go",
      tools: [responsesWeatherTool()],
    }),
  });
  const unknown = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "function_call_output", call_id: "call_missing", output: "x" }],
    }),
  });
  const error = openaiError(await unknown.json());
  expect([400, 409, 422]).toContain(unknown.status);
  expect(["invalid_request", "cursor_session_lost"]).toContain(error.code);
  expect(error.param).toBeNull();
  expect(error.message).toBeTruthy();

  const missingId = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [{ type: "function_call_output", output: "x" }],
    }),
  });
  expect([400, 422]).toContain(missingId.status);
  expect(openaiError(await missingId.json()).message).toMatch(/call_id/);
  expect(first.status).toBe(200);
});

test("function_call_output ids from different sessions fail closed", async () => {
  ctx = await startTestApp({
    sdk: {
      agentScripts: [
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "a" } }] }, { type: "text", chunks: ["a"] }]],
        [[{ type: "tools", calls: [{ name: "lookup", input: { q: "b" } }] }, { type: "text", chunks: ["b"] }]],
      ],
    },
  });
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "a", tools: [responsesWeatherTool()] }),
  });
  const second = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: "b", tools: [responsesWeatherTool()] }),
  });
  const firstCall = outputOfType((await first.json()) as { output: unknown[] }, "function_call")[0];
  const secondCall = outputOfType((await second.json()) as { output: unknown[] }, "function_call")[0];
  const mixed = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: [
        { type: "function_call_output", call_id: firstCall?.call_id, output: "a" },
        { type: "function_call_output", call_id: secondCall?.call_id, output: "b" },
      ],
    }),
  });
  expect(mixed.status).toBe(409);
  expect(openaiError(await mixed.json()).code).toBe("cursor_session_conflict");
  expect(ctx.sdk.agents[0]?.runs[0]?.capturedToolResults).toHaveLength(0);
  expect(ctx.sdk.agents[1]?.runs[0]?.capturedToolResults).toHaveLength(0);
});

test("in-stream SDK errors use a Responses error event and no completed", async () => {
  ctx = await startTestApp({
    sdk: { scripts: [[{ type: "text", chunks: ["partial"] }, { type: "error", message: "upstream failed" }]] },
  });
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      stream: true,
      input: "hi",
    }),
  });
  const events = parseSse(await res.text());
  const sequences = events.map((event) => (isRecord(event.data) ? event.data.sequence_number : undefined));
  expect(sequences).toEqual(sequences.map((_, index) => index));
  expect(events.some((event) => event.event === "response.completed")).toBe(false);
  expect(
    events.some(
      (event) =>
        event.event === "response.output_text.delta" &&
        isRecord(event.data) &&
        event.data.delta === "partial",
    ),
  ).toBe(true);
  const failure = events.find((event) => event.event === "error");
  expect(failure?.event).toBe("error");
  expect(failure?.data).toMatchObject({
    type: "error",
    code: "cursor_upstream_error",
    sequence_number: expect.any(Number),
  });
});

test("OpenAI error shape is used before the stream starts", async () => {
  ctx = await startTestApp();
  const res = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({ model: "composer-2.5", input: [] }),
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
  const first = await api(ctx, "/v1/responses", {
    method: "POST",
    body: JSON.stringify({
      model: "composer-2.5",
      input: "first",
    }),
  });
  const sessionId = ((await first.json()) as { cursor_session_id: string }).cursor_session_id;
  const follow = await api(ctx, "/v1/responses", {
    method: "POST",
    headers: { "x-cursor-session-id": sessionId },
    body: JSON.stringify({
      model: "composer-2.5",
      input: "second",
    }),
  });
  const body = (await follow.json()) as { output: Array<{ type: string; content?: Array<{ text?: string }> }> };
  expect(follow.status).toBe(200);
  expect(follow.headers.get("x-cursor-session-id")).toBe(sessionId);
  expect(outputOfType(body, "message")[0]?.content).toEqual([
    { type: "output_text", text: "second", annotations: [] },
  ]);
  expect(ctx.sdk.agents.length).toBe(1);
  expect(ctx.sdk.agents[0]?.runs.length).toBe(2);
});
