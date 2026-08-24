import type { AccountPayload } from "./types.js";

function finiteNumber(value: unknown): number | undefined {
  // Number(null), Number("") and Number(false) are a finite 0 the gateway never reported.
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
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
  const used = account.capabilities.spending ? finiteNumber(account.spending?.used_usd) : undefined;
  const knownLimit = account.capabilities.limits ? limit : undefined;
  if ([used, knownLimit].every((value) => value === undefined || value === 0)) return "";
  const parts: string[] = [];
  if (used !== undefined) parts.push(`${usd(used)} used`);
  if (knownLimit !== undefined) parts.push(`${usd(knownLimit)} limit`);
  return parts.join(" / ");
}

function onDemandSpend(
  label: string,
  usedValue: unknown,
  remainingValue: unknown,
  limitValue: unknown,
): string {
  const used = finiteNumber(usedValue);
  const remaining = finiteNumber(remainingValue);
  const limit = finiteNumber(limitValue);
  // A scope whose reported dollars are all zero is an unconfigured spend limit, not an exhausted budget.
  if ([used, remaining, limit].every((value) => value === undefined || value === 0)) return "";
  const values: string[] = [];
  if (used !== undefined) values.push(`${usd(used)} used`);
  if (remaining !== undefined) values.push(`${usd(remaining)} remaining`);
  if (limit !== undefined) values.push(`${usd(limit)} limit`);
  return `${label} ${values.join(", ")}`;
}

export function formatQuotaBreakdown(account?: AccountPayload): string {
  if (!account?.capabilities.limits || !account.limits) return "";
  const cursor = finiteNumber(account.limits.cursor_models_percent_used);
  const other = finiteNumber(account.limits.other_models_percent_used);
  const auto = finiteNumber(account.limits.auto_models_percent_used);
  const individual = onDemandSpend(
    "On-demand (individual)",
    account.limits.on_demand_individual_used,
    account.limits.on_demand_individual_remaining,
    account.limits.on_demand_individual_limit,
  );
  const pooled = onDemandSpend(
    "On-demand (pooled)",
    account.limits.on_demand_pooled_used,
    account.limits.on_demand_pooled_remaining,
    account.limits.on_demand_pooled_limit,
  );
  const parts: string[] = [];
  if (cursor !== undefined) parts.push(`Cursor Models ${cursor.toFixed(1)}%`);
  if (other !== undefined) parts.push(`Other Models ${other.toFixed(1)}%`);
  if (auto !== undefined) parts.push(`Auto ${auto.toFixed(1)}%`);
  parts.push(individual, pooled);
  return parts.filter(Boolean).join(" · ");
}
