import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SystemClock, type Clock } from "../../src/clock.js";
import { loadConfig, type GatewayConfig } from "../../src/config.js";
import { createLogger } from "../../src/log.js";
import type { PumpBoundary } from "../../src/core/event-pump.js";
import { createApp, type App } from "../../src/server/app.js";
import { FakeSdk, type FakeSdkOptions } from "../fixtures/fake-sdk.js";

export interface TestContext {
  app: App;
  sdk: FakeSdk;
  clock: Clock;
  url: string;
  server: Server;
  logs: string[];
}

export async function startTestApp(
  options: {
    sdk?: FakeSdkOptions;
    config?: Partial<GatewayConfig>;
    clock?: Clock;
    captureLogs?: boolean;
    beforeApplyBoundary?: (boundary: PumpBoundary) => Promise<void>;
  } = {},
): Promise<TestContext> {
  const clock = options.clock ?? new SystemClock();
  const config = loadConfig({
    host: "127.0.0.1",
    port: 0,
    toolBatchSettleMs: 0,
    firstEventTimeoutMs: 250,
    stateDir: options.config?.stateDir ?? mkdtempSync(join(tmpdir(), "cursor-sdk2api-state-")),
    ...options.config,
  });
  const sdk = new FakeSdk(options.sdk);
  const logs: string[] = [];
  const logger = options.captureLogs
    ? {
        info: (fields: Record<string, unknown>, message: string) => {
          logs.push(JSON.stringify({ fields, message }));
        },
        warn: (fields: Record<string, unknown>, message: string) => {
          logs.push(JSON.stringify({ fields, message }));
        },
        error: (fields: Record<string, unknown>, message: string) => {
          logs.push(JSON.stringify({ fields, message }));
        },
      }
    : createLogger("error");
  const app = createApp({
    config,
    sdk,
    clock,
    logger,
    workspaceDir: mkdtempSync(join(tmpdir(), "cursor-sdk2api-test-")),
    beforeApplyBoundary: options.beforeApplyBoundary,
  });
  const server = createServer((req, res) => {
    void app.handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind test server");
  return {
    app,
    sdk,
    clock,
    url: `http://127.0.0.1:${address.port}`,
    server,
    logs,
  };
}

export async function closeTestApp(ctx: TestContext): Promise<void> {
  ctx.app.beginShutdown();
  await new Promise<void>((resolve, reject) => {
    ctx.server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function api(
  ctx: TestContext,
  path: string,
  init: RequestInit & { apiKey?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.apiKey !== null) {
    headers.set("authorization", `Bearer ${init.apiKey ?? "test-key-a"}`);
  }
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetch(`${ctx.url}${path}`, { ...init, headers });
}

export function weatherTool() {
  return {
    name: "lookup",
    description: "Look something up",
    input_schema: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
  };
}

export function openaiWeatherTool() {
  return {
    type: "function" as const,
    function: {
      name: "lookup",
      description: "Look something up",
      parameters: {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    },
  };
}

export function parseChatSse(text: string): Array<Record<string, unknown> | "[DONE]"> {
  const frames: Array<Record<string, unknown> | "[DONE]"> = [];
  for (const chunk of text.split("\n\n")) {
    if (!chunk.trim()) continue;
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) continue;
    if (data === "[DONE]") frames.push("[DONE]");
    else frames.push(JSON.parse(data) as Record<string, unknown>);
  }
  return frames;
}

export function parseSse(text: string): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  const chunks = text.split("\n\n");
  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    let event = "message";
    let data = "";
    for (const line of chunk.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    events.push({ event, data: data ? JSON.parse(data) : null });
  }
  return events;
}
