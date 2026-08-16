import type { AccountPayload } from "./types.js";

function compactValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(compactValue).filter(Boolean).join(", ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, inner]) => `${key} ${compactValue(inner)}`)
      .join(" · ");
  }
  return "";
}

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function usd(value: number): string {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatQuota(account?: AccountPayload): string {
  if (!account) return "";
  const remaining = finiteNumber(account.limits?.remaining_usd);
  const limit = finiteNumber(account.limits?.limit_usd);
  if (remaining === 0 && limit === 0) return "";
  if (remaining !== undefined && limit !== undefined) return `${usd(remaining)} / ${usd(limit)}`;
  if (remaining !== undefined) return usd(remaining);
  const parts: string[] = [];
  if (account.capabilities.spending && account.spending) parts.push(compactValue(account.spending));
  if (account.capabilities.limits && account.limits) parts.push(compactValue(account.limits));
  return parts.filter(Boolean).join(" · ");
}

export function formatQuotaBreakdown(account?: AccountPayload): string {
  if (!account?.capabilities.limits || !account.limits) return "";
  const cursor = finiteNumber(account.limits.cursor_models_percent_used);
  const other = finiteNumber(account.limits.other_models_percent_used);
  const parts: string[] = [];
  if (cursor !== undefined) parts.push(`Cursor Models ${cursor.toFixed(1)}%`);
  if (other !== undefined) parts.push(`Other Models ${other.toFixed(1)}%`);
  return parts.join(" · ");
}
