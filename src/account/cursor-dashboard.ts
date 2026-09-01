import { brotliDecompressSync } from "node:zlib";
import { credentialFingerprint } from "../digest.js";

const DEFAULT_BASE_URL = "https://api2.cursor.sh";
const RESPONSE_LIMIT = 1 << 20;
const EXCHANGE_TIMEOUT_MS = 10_000;
const SAND_GRANT_CACHE_TTL_MS = 10 * 60 * 1000;
const SAND_ACCESS_GRANTED = "SAND_ACCESS_STATE_GRANTED";
const SAND_CLIENT_TYPE = "sand";

export interface CursorDashboardQuota {
  available: true;
  source: "cursor_dashboard_rpc";
  planName?: string;
  planPrice?: string;
  planOwner?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  usedUsd?: number;
  totalSpendUsd?: number;
  remainingUsd?: number;
  limitUsd?: number;
  usedPercent?: number;
  cursorModelsPercentUsed?: number;
  otherModelsPercentUsed?: number;
  autoModelsPercentUsed?: number;
  bonusSpendUsd?: number;
  onDemandSpendUsd?: number;
  onDemandLimitType?: string;
  onDemandIndividualLimit?: number;
  onDemandIndividualUsed?: number;
  onDemandIndividualRemaining?: number;
  onDemandPooledLimit?: number;
  onDemandPooledUsed?: number;
  onDemandPooledRemaining?: number;
}

export interface CursorDashboardUnavailable {
  available: false;
  source: "cursor_dashboard_rpc";
  reason:
    | "api_key_missing"
    | "api_key_invalid"
    | "exchange_unavailable"
    | "dashboard_unreachable"
    | "dashboard_rejected"
    | "dashboard_invalid_response";
  status?: number;
}

export type CursorDashboardResult = CursorDashboardQuota | CursorDashboardUnavailable;

export interface CursorSandQuota {
  available: true;
  source: "cursor_sand_rpc";
  accessState: string;
  usedPercent: number;
  remainingPercent: number;
  planLabel?: string;
  currentPeriodStart?: string;
  nextResetTimestampUtc?: string;
  hasAvailableUsage?: boolean;
  hasNonZeroIncludedLimit?: boolean;
  includedLimitZero?: boolean;
  usesPooledEnterpriseAllowance?: boolean;
  blockReason?: string;
  purchaseChannel?: string;
  purchasableTiers?: string[];
  isPaidTrialPlan?: boolean;
}

export type CursorSandUnavailableReason =
  | "api_key_missing"
  | "api_key_invalid"
  | "exchange_unavailable"
  | "sand_access_not_granted"
  | "sand_access_unreachable"
  | "sand_access_rejected"
  | "sand_usage_unreachable"
  | "sand_usage_rejected"
  | "sand_usage_percent_missing";

export interface CursorSandUnavailable {
  available: false;
  source: "cursor_sand_rpc";
  reason: CursorSandUnavailableReason;
  status?: number;
  accessState?: string;
  blockReason?: string;
  purchaseChannel?: string;
  purchasableTiers?: string[];
  isPaidTrialPlan?: boolean;
}

export type CursorSandResult = CursorSandQuota | CursorSandUnavailable;

interface DashboardOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  bypassCache?: boolean;
}

interface SandGrantCacheEntry {
  expiresAt: number;
  result: CursorSandQuota;
}

interface ExchangeErrorOptions {
  status?: number;
  cause?: unknown;
}

class ExchangeError extends Error {
  readonly status?: number;

  constructor(options: ExchangeErrorOptions = {}) {
    super(options.status ? `Cursor API key exchange returned ${options.status}` : "Cursor API key exchange failed", {
      cause: options.cause,
    });
    this.name = "ExchangeError";
    this.status = options.status;
  }
}

class DashboardResponseError extends Error {
  constructor(cause: unknown) {
    super("Cursor dashboard returned an invalid response", { cause });
    this.name = "DashboardResponseError";
  }
}

const activeExchanges = new Map<string, Promise<string>>();
const sandGrantCache = new Map<string, SandGrantCacheEntry>();

function optionalNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function ownNumber(record: Record<string, unknown>, key: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return optionalNumber(record[key]);
}

function optionalString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function ownBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function ownStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

async function readLimitedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_LIMIT) {
      await reader.cancel();
      throw new Error("Cursor dashboard response exceeded 1 MiB");
    }
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks, size);
  let body = raw.toString("utf8").trim();
  if (!body) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch (jsonError) {
    // Cursor's dashboard currently serves Brotli bytes through some proxy paths
    // without a Content-Encoding header. Decode only after plain JSON fails and
    // cap decompressed output to the same response budget.
    try {
      body = brotliDecompressSync(raw, { maxOutputLength: RESPONSE_LIMIT }).toString("utf8");
      parsed = JSON.parse(body) as unknown;
    } catch {
      throw jsonError;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cursor dashboard response was not an object");
  }
  return parsed as Record<string, unknown>;
}

async function exchangeApiKey(
  apiKey: string,
  baseUrl: string,
  request: typeof globalThis.fetch,
): Promise<string> {
  const fingerprint = `${baseUrl}:${credentialFingerprint(apiKey)}`;
  const existing = activeExchanges.get(fingerprint);
  if (existing) return existing;

  const exchange = (async () => {
    let response: Response;
    try {
      response = await request(`${baseUrl}/auth/exchange_user_api_key`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExchangeError({ cause: error });
    }
    if (!response.ok) {
      throw new ExchangeError({ status: response.status });
    }
    let payload: Record<string, unknown>;
    try {
      payload = await readLimitedJson(response);
    } catch (error) {
      throw new ExchangeError({ status: response.status, cause: error });
    }
    const accessToken = optionalString(payload.accessToken);
    if (!accessToken) throw new ExchangeError({ status: response.status });
    return accessToken;
  })();

  activeExchanges.set(fingerprint, exchange);
  try {
    return await exchange;
  } finally {
    if (activeExchanges.get(fingerprint) === exchange) activeExchanges.delete(fingerprint);
  }
}

async function dashboardPost(
  method: string,
  accessToken: string,
  baseUrl: string,
  request: typeof globalThis.fetch,
  clientType?: string,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const sandClientType = clientType?.trim();
  const response = await request(`${baseUrl}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
      ...(sandClientType ? { "x-cursor-client-type": sandClientType } : {}),
    },
    body: "{}",
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { response, payload: {} };
  }
  try {
    return { response, payload: await readLimitedJson(response) };
  } catch (error) {
    throw new DashboardResponseError(error);
  }
}

function exchangeFailure(error: unknown): CursorDashboardUnavailable {
  if (error instanceof ExchangeError) {
    if (error.status === 401 || error.status === 403) {
      return { available: false, source: "cursor_dashboard_rpc", reason: "api_key_invalid", status: error.status };
    }
    return {
      available: false,
      source: "cursor_dashboard_rpc",
      reason: "exchange_unavailable",
      ...(error.status ? { status: error.status } : {}),
    };
  }
  return { available: false, source: "cursor_dashboard_rpc", reason: "exchange_unavailable" };
}

function sandCacheKey(baseUrl: string, apiKey: string): string {
  return `${baseUrl}:${credentialFingerprint(apiKey)}`;
}

function cloneSandQuota(result: CursorSandQuota): CursorSandQuota {
  return {
    ...result,
    ...(result.purchasableTiers ? { purchasableTiers: [...result.purchasableTiers] } : {}),
  };
}

function readCachedSandQuota(cacheKey: string, bypassCache: boolean | undefined): CursorSandQuota | undefined {
  if (bypassCache) return undefined;
  const cached = sandGrantCache.get(cacheKey);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    sandGrantCache.delete(cacheKey);
    return undefined;
  }
  return cloneSandQuota(cached.result);
}

function cacheGrantedSandQuota(cacheKey: string, result: CursorSandQuota): void {
  sandGrantCache.set(cacheKey, {
    expiresAt: Date.now() + SAND_GRANT_CACHE_TTL_MS,
    result: cloneSandQuota(result),
  });
}

function sandExchangeFailure(error: unknown): CursorSandUnavailable {
  if (error instanceof ExchangeError) {
    if (error.status === 401 || error.status === 403) {
      return { available: false, source: "cursor_sand_rpc", reason: "api_key_invalid", status: error.status };
    }
    return {
      available: false,
      source: "cursor_sand_rpc",
      reason: "exchange_unavailable",
      ...(error.status ? { status: error.status } : {}),
    };
  }
  return { available: false, source: "cursor_sand_rpc", reason: "exchange_unavailable" };
}

function compactSandAccess(payload: Record<string, unknown>): {
  accessState?: string;
  blockReason?: string;
  purchaseChannel?: string;
  purchasableTiers?: string[];
  isPaidTrialPlan?: boolean;
} {
  const purchasableTiers = ownStringArray(payload, "purchasableTiers");
  const isPaidTrialPlan = ownBoolean(payload, "isPaidTrialPlan");
  return {
    ...(optionalString(payload.state) ? { accessState: optionalString(payload.state) } : {}),
    ...(optionalString(payload.blockReason) ? { blockReason: optionalString(payload.blockReason) } : {}),
    ...(optionalString(payload.purchaseChannel) ? { purchaseChannel: optionalString(payload.purchaseChannel) } : {}),
    ...(purchasableTiers === undefined ? {} : { purchasableTiers }),
    ...(isPaidTrialPlan === undefined ? {} : { isPaidTrialPlan }),
  };
}

function mapSandPostError(
  error: unknown,
  unreachable: "sand_access_unreachable" | "sand_usage_unreachable",
  rejected: "sand_access_rejected" | "sand_usage_rejected",
): CursorSandUnavailable {
  if (error instanceof ExchangeError) return sandExchangeFailure(error);
  return {
    available: false,
    source: "cursor_sand_rpc",
    reason: error instanceof DashboardResponseError ? rejected : unreachable,
  };
}

async function dashboardPostRefreshing(
  method: string,
  apiKey: string,
  accessToken: string,
  baseUrl: string,
  request: typeof globalThis.fetch,
  clientType?: string,
): Promise<{ accessToken: string; response: Response; payload: Record<string, unknown> }> {
  let token = accessToken;
  let result = await dashboardPost(method, token, baseUrl, request, clientType);
  if (result.response.status === 401 || result.response.status === 403) {
    token = await exchangeApiKey(apiKey, baseUrl, request);
    result = await dashboardPost(method, token, baseUrl, request, clientType);
  }
  return { accessToken: token, ...result };
}

function clampPercent(value: number): number {
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

export async function fetchCursorDashboardQuota(
  rawApiKey: string,
  options: DashboardOptions = {},
): Promise<CursorDashboardResult> {
  const apiKey = rawApiKey.trim();
  if (!apiKey) return { available: false, source: "cursor_dashboard_rpc", reason: "api_key_missing" };
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const request = options.fetch ?? globalThis.fetch;

  let accessToken: string;
  try {
    accessToken = await exchangeApiKey(apiKey, baseUrl, request);
  } catch (error) {
    return exchangeFailure(error);
  }

  let usageResponse: Response;
  let usagePayload: Record<string, unknown>;
  try {
    ({ response: usageResponse, payload: usagePayload } = await dashboardPost(
      "GetCurrentPeriodUsage",
      accessToken,
      baseUrl,
      request,
    ));
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      accessToken = await exchangeApiKey(apiKey, baseUrl, request);
      ({ response: usageResponse, payload: usagePayload } = await dashboardPost(
        "GetCurrentPeriodUsage",
        accessToken,
        baseUrl,
        request,
      ));
    }
  } catch (error) {
    return error instanceof ExchangeError
      ? exchangeFailure(error)
      : error instanceof DashboardResponseError
        ? { available: false, source: "cursor_dashboard_rpc", reason: "dashboard_invalid_response" }
      : { available: false, source: "cursor_dashboard_rpc", reason: "dashboard_unreachable" };
  }
  if (!usageResponse.ok) {
    return {
      available: false,
      source: "cursor_dashboard_rpc",
      reason: "dashboard_rejected",
      status: usageResponse.status,
    };
  }

  let planPayload: Record<string, unknown> = {};
  try {
    const plan = await dashboardPost("GetPlanInfo", accessToken, baseUrl, request);
    if (plan.response.ok) planPayload = plan.payload;
  } catch {
    // Usage remains authoritative when the optional plan label is unavailable.
  }

  try {
    const planUsage = (usagePayload.planUsage ?? {}) as Record<string, unknown>;
    const spendLimitUsage = (usagePayload.spendLimitUsage ?? {}) as Record<string, unknown>;
    const planInfo = (planPayload.planInfo ?? {}) as Record<string, unknown>;
    const limitCents = ownNumber(planUsage, "limit");
    const remainingCents = ownNumber(planUsage, "remaining");
    let usedCents = ownNumber(planUsage, "includedSpend");
    if (usedCents === undefined && limitCents !== undefined && remainingCents !== undefined) {
      usedCents = Math.max(0, limitCents - remainingCents);
    }
    const totalSpendCents = ownNumber(planUsage, "totalSpend");
    const cursorModelsPercentUsed = ownNumber(planUsage, "totalPercentUsed");
    const otherModelsPercentUsed = ownNumber(planUsage, "apiPercentUsed");
    const autoModelsPercentUsed = ownNumber(planUsage, "autoPercentUsed");
    if ([
      limitCents,
      remainingCents,
      usedCents,
      totalSpendCents,
      cursorModelsPercentUsed,
      otherModelsPercentUsed,
      autoModelsPercentUsed,
    ].every((value) => value === undefined)) {
      return { available: false, source: "cursor_dashboard_rpc", reason: "dashboard_invalid_response" };
    }
    const usedPercent = limitCents !== undefined && limitCents > 0 && usedCents !== undefined
      ? (usedCents / limitCents) * 100
      : cursorModelsPercentUsed;
    const cents = (record: Record<string, unknown>, key: string): number | undefined => {
      const value = ownNumber(record, key);
      return value === undefined ? undefined : value / 100;
    };
    return {
      available: true,
      source: "cursor_dashboard_rpc",
      planName: optionalString(planInfo.planName),
      planPrice: optionalString(planInfo.price),
      planOwner: optionalString(planInfo.planOwner),
      billingCycleStart: optionalString(usagePayload.billingCycleStart),
      billingCycleEnd: optionalString(usagePayload.billingCycleEnd),
      ...(usedCents === undefined ? {} : { usedUsd: usedCents / 100 }),
      ...(totalSpendCents === undefined ? {} : { totalSpendUsd: totalSpendCents / 100 }),
      ...(remainingCents === undefined ? {} : { remainingUsd: remainingCents / 100 }),
      ...(limitCents === undefined ? {} : { limitUsd: limitCents / 100 }),
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(cursorModelsPercentUsed === undefined ? {} : { cursorModelsPercentUsed }),
      ...(otherModelsPercentUsed === undefined ? {} : { otherModelsPercentUsed }),
      ...(autoModelsPercentUsed === undefined ? {} : { autoModelsPercentUsed }),
      ...(cents(planUsage, "bonusSpend") === undefined ? {} : { bonusSpendUsd: cents(planUsage, "bonusSpend") }),
      ...(cents(spendLimitUsage, "totalSpend") === undefined ? {} : { onDemandSpendUsd: cents(spendLimitUsage, "totalSpend") }),
      onDemandLimitType: optionalString(spendLimitUsage.limitType),
      ...(cents(spendLimitUsage, "individualLimit") === undefined ? {} : { onDemandIndividualLimit: cents(spendLimitUsage, "individualLimit") }),
      ...(cents(spendLimitUsage, "individualUsed") === undefined ? {} : { onDemandIndividualUsed: cents(spendLimitUsage, "individualUsed") }),
      ...(cents(spendLimitUsage, "individualRemaining") === undefined ? {} : { onDemandIndividualRemaining: cents(spendLimitUsage, "individualRemaining") }),
      ...(cents(spendLimitUsage, "pooledLimit") === undefined ? {} : { onDemandPooledLimit: cents(spendLimitUsage, "pooledLimit") }),
      ...(cents(spendLimitUsage, "pooledUsed") === undefined ? {} : { onDemandPooledUsed: cents(spendLimitUsage, "pooledUsed") }),
      ...(cents(spendLimitUsage, "pooledRemaining") === undefined ? {} : { onDemandPooledRemaining: cents(spendLimitUsage, "pooledRemaining") }),
    };
  } catch {
    return { available: false, source: "cursor_dashboard_rpc", reason: "dashboard_invalid_response" };
  }
}

export async function fetchCursorSandQuota(
  rawApiKey: string,
  options: DashboardOptions = {},
): Promise<CursorSandResult> {
  const apiKey = rawApiKey.trim();
  if (!apiKey) return { available: false, source: "cursor_sand_rpc", reason: "api_key_missing" };
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const request = options.fetch ?? globalThis.fetch;
  const cacheKey = sandCacheKey(baseUrl, apiKey);
  const cached = readCachedSandQuota(cacheKey, options.bypassCache);
  if (cached) return cached;

  let accessToken: string;
  try {
    accessToken = await exchangeApiKey(apiKey, baseUrl, request);
  } catch (error) {
    return sandExchangeFailure(error);
  }

  let accessResponse: Response;
  let accessPayload: Record<string, unknown>;
  try {
    ({ accessToken, response: accessResponse, payload: accessPayload } = await dashboardPostRefreshing(
      "GetSandAccessStatus",
      apiKey,
      accessToken,
      baseUrl,
      request,
      SAND_CLIENT_TYPE,
    ));
  } catch (error) {
    return mapSandPostError(error, "sand_access_unreachable", "sand_access_rejected");
  }
  if (!accessResponse.ok) {
    return {
      available: false,
      source: "cursor_sand_rpc",
      reason: "sand_access_rejected",
      status: accessResponse.status,
    };
  }

  const access = compactSandAccess(accessPayload);
  const granted = (access.accessState ?? "").toUpperCase() === SAND_ACCESS_GRANTED;
  if (!granted) {
    sandGrantCache.delete(cacheKey);
    return {
      available: false,
      source: "cursor_sand_rpc",
      reason: "sand_access_not_granted",
      ...access,
    };
  }

  let usageResponse: Response;
  let usagePayload: Record<string, unknown>;
  try {
    ({ accessToken, response: usageResponse, payload: usagePayload } = await dashboardPostRefreshing(
      "GetSandUsageStatus",
      apiKey,
      accessToken,
      baseUrl,
      request,
      SAND_CLIENT_TYPE,
    ));
  } catch (error) {
    return mapSandPostError(error, "sand_usage_unreachable", "sand_usage_rejected");
  }
  if (!usageResponse.ok) {
    return {
      available: false,
      source: "cursor_sand_rpc",
      reason: "sand_usage_rejected",
      status: usageResponse.status,
      ...access,
    };
  }

  const usedPercentRaw = ownNumber(usagePayload, "usagePercent");
  if (usedPercentRaw === undefined) {
    return {
      available: false,
      source: "cursor_sand_rpc",
      reason: "sand_usage_percent_missing",
      ...access,
    };
  }

  const usedPercent = clampPercent(usedPercentRaw);
  const hasAvailableUsage = ownBoolean(usagePayload, "hasAvailableUsage");
  const hasNonZeroIncludedLimit = ownBoolean(usagePayload, "hasNonZeroIncludedLimit");
  const includedLimitZero = ownBoolean(usagePayload, "includedLimitZero");
  const usesPooledEnterpriseAllowance = ownBoolean(usagePayload, "usesPooledEnterpriseAllowance");
  const planLabel = optionalString(usagePayload.grokPlanLabel);
  const currentPeriodStart = optionalString(usagePayload.currentPeriodStart);
  const nextResetTimestampUtc = optionalString(usagePayload.nextResetTimestampUtc);
  const result: CursorSandQuota = {
    available: true,
    source: "cursor_sand_rpc",
    usedPercent,
    remainingPercent: 100 - usedPercent,
    ...access,
    accessState: access.accessState ?? SAND_ACCESS_GRANTED,
    ...(planLabel ? { planLabel } : {}),
    ...(currentPeriodStart ? { currentPeriodStart } : {}),
    ...(nextResetTimestampUtc ? { nextResetTimestampUtc } : {}),
    ...(hasAvailableUsage === undefined ? {} : { hasAvailableUsage }),
    ...(hasNonZeroIncludedLimit === undefined ? {} : { hasNonZeroIncludedLimit }),
    ...(includedLimitZero === undefined ? {} : { includedLimitZero }),
    ...(usesPooledEnterpriseAllowance === undefined ? {} : { usesPooledEnterpriseAllowance }),
  };
  cacheGrantedSandQuota(cacheKey, result);
  return cloneSandQuota(result);
}
