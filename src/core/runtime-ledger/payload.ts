import { RuntimeLedgerError } from "./errors.js";
import type { LedgerUsage } from "./types.js";

const USAGE_KEYS = new Set([
  "inputTokens",
  "outputTokens",
  "cacheWriteTokens",
  "cacheReadTokens",
  "reasoningTokens",
]);

const FORBIDDEN_FIELD_NAMES = new Set([
  "prompt",
  "thinking",
  "messages",
  "content",
  "transcript",
  "conversation",
  "tools",
  "toolschema",
  "tool_schema",
  "args",
  "arguments",
  "result",
  "results",
  "apikey",
  "api_key",
  "authorization",
  "token",
  "cookie",
  "password",
  "secret",
  "system",
  "body",
  "credential",
  "dashboard",
  "dashboardtoken",
  "access_token",
  "accesstoken",
]);

const SECRET_LIKE = /(sk-[A-Za-z0-9_-]{8,})|(Bearer\s+\S+)|(BEGIN (RSA )?PRIVATE KEY)/i;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function assertNoForbiddenFields(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase().replaceAll("-", ""))) {
      throw new RuntimeLedgerError(
        "forbidden_content",
        `${label} cannot persist ${key}`,
      );
    }
  }
}

export function assertSafeStoredText(text: string, label: string): void {
  if (SECRET_LIKE.test(text)) {
    throw new RuntimeLedgerError(
      "forbidden_content",
      `${label} cannot persist secret-like material`,
    );
  }
  if (/"prompt"\s*:/i.test(text) || /"thinking"\s*:/i.test(text) || /"apiKey"\s*:/i.test(text)) {
    throw new RuntimeLedgerError(
      "forbidden_content",
      `${label} cannot persist prompt or credential fields`,
    );
  }
}

export function assertSha256Digest(value: string | undefined, label: string): void {
  if (value == null) return;
  if (!SHA256_HEX.test(value)) {
    throw new RuntimeLedgerError("invalid", `${label} must be a sha256 hex digest`);
  }
}

export function serializeLedgerUsage(usage: LedgerUsage): string {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    throw new RuntimeLedgerError("invalid", "usage must be numeric token counts");
  }
  assertNoForbiddenFields(usage, "usage");
  for (const key of Object.keys(usage)) {
    if (!USAGE_KEYS.has(key)) {
      throw new RuntimeLedgerError("invalid", `usage rejects unknown field ${key}`);
    }
  }
  const out: Record<string, number> = {
    inputTokens: requireTokenCount(usage.inputTokens, "inputTokens"),
    outputTokens: requireTokenCount(usage.outputTokens, "outputTokens"),
  };
  if (usage.cacheWriteTokens !== undefined) {
    out.cacheWriteTokens = requireTokenCount(usage.cacheWriteTokens, "cacheWriteTokens");
  }
  if (usage.cacheReadTokens !== undefined) {
    out.cacheReadTokens = requireTokenCount(usage.cacheReadTokens, "cacheReadTokens");
  }
  if (usage.reasoningTokens !== undefined) {
    out.reasoningTokens = requireTokenCount(usage.reasoningTokens, "reasoningTokens");
  }
  const json = JSON.stringify(out);
  assertSafeStoredText(json, "usage_json");
  return json;
}

export function parseLedgerUsage(json: string | undefined): LedgerUsage | undefined {
  if (json == null || json === "") return undefined;
  assertSafeStoredText(json, "usage_json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new RuntimeLedgerError("invalid", "usage_json is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RuntimeLedgerError("invalid", "usage_json must be an object");
  }
  return JSON.parse(serializeLedgerUsage(parsed as LedgerUsage)) as LedgerUsage;
}

function requireTokenCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RuntimeLedgerError("invalid", `${label} must be a non-negative integer`);
  }
  return value;
}
