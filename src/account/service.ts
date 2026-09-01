import type { CursorSandResult } from "./cursor-dashboard.js";
import { DEFAULT_RUNTIME_PROFILE, type RuntimeProfile } from "../core/runtime-profile.js";
import type { SdkRuntime } from "../sdk/port.js";

export const UNAVAILABLE_GROK_BOT: CursorSandResult = {
  available: false,
  source: "cursor_sand_rpc",
  reason: "sand_access_unreachable",
};

export interface ReadAccountOptions {
  fetchSandQuota?: (apiKey: string) => Promise<CursorSandResult>;
  defaultProfile?: RuntimeProfile;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function mapGrokBot(result: CursorSandResult): Record<string, unknown> {
  if (result.available) {
    return compactRecord({
      available: true,
      source: result.source,
      used_percent: result.usedPercent,
      remaining_percent: result.remainingPercent,
      plan_label: result.planLabel,
      next_reset_timestamp_utc: result.nextResetTimestampUtc,
      current_period_start: result.currentPeriodStart,
      access_state: result.accessState,
      has_available_usage: result.hasAvailableUsage,
    });
  }
  return compactRecord({
    available: false,
    source: result.source,
    reason: result.reason,
    access_state: result.accessState,
    ...(result.status === undefined ? {} : { status: result.status }),
  });
}

async function loadGrokBot(
  apiKey: string,
  fetchSandQuota: ReadAccountOptions["fetchSandQuota"],
): Promise<CursorSandResult> {
  if (!fetchSandQuota) return UNAVAILABLE_GROK_BOT;
  try {
    return await fetchSandQuota(apiKey);
  } catch {
    return UNAVAILABLE_GROK_BOT;
  }
}

export async function readAccount(
  sdk: SdkRuntime,
  apiKey: string,
  options: ReadAccountOptions = {},
): Promise<Record<string, unknown>> {
  const defaultProfile = options.defaultProfile ?? DEFAULT_RUNTIME_PROFILE;
  const [result, sand] = await Promise.all([
    sdk.getAccount(apiKey),
    loadGrokBot(apiKey, options.fetchSandQuota),
  ]);
  const grokBot = mapGrokBot(sand);
  const runtime = {
    default_profile: defaultProfile,
    sand_selectable: sand.available,
    applies_to_new_sessions: true,
  };

  if (!result.ok) {
    return {
      status: "unavailable",
      identity: null,
      grok_bot: grokBot,
      runtime,
      capabilities: {
        identity: false,
        spending: false,
        limits: false,
        grok_bot: sand.available,
      },
      reasons: {
        identity: result.reason,
        spending: "cursor_dashboard_unavailable",
        limits: "cursor_dashboard_unavailable",
        ...(sand.available ? {} : { grok_bot: sand.reason }),
      },
    };
  }

  const spending = result.spending && Object.keys(result.spending).length > 0 ? result.spending : undefined;
  const limits = result.limits && Object.keys(result.limits).length > 0 ? result.limits : undefined;
  const partial = !spending || !limits;
  return {
    status: partial ? "partial" : "ok",
    identity: {
      api_key_name: result.identity.apiKeyName,
      user_id: result.identity.userId,
      created_at: result.identity.createdAt,
      first_name: result.identity.firstName,
      last_name: result.identity.lastName,
    },
    ...(spending ? { spending } : {}),
    ...(limits ? { limits } : {}),
    grok_bot: grokBot,
    runtime,
    capabilities: {
      identity: true,
      spending: Boolean(spending),
      limits: Boolean(limits),
      grok_bot: sand.available,
    },
    reasons: {
      ...(spending ? {} : { spending: result.spendingReason ?? "cursor_dashboard_unavailable" }),
      ...(limits ? {} : { limits: result.limitsReason ?? "cursor_dashboard_unavailable" }),
      ...(sand.available ? {} : { grok_bot: sand.reason }),
    },
  };
}
