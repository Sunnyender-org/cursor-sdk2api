import type { SdkRuntime } from "../sdk/port.js";

export async function readAccount(sdk: SdkRuntime, apiKey: string): Promise<Record<string, unknown>> {
  const result = await sdk.getAccount(apiKey);
  if (!result.ok) {
    return {
      status: "unavailable",
      identity: null,
      capabilities: {
        identity: false,
        spending: false,
        limits: false,
      },
      reasons: {
        identity: result.reason,
        spending: "cursor_dashboard_unavailable",
        limits: "cursor_dashboard_unavailable",
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
    capabilities: {
      identity: true,
      spending: Boolean(spending),
      limits: Boolean(limits),
    },
    reasons: {
      ...(spending ? {} : { spending: result.spendingReason ?? "cursor_dashboard_unavailable" }),
      ...(limits ? {} : { limits: result.limitsReason ?? "cursor_dashboard_unavailable" }),
    },
  };
}
