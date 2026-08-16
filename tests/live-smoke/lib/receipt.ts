import { assertNoCanary, redactValue } from "./redact.js";

export type CaseStatus = "pass" | "fail" | "region_blocked" | "skip" | "not_run" | "catalog_missing";

export interface SmokeCase {
  id: string;
  model?: string;
  case: string;
  status: CaseStatus;
  required: boolean;
  http_status?: number;
  error_type?: string;
  duration_ms?: number;
  first_event_ms?: number;
  counts?: Record<string, number>;
  usage?: Record<string, number>;
  reason?: string;
}

export interface SmokeReceipt {
  schema: "cursor-sdk2api.live-smoke.v1";
  ok: boolean;
  incomplete: boolean;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  environment: {
    node: string;
    platform: string;
    arch: string;
    gateway_version?: string;
    sdk_version?: string;
    runner: string;
    mode: "child" | "attach";
    catalog_status?: string;
    proxy_configured?: boolean;
    agent_transport?: "http1-proxy" | "http2-direct";
    fetch_transport?: "undici-proxy" | "fetch-direct";
  };
  catalog: {
    requested: string[];
    model_ids: string[];
    resolved: Array<{
      requested: string;
      id?: string;
      how: string;
      params?: Array<{ id: string; value: string }>;
    }>;
    missing: string[];
  };
  cases: SmokeCase[];
  summary: {
    passed: number;
    failed: number;
    region_blocked: number;
    skipped: number;
    not_run: number;
    catalog_missing: number;
    required_failures: number;
  };
}

export function isRequiredFailure(item: SmokeCase): boolean {
  if (!item.required) return false;
  if (item.status === "fail" || item.status === "region_blocked" || item.status === "catalog_missing") return true;
  if (item.status === "not_run") return true;
  return false;
}

export function summarizeCases(cases: SmokeCase[]): SmokeReceipt["summary"] {
  return {
    passed: cases.filter((item) => item.status === "pass").length,
    failed: cases.filter((item) => item.status === "fail").length,
    region_blocked: cases.filter((item) => item.status === "region_blocked").length,
    skipped: cases.filter((item) => item.status === "skip").length,
    not_run: cases.filter((item) => item.status === "not_run").length,
    catalog_missing: cases.filter((item) => item.status === "catalog_missing").length,
    required_failures: cases.filter(isRequiredFailure).length,
  };
}

export function receiptOk(cases: SmokeCase[]): { ok: boolean; incomplete: boolean } {
  const incomplete = cases.some((item) => item.required && item.status === "not_run");
  const failed = cases.some(isRequiredFailure);
  return { ok: !failed && !incomplete, incomplete };
}

export function buildReceipt(input: {
  startedAt: Date;
  endedAt: Date;
  environment: SmokeReceipt["environment"];
  catalog: SmokeReceipt["catalog"];
  cases: SmokeCase[];
  canaries?: string[];
}): SmokeReceipt {
  const summary = summarizeCases(input.cases);
  const { ok, incomplete } = receiptOk(input.cases);
  const receipt: SmokeReceipt = {
    schema: "cursor-sdk2api.live-smoke.v1",
    ok,
    incomplete,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    duration_ms: Math.max(0, input.endedAt.getTime() - input.startedAt.getTime()),
    environment: redactValue(input.environment, input.canaries ?? []) as SmokeReceipt["environment"],
    catalog: redactValue(input.catalog, input.canaries ?? []) as SmokeReceipt["catalog"],
    cases: redactValue(input.cases, input.canaries ?? []) as SmokeCase[],
    summary,
  };
  assertNoCanary(JSON.stringify(receipt), input.canaries ?? []);
  return receipt;
}

export function exitCodeFor(receipt: SmokeReceipt): number {
  if (receipt.ok) return 0;
  if (receipt.incomplete && receipt.summary.failed === 0 && receipt.summary.catalog_missing === 0) return 2;
  return 1;
}
