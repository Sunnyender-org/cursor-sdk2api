import { brotliDecompressSync } from "node:zlib";
import { credentialFingerprint } from "../digest.js";

const DEFAULT_BASE_URL = "https://api2.cursor.sh";
const RESPONSE_LIMIT = 1 << 20;
const EXCHANGE_TIMEOUT_MS = 10_000;

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

interface DashboardOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
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

function optionalNumber(value: unknown): number | undefined {
  // Number(null), Number(""), Number(false) and Number([]) are a finite 0 the RPC never sent.
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
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
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const response = await request(`${baseUrl}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "connect-protocol-version": "1",
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
    let remainingCents = ownNumber(planUsage, "remaining");
    let usedCents = ownNumber(planUsage, "includedSpend");
    // A spend below zero is not a spend, and Cursor omits planUsage.remaining once the
    // allowance is exhausted; derive the missing side only from a pair that adds up.
    if (usedCents !== undefined && usedCents < 0) usedCents = undefined;
    if (
      usedCents === undefined &&
      limitCents !== undefined &&
      remainingCents !== undefined &&
      remainingCents >= 0 &&
      remainingCents <= limitCents
    ) {
      usedCents = limitCents - remainingCents;
    }
    if (
      remainingCents === undefined &&
      limitCents !== undefined &&
      usedCents !== undefined &&
      usedCents <= limitCents
    ) {
      remainingCents = limitCents - usedCents;
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
    // totalPercentUsed is a different denominator, and a spend past the limit is no fraction of it.
    const usedPercent =
      limitCents !== undefined && limitCents > 0 && usedCents !== undefined && usedCents <= limitCents
        ? (usedCents / limitCents) * 100
        : undefined;
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
