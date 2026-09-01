import type { SdkUsage } from "../sdk/port.js";
import type { UsageView } from "../protocols/anthropic/types.js";
import type { LedgerUsage } from "./runtime-ledger/types.js";

export function deferredUsage(): UsageView {
  return {
    input_tokens: 0,
    output_tokens: 0,
    usage_deferred: true,
    usage_status: "deferred",
  };
}

export function unavailableUsage(): UsageView {
  return {
    input_tokens: 0,
    output_tokens: 0,
    usage_status: "unavailable",
  };
}

export function fromSdkUsage(usage: SdkUsage | undefined): UsageView {
  if (!usage) return unavailableUsage();
  const view: UsageView = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    usage_status: "sdk",
  };
  if (typeof usage.cacheWriteTokens === "number") {
    view.cache_creation_input_tokens = usage.cacheWriteTokens;
  }
  if (typeof usage.cacheReadTokens === "number") {
    view.cache_read_input_tokens = usage.cacheReadTokens;
  }
  if (typeof usage.reasoningTokens === "number") {
    view.reasoning_tokens = usage.reasoningTokens;
  }
  return view;
}

/** Map protocol usage to ledger token ints. Deferred usage is omitted, never invented. */
export function toLedgerUsage(usage: UsageView | undefined): LedgerUsage | undefined {
  if (!usage) return undefined;
  if (usage.usage_status === "deferred" || usage.usage_deferred) return undefined;
  const mapped: LedgerUsage = {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
  };
  if (typeof usage.cache_creation_input_tokens === "number") {
    mapped.cacheWriteTokens = usage.cache_creation_input_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    mapped.cacheReadTokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.reasoning_tokens === "number") {
    mapped.reasoningTokens = usage.reasoning_tokens;
  }
  return mapped;
}
