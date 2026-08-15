import { afterEach, expect, test, vi } from "vitest";
import { protocolEndpoint, runPrompt } from "../../web/src/api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("operator console maps every protocol to its public endpoint", () => {
  expect(protocolEndpoint("messages")).toBe("/v1/messages");
  expect(protocolEndpoint("chat")).toBe("/v1/chat/completions");
  expect(protocolEndpoint("responses")).toBe("/v1/responses");
});

test("operator console sends a non-stream Responses request", async () => {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "resp_console", object: "response", status: "completed" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  let output = "";

  await runPrompt({
    apiKey: "console-key",
    protocol: "responses",
    model: "claude-sonnet-4-6",
    prompt: "Console Responses check",
    stream: false,
    onChunk: (value) => {
      output = value;
    },
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/v1/responses");
  expect(init.headers).toEqual({
    authorization: "Bearer console-key",
    "content-type": "application/json",
  });
  expect(JSON.parse(String(init.body))).toEqual({
    model: "claude-sonnet-4-6",
    stream: false,
    input: "Console Responses check",
  });
  expect(output).toContain('"id": "resp_console"');
});

test("operator console renders Responses SSE bytes incrementally", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: response.created\ndata: {\"type\":\"response.created\"}\n\n"));
      controller.enqueue(encoder.encode("event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n"));
      controller.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
  const snapshots: string[] = [];

  await runPrompt({
    apiKey: "console-key",
    protocol: "responses",
    model: "claude-sonnet-4-6",
    prompt: "Stream check",
    stream: true,
    onChunk: (value) => snapshots.push(value),
  });

  expect(snapshots.length).toBeGreaterThanOrEqual(2);
  expect(snapshots.at(-1)).toContain("response.created");
  expect(snapshots.at(-1)).toContain("response.completed");
});
