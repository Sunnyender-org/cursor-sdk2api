#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gatewayGet, postMessages, type GatewayResponse } from "./lib/client.js";
import { liveSmokeGate } from "./lib/gate.js";
import { redactSecrets } from "./lib/redact.js";
import { startChildGateway, type ChildGateway } from "./lib/spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

interface TraceEvent {
  action?: string;
  reason?: string;
  send_chars?: number;
  model?: string;
}

interface JournalRecord {
  agentId?: string;
  turnIndex?: number;
  state?: string;
  effectiveModel?: string;
}

interface CaseRecord {
  id: string;
  status: "pass" | "fail" | "skip" | "catalog_missing";
  required?: boolean;
  http_status?: number;
  error_type?: string;
  duration_ms?: number;
  first_event_ms?: number;
  usage?: Record<string, number>;
  counts?: Record<string, number>;
  reason?: string;
}

function assistantContent(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return "";
  return (raw as { content?: unknown }).content ?? "";
}

function readTrace(stateDir: string): TraceEvent[] {
  const path = join(stateDir, "ordinary-trace.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

function readJournal(stateDir: string): JournalRecord[] {
  const path = join(stateDir, "ordinary-turns.json");
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { records?: JournalRecord[] };
  return Array.isArray(parsed.records) ? parsed.records : [];
}

function modelExtras(model: string): Record<string, unknown> {
  return model === "grok-4.6" ? { reasoning_effort: "medium" } : {};
}

function tracesFor(stateDir: string, model: string): TraceEvent[] {
  return readTrace(stateDir).filter((item) => item.model === model);
}

function lastAction(stateDir: string, model: string, action: "resume" | "rebuild"): TraceEvent | undefined {
  return tracesFor(stateDir, model).filter((item) => item.action === action).at(-1);
}

function currentTurnOk(sendChars: number, userText: string): boolean {
  return sendChars > 0 && sendChars <= userText.length + 8;
}

async function main(): Promise<void> {
  const gate = liveSmokeGate(process.env);
  if (!gate.ok) {
    console.error(gate.message);
    process.exit(gate.code);
  }
  const apiKey = process.env.CURSOR_API_KEY?.trim() ?? "";
  const canaries = [apiKey];
  const timeoutMs = Number.parseInt(process.env.LIVE_SMOKE_TIMEOUT_MS ?? "180000", 10);
  const models = (process.env.LIVE_SMOKE_MODELS?.trim() || "grok-4.6,composer-2.5,claude-sonnet-4-6")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const output =
    process.env.LIVE_SMOKE_OUTPUT?.trim() ||
    join(tmpdir(), `cursor-sdk2api-ordinary-live-${Date.now()}.json`);
  const distEntry = join(repoRoot, "dist", "index.js");
  if (!existsSync(distEntry)) {
    console.error("dist/index.js is missing. Run npm run build before live:ordinary.");
    process.exit(3);
  }

  const child = await startChildGateway({ repoRoot, distEntry, canaries });
  const cases: CaseRecord[] = [];
  let exitCode = 1;
  try {
    const health = await fetch(`${child.baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const healthJson = (await health.json()) as {
      sdk_version?: string;
      capabilities?: { ordinary_turn_coordinator?: boolean };
    };
    if (healthJson.capabilities?.ordinary_turn_coordinator !== true) {
      throw new Error("ordinary_turn_coordinator is not enabled on /health");
    }
    const catalog = await gatewayGet(child.baseUrl, "/v1/models", apiKey, timeoutMs);
    const catalogIds = Array.isArray((catalog.json as { data?: Array<{ id?: string }> }).data)
      ? ((catalog.json as { data: Array<{ id?: string }> }).data.map((item) => item.id).filter(Boolean) as string[])
      : [];
    cases.push({
      id: "catalog",
      status: catalog.status === 200 && catalogIds.length > 0 ? "pass" : "fail",
      http_status: catalog.status,
      counts: { models: catalogIds.length },
    });

    for (const model of models) {
      if (!catalogIds.includes(model)) {
        cases.push({ id: `${model}/ordinary_successor`, status: "catalog_missing", required: false });
        continue;
      }
      cases.push(...(await runConversation(child, apiKey, timeoutMs, model)));
    }
    if (catalogIds.includes("grok-4.6")) {
      cases.push(await runPadded(child, apiKey, timeoutMs));
    }

    const receipt = {
      schema: "cursor-sdk2api.ordinary-live.v2",
      ok: cases.every((item) => item.status === "pass" || item.status === "skip" || item.status === "catalog_missing"),
      sdk_version: healthJson.sdk_version,
      ordinary_turn_coordinator: true,
      cases,
    };
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    for (const item of cases) {
      console.log(
        `case ${item.id} ${item.status}${item.duration_ms ? ` ${item.duration_ms}ms` : ""}${
          item.reason ? ` ${item.reason}` : ""
        }`,
      );
    }
    console.log(`receipt ${output}`);
    console.log(`ok=${receipt.ok}`);
    exitCode = receipt.ok && cases.some((item) => item.status === "pass" && item.id !== "catalog") ? 0 : 1;
  } catch (error) {
    console.error(redactSecrets(error instanceof Error ? error.message : "ordinary live failed", canaries));
    exitCode = 1;
  } finally {
    await child.stop().catch(() => undefined);
    child.cleanup();
  }
  process.exit(exitCode);
}

async function postTurn(
  child: ChildGateway,
  apiKey: string,
  timeoutMs: number,
  model: string,
  messages: unknown[],
): Promise<GatewayResponse> {
  return postMessages({
    baseUrl: child.baseUrl,
    apiKey,
    timeoutMs,
    body: {
      model,
      max_tokens: 64,
      ...modelExtras(model),
      messages,
    },
  });
}

function fail(id: string, res: GatewayResponse, reason: string, started: number): CaseRecord {
  return {
    id,
    status: "fail",
    http_status: res.status,
    error_type: res.error_type,
    duration_ms: Date.now() - started,
    reason: res.reason_class ?? res.error_type ?? reason,
  };
}

async function runConversation(
  child: ChildGateway,
  apiKey: string,
  timeoutMs: number,
  model: string,
): Promise<CaseRecord[]> {
  const users = [
    "Reply with the single word PONG and nothing else.",
    "Reply with the single word PING and nothing else.",
    "Reply with the single word OKAY and nothing else.",
    "Reply with the single word DONE and nothing else.",
  ];
  const started = Date.now();
  const first = await postTurn(child, apiKey, timeoutMs, model, [{ role: "user", content: users[0] }]);
  if (first.status !== 200 || first.error_type) {
    return [fail(`${model}/ordinary_successor`, first, "first_turn_failed", started)];
  }

  const second = await postTurn(child, apiKey, timeoutMs, model, [
    { role: "user", content: users[0] },
    { role: "assistant", content: assistantContent(first.raw) },
    { role: "user", content: users[1] },
  ]);
  const secondResume = lastAction(child.stateDir, model, "resume");
  const firstRebuild = tracesFor(child.stateDir, model).find((item) => item.action === "rebuild");
  const successorOk =
    second.status === 200 &&
    !second.error_type &&
    secondResume?.reason === "exact_successor_live" &&
    currentTurnOk(secondResume.send_chars ?? 0, users[1] ?? "") &&
    (firstRebuild?.send_chars ?? 0) > (secondResume.send_chars ?? 0);
  const cases: CaseRecord[] = [
    {
      id: `${model}/ordinary_successor`,
      status: successorOk ? "pass" : "fail",
      http_status: second.status,
      error_type: second.error_type,
      duration_ms: Date.now() - started,
      usage: second.usage,
      counts: {
        first_send_chars: firstRebuild?.send_chars ?? 0,
        second_send_chars: secondResume?.send_chars ?? 0,
        cache_read: second.usage?.cache_read_input_tokens ?? 0,
      },
      reason: successorOk ? undefined : "successor_not_incremental",
    },
  ];
  if (!successorOk) return cases;

  const thirdStarted = Date.now();
  const third = await postTurn(child, apiKey, timeoutMs, model, [
    { role: "user", content: users[0] },
    { role: "assistant", content: assistantContent(first.raw) },
    { role: "user", content: users[1] },
    { role: "assistant", content: assistantContent(second.raw) },
    { role: "user", content: users[2] },
  ]);
  const thirdResume = lastAction(child.stateDir, model, "resume");
  const thirdOk =
    third.status === 200 &&
    !third.error_type &&
    thirdResume?.reason === "exact_successor_live" &&
    currentTurnOk(thirdResume.send_chars ?? 0, users[2] ?? "");
  cases.push({
    id: `${model}/ordinary_third`,
    status: thirdOk ? "pass" : "fail",
    http_status: third.status,
    error_type: third.error_type,
    duration_ms: Date.now() - thirdStarted,
    usage: third.usage,
    counts: {
      third_send_chars: thirdResume?.send_chars ?? 0,
      cache_read: third.usage?.cache_read_input_tokens ?? 0,
    },
    reason: thirdOk ? undefined : "third_turn_not_incremental",
  });
  if (!thirdOk) return cases;

  const restartStarted = Date.now();
  await child.restart();
  const fourth = await postTurn(child, apiKey, timeoutMs, model, [
    { role: "user", content: users[0] },
    { role: "assistant", content: assistantContent(first.raw) },
    { role: "user", content: users[1] },
    { role: "assistant", content: assistantContent(second.raw) },
    { role: "user", content: users[2] },
    { role: "assistant", content: assistantContent(third.raw) },
    { role: "user", content: users[3] },
  ]);
  const fourthResume = lastAction(child.stateDir, model, "resume");
  const journal = readJournal(child.stateDir).filter(
    (item) =>
      item.state === "completed" &&
      Number(item.turnIndex) > 0 &&
      String(item.effectiveModel || "").startsWith(`${model}|`),
  );
  const agentIds = [...new Set(journal.map((item) => item.agentId).filter(Boolean))];
  const restartOk =
    fourth.status === 200 &&
    !fourth.error_type &&
    fourthResume?.reason === "exact_successor_store" &&
    currentTurnOk(fourthResume.send_chars ?? 0, users[3] ?? "") &&
    agentIds.length === 1;
  cases.push({
    id: `${model}/ordinary_restart`,
    status: restartOk ? "pass" : "fail",
    http_status: fourth.status,
    error_type: fourth.error_type,
    duration_ms: Date.now() - restartStarted,
    usage: fourth.usage,
    counts: {
      fourth_send_chars: fourthResume?.send_chars ?? 0,
      unique_agents: agentIds.length,
      resume_reason_store: fourthResume?.reason === "exact_successor_store" ? 1 : 0,
      cache_read: fourth.usage?.cache_read_input_tokens ?? 0,
    },
    reason: restartOk ? undefined : "restart_did_not_resume_current_turn",
  });
  return cases;
}

async function runPadded(child: ChildGateway, apiKey: string, timeoutMs: number): Promise<CaseRecord> {
  const model = "grok-4.6";
  const pad = "x".repeat(4096);
  const firstUser = `Ignore the padding and reply with the single word PONG.\nPAD ${pad}`;
  const secondUser = "Reply with the single word PING and nothing else.";
  const started = Date.now();
  const first = await postTurn(child, apiKey, timeoutMs, model, [{ role: "user", content: firstUser }]);
  if (first.status !== 200 || first.error_type) {
    return fail(`${model}/ordinary_padded`, first, "padded_first_failed", started);
  }
  const second = await postTurn(child, apiKey, timeoutMs, model, [
    { role: "user", content: firstUser },
    { role: "assistant", content: assistantContent(first.raw) },
    { role: "user", content: secondUser },
  ]);
  const resume = lastAction(child.stateDir, model, "resume");
  const rebuilds = tracesFor(child.stateDir, model).filter((item) => item.action === "rebuild");
  const paddedRebuild = rebuilds.find((item) => (item.send_chars ?? 0) >= 4096);
  const ok =
    second.status === 200 &&
    !second.error_type &&
    (resume?.reason ?? "").startsWith("exact_successor") &&
    currentTurnOk(resume?.send_chars ?? 0, secondUser) &&
    (paddedRebuild?.send_chars ?? 0) >= 4096 &&
    (resume?.send_chars ?? 0) < 80;
  return {
    id: `${model}/ordinary_padded`,
    status: ok ? "pass" : "fail",
    http_status: second.status,
    error_type: second.error_type,
    duration_ms: Date.now() - started,
    usage: second.usage,
    counts: {
      padded_first_send_chars: paddedRebuild?.send_chars ?? 0,
      padded_second_send_chars: resume?.send_chars ?? 0,
      cache_read: second.usage?.cache_read_input_tokens ?? 0,
    },
    reason: ok ? undefined : "padded_history_was_reflattened",
  };
}

await main();
