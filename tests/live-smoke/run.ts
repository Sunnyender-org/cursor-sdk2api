#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogCapability, resolveRequestedModels, type CatalogModel } from "./lib/catalog.js";
import { claudeCodeHeaders, gatewayGet, liveTools, postMessages, type GatewayResponse } from "./lib/client.js";
import { defaultRequestedModels, liveSmokeGate } from "./lib/gate.js";
import { opaqueMarker } from "./lib/markers.js";
import { buildReceipt, exitCodeFor, type SmokeCase } from "./lib/receipt.js";
import { redactSecrets } from "./lib/redact.js";
import { sseShapeOk } from "./lib/sse.js";
import { startChildGateway, type ChildGateway } from "./lib/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

interface RunContext {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  canaries: string[];
  child?: ChildGateway;
}

async function main(): Promise<void> {
  const gate = liveSmokeGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(gate.code);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const canaries = [apiKey];
  const startedAt = new Date();
  const requested = defaultRequestedModels(process.env);
  const timeoutMs = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS ?? "180000", 10);
  const output = process.env.LIVE_SMOKE_OUTPUT?.trim() || join(tmpdir(), `cursor-sdk2api-live-smoke-${Date.now()}.json`);
  const attach = process.env.GATEWAY_BASE_URL?.trim();

  let child: ChildGateway | undefined;
  let baseUrl = attach?.replace(/\/$/, "") ?? "";
  const cases: SmokeCase[] = [];
  let catalogStatus = "unavailable";
  let catalogIds: string[] = [];
  let catalogModels: CatalogModel[] = [];
  let gatewayVersion: string | undefined;
  let sdkVersion: string | undefined;
  let exitCode = 1;

  try {
    if (!attach) {
      const distEntry = join(repoRoot, "dist", "index.js");
      if (!existsSync(distEntry)) {
        console.error("dist/index.js is missing. Run npm run build before live:smoke.");
        process.exit(3);
      }
      child = await startChildGateway({ repoRoot, distEntry, canaries });
      baseUrl = child.baseUrl;
    } else {
      const url = new URL(attach);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        console.error("GATEWAY_BASE_URL must be http or https.");
        process.exit(3);
      }
    }

    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const healthJson = (await health.json()) as {
      version?: string;
      sdk_version?: string;
      network?: {
        proxy_configured?: boolean;
        agent_transport?: "http1-proxy" | "http2-direct";
        fetch_transport?: "undici-proxy" | "fetch-direct";
      };
    };
    gatewayVersion = typeof healthJson.version === "string" ? healthJson.version : undefined;
    sdkVersion = typeof healthJson.sdk_version === "string" ? healthJson.sdk_version : undefined;

    const ctx: RunContext = { baseUrl, apiKey, timeoutMs, canaries, child };
    const catalog = await gatewayGet(baseUrl, "/v1/models", apiKey, timeoutMs);
    const catalogBody = catalog.json as { status?: string; data?: CatalogModel[] };
    catalogStatus = catalogBody.status ?? (catalog.status === 200 ? "ok" : "error");
    catalogModels = Array.isArray(catalogBody.data) ? catalogBody.data : [];
    catalogIds = catalogModels.map((model) => model.id).filter(Boolean);
    const resolved = resolveRequestedModels(requested, catalogModels);
    const catalogOk = catalog.status === 200 && catalogStatus !== "unavailable";
    cases.push({
      id: "catalog/authenticated",
      case: "catalog_auth",
      status: catalogOk ? "pass" : "fail",
      required: true,
      http_status: catalog.status,
      error_type: catalog.error_type,
      duration_ms: catalog.duration_ms,
      counts: { models: catalogIds.length },
      reason: catalogOk ? undefined : catalogStatus,
    });

    for (const item of resolved.resolved) {
      if (!item.id) {
        cases.push({
          id: `${item.requested}/catalog`,
          model: item.requested,
          case: "catalog",
          status: "catalog_missing",
          required: true,
          reason: item.how === "ambiguous" ? "ambiguous_catalog_match" : "not_in_catalog",
        });
        continue;
      }
      const model = catalogModels.find((entry) => entry.id === item.id);
      cases.push(...(await runModelMatrix(ctx, item.id, model)));
    }

    const endedAt = new Date();
    const receipt = buildReceipt({
      startedAt,
      endedAt,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        gateway_version: gatewayVersion,
        sdk_version: sdkVersion,
        runner: "tests/live-smoke",
        mode: child ? "child" : "attach",
        catalog_status: catalogStatus,
        proxy_configured: healthJson.network?.proxy_configured,
        agent_transport: healthJson.network?.agent_transport,
        fetch_transport: healthJson.network?.fetch_transport,
      },
      catalog: {
        requested,
        model_ids: catalogIds,
        resolved: resolved.resolved.map((item) => ({
          requested: item.requested,
          id: item.id,
          how: item.how,
          ...(item.id === "grok-4.6" ? { params: [{ id: "effort", value: "xhigh" }] } : {}),
        })),
        missing: resolved.missing,
      },
      cases,
      canaries,
    });
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (const item of cases) {
      console.log(
        `case ${item.id} ${item.status}${item.duration_ms !== undefined ? ` ${item.duration_ms}ms` : ""}${
          item.error_type ? ` ${item.error_type}` : ""
        }${item.reason ? ` ${item.reason}` : ""}`,
      );
    }
    console.log(`receipt ${output}`);
    console.log(`ok=${receipt.ok} incomplete=${receipt.incomplete} required_failures=${receipt.summary.required_failures}`);
    exitCode = exitCodeFor(receipt);
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : "live smoke failed", canaries);
    console.error(message);
    exitCode = 1;
  } finally {
    if (child) {
      await child.stop().catch(() => undefined);
      child.cleanup();
    }
  }
  process.exit(exitCode);
}

async function runModelMatrix(
  ctx: RunContext,
  model: string,
  catalogModel: CatalogModel | undefined,
): Promise<SmokeCase[]> {
  const out: SmokeCase[] = [];
  out.push(await isolate(ctx, model, "text_nonstream", () => runTextNonstream(ctx, model)));
  out.push(await isolate(ctx, model, "text_sse", () => runTextSse(ctx, model)));
  out.push(await isolate(ctx, model, "single_tool", () => runSingleTool(ctx, model)));
  out.push(await isolate(ctx, model, "parallel_tools", () => runParallelTools(ctx, model)));
  out.push(await isolate(ctx, model, "multi_round", () => runMultiRound(ctx, model)));
  out.push(await isolate(ctx, model, "duplicate_same", () => runDuplicateSame(ctx, model)));
  out.push(await isolate(ctx, model, "pending_restart_lost", () => runPendingRestart(ctx, model)));
  out.push(await isolate(ctx, model, "completed_resume", () => runCompletedResume(ctx, model)));
  if (model.toLowerCase().includes("fable")) {
    out.push(await isolate(ctx, model, "claude_code_shape", () => runClaudeCodeShape(ctx, model)));
  }
  const thinking = catalogCapability(catalogModel, "thinking");
  if (thinking === "unsupported") {
    out.push({
      id: `${model}/thinking`,
      model,
      case: "thinking",
      status: "skip",
      required: false,
      reason: "catalog_unsupported",
    });
  }
  return out;
}

async function isolate(
  ctx: RunContext,
  model: string,
  name: string,
  run: () => Promise<SmokeCase>,
): Promise<SmokeCase> {
  try {
    return await run();
  } catch (error) {
    return {
      id: `${model}/${name}`,
      model,
      case: name,
      status: "fail",
      required: true,
      reason: redactSecrets(error instanceof Error ? error.message : "case_threw", ctx.canaries),
    };
  }
}

function failCase(
  model: string,
  name: string,
  res: Partial<GatewayResponse> & { reason?: string },
  required = true,
): SmokeCase {
  return {
    id: `${model}/${name}`,
    model,
    case: name,
    status: res.reason_class === "region_unsupported" ? "region_blocked" : "fail",
    required,
    http_status: res.status,
    error_type: res.error_type,
    duration_ms: res.duration_ms,
    first_event_ms: res.first_event_ms,
    counts: compactCounts(res),
    usage: res.usage,
    reason: res.reason_class ?? res.reason ?? res.error_type ?? "assertion_failed",
  };
}

function passCase(
  model: string,
  name: string,
  res: Partial<GatewayResponse>,
  extra?: Partial<SmokeCase>,
): SmokeCase {
  return {
    id: `${model}/${name}`,
    model,
    case: name,
    status: "pass",
    required: true,
    http_status: res.status,
    duration_ms: res.duration_ms,
    first_event_ms: res.first_event_ms,
    counts: compactCounts(res),
    usage: res.usage,
    ...extra,
  };
}

function compactCounts(res: Partial<GatewayResponse>): Record<string, number> | undefined {
  const counts: Record<string, number> = { ...(res.sse_counts ?? {}) };
  if (res.tool_uses) counts.tool_use = res.tool_uses.length;
  return Object.keys(counts).length > 0 ? counts : undefined;
}

async function runTextNonstream(ctx: RunContext, model: string): Promise<SmokeCase> {
  const marker = opaqueMarker("txt");
  const res = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    marker,
    body: {
      model,
      max_tokens: 128,
      messages: [{ role: "user", content: `Reply with exactly this token and nothing else: ${marker}` }],
    },
  });
  if (res.status !== 200 || res.error_type || !res.marker_hit) {
    return failCase(model, "text_nonstream", { ...res, reason: res.marker_hit ? res.error_type : "marker_missing" });
  }
  return passCase(model, "text_nonstream", res);
}

async function runTextSse(ctx: RunContext, model: string): Promise<SmokeCase> {
  const marker = opaqueMarker("sse");
  const res = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    marker,
    body: {
      model,
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: `Reply with exactly this token: ${marker}` }],
    },
  });
  if (res.status !== 200 || !res.marker_hit || !res.sse_counts || !sseShapeOk(res.sse_counts)) {
    return failCase(model, "text_sse", { ...res, reason: "sse_shape" });
  }
  return passCase(model, "text_sse", res);
}

async function runSingleTool(ctx: RunContext, model: string): Promise<SmokeCase> {
  const marker = opaqueMarker("tool");
  const opened = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [
        {
          role: "user",
          content: `Call live_alpha once. Set token to ${marker}. Do not answer in text first.`,
        },
      ],
    },
  });
  if (opened.status !== 200 || opened.tool_uses.length < 1 || opened.tool_uses[0]?.name !== "live_alpha") {
    return failCase(model, "single_tool", { ...opened, reason: "no_tool_use" });
  }
  const toolId = opened.tool_uses[0]?.id;
  const continued = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 128,
      tools: liveTools(),
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: [{ type: "tool_use", id: toolId, name: "live_alpha", input: { token: marker } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: opaqueMarker("res") }] },
      ],
    },
  });
  if (continued.status !== 200) {
    return failCase(model, "single_tool", { ...continued, reason: "continuation_failed" });
  }
  return passCase(model, "single_tool", continued, {
    counts: { tool_use: opened.tool_uses.length, ...(continued.usage ? {} : {}) },
    duration_ms: opened.duration_ms + continued.duration_ms,
    usage: continued.usage,
  });
}

async function runParallelTools(ctx: RunContext, model: string): Promise<SmokeCase> {
  const marker = opaqueMarker("par");
  const opened = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [
        {
          role: "user",
          content: `Call both independent tools live_alpha and live_beta now, in the same assistant turn, before waiting for either result. Use token ${marker} for both. Do not call them sequentially and do not answer in text first.`,
        },
      ],
    },
  });
  const names = opened.tool_uses.map((item) => item.name).sort();
  if (opened.status !== 200 || opened.tool_uses.length < 2 || names.join(",") !== "live_alpha,live_beta") {
    return failCase(model, "parallel_tools", { ...opened, reason: "expected_two_tool_batch" });
  }
  const results = opened.tool_uses.map((item) => ({
    type: "tool_result",
    tool_use_id: item.id,
    content: opaqueMarker("pr"),
  }));
  const continued = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 128,
      tools: liveTools(),
      messages: [{ role: "user", content: results }],
    },
  });
  if (continued.status !== 200) {
    return failCase(model, "parallel_tools", { ...continued, reason: "continuation_failed" });
  }
  return passCase(model, "parallel_tools", continued, {
    counts: { tool_use: opened.tool_uses.length },
    duration_ms: opened.duration_ms + continued.duration_ms,
  });
}

async function runMultiRound(ctx: RunContext, model: string): Promise<SmokeCase> {
  const opened = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [
        {
          role: "user",
          content: "First call only live_alpha with token one. After the result, call only live_beta with token two.",
        },
      ],
    },
  });
  if (opened.status !== 200 || opened.tool_uses.length === 0) {
    return failCase(model, "multi_round", { ...opened, reason: "no_first_batch" });
  }
  const first = opened.tool_uses;
  const mid = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [
        {
          role: "user",
          content: first.map((item) => ({ type: "tool_result", tool_use_id: item.id, content: opaqueMarker("m1") })),
        },
      ],
    },
  });
  if (mid.status !== 200 || mid.tool_uses.length === 0) {
    return failCase(model, "multi_round", { ...mid, reason: "no_second_batch" });
  }
  const fin = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 128,
      tools: liveTools(),
      messages: [
        {
          role: "user",
          content: mid.tool_uses.map((item) => ({
            type: "tool_result",
            tool_use_id: item.id,
            content: opaqueMarker("m2"),
          })),
        },
      ],
    },
  });
  if (fin.status !== 200) {
    return failCase(model, "multi_round", { ...fin, reason: "second_continuation_failed" });
  }
  return passCase(model, "multi_round", fin, {
    counts: { first_batch: first.length, second_batch: mid.tool_uses.length },
    duration_ms: opened.duration_ms + mid.duration_ms + fin.duration_ms,
  });
}

async function runDuplicateSame(ctx: RunContext, model: string): Promise<SmokeCase> {
  const opened = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [{ role: "user", content: "Call live_alpha once with token dup." }],
    },
  });
  const toolId = opened.tool_uses[0]?.id;
  if (opened.status !== 200 || !toolId) {
    return failCase(model, "duplicate_same", { ...opened, reason: "no_tool_use" });
  }
  const payload = {
    model,
    max_tokens: 128,
    tools: liveTools(),
    messages: [
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "same-digest-token" }] },
    ],
  };
  const first = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: payload,
  });
  if (first.status !== 200) {
    return failCase(model, "duplicate_same", { ...first, reason: "first_result_failed" });
  }
  const replay = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: payload,
  });
  if (replay.status !== 200) {
    return failCase(model, "duplicate_same", { ...replay, reason: "replay_failed" });
  }
  return passCase(model, "duplicate_same", replay, {
    duration_ms: opened.duration_ms + first.duration_ms + replay.duration_ms,
  });
}

async function runPendingRestart(ctx: RunContext, model: string): Promise<SmokeCase> {
  if (!ctx.child) {
    return {
      id: `${model}/pending_restart_lost`,
      model,
      case: "pending_restart_lost",
      status: "not_run",
      required: true,
      reason: "attach_mode_no_process_control",
    };
  }
  const opened = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 256,
      tools: liveTools(),
      messages: [{ role: "user", content: "Call live_alpha once with token restart." }],
    },
  });
  const toolId = opened.tool_uses[0]?.id;
  if (opened.status !== 200 || !toolId) {
    return failCase(model, "pending_restart_lost", { ...opened, reason: "no_tool_use" });
  }
  await ctx.child.restart();
  ctx.baseUrl = ctx.child.baseUrl;
  const resumed = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 128,
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: toolId, content: "after-restart" }] }],
    },
  });
  if (resumed.status !== 409 || resumed.error_type !== "cursor_session_lost") {
    return failCase(model, "pending_restart_lost", {
      ...resumed,
      reason: "expected_session_lost",
    });
  }
  return {
    id: `${model}/pending_restart_lost`,
    model,
    case: "pending_restart_lost",
    status: "pass",
    required: true,
    http_status: resumed.status,
    error_type: resumed.error_type,
    duration_ms: opened.duration_ms + resumed.duration_ms,
  };
}

async function runCompletedResume(ctx: RunContext, model: string): Promise<SmokeCase> {
  if (!ctx.child) {
    return {
      id: `${model}/completed_resume`,
      model,
      case: "completed_resume",
      status: "not_run",
      required: true,
      reason: "attach_mode_no_process_control",
    };
  }
  const first = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    body: {
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Say ok." }],
    },
  });
  if (first.status !== 200 || !first.session_id) {
    return failCase(model, "completed_resume", { ...first, reason: "no_session" });
  }
  await ctx.child.restart();
  ctx.baseUrl = ctx.child.baseUrl;
  const marker = opaqueMarker("rs");
  const follow = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    sessionId: first.session_id,
    marker,
    body: {
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: `Reply with ${marker}` }],
    },
  });
  if (follow.status !== 200 || follow.error_type === "cursor_session_lost") {
    return failCase(model, "completed_resume", { ...follow, reason: follow.error_type ?? "resume_failed" });
  }
  return passCase(model, "completed_resume", follow, {
    duration_ms: first.duration_ms + follow.duration_ms,
  });
}

async function runClaudeCodeShape(ctx: RunContext, model: string): Promise<SmokeCase> {
  const marker = opaqueMarker("cc");
  const res = await postMessages({
    baseUrl: ctx.baseUrl,
    apiKey: ctx.apiKey,
    timeoutMs: ctx.timeoutMs,
    marker,
    extraHeaders: claudeCodeHeaders(),
    body: {
      model,
      max_tokens: 128,
      system: [{ type: "text", text: "Repeat the user token exactly." }],
      messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
    },
  });
  if (res.status !== 200 || !res.marker_hit) {
    return failCase(model, "claude_code_shape", { ...res, reason: "rejected_or_failed" });
  }
  return passCase(model, "claude_code_shape", res);
}

void main();
