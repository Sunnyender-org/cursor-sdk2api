/**
 * Cursor.models.list does not publish a context window. Compact/rebuild Send
 * budgets are derived from the live catalog id's family, optional env
 * overrides, and a compact-fill ratio so Auto/Composer/Grok/Claude do not
 * share one 120k-char cap.
 */

export const CHARS_PER_TOKEN = 4;
export const DEFAULT_CONTEXT_TOKENS = 128_000;
export const OUTPUT_RESERVE_TOKENS = 8_192;
export const DEFAULT_COMPACT_FILL_RATIO = 0.25;
export const MIN_COMPACT_CHARS = 48_000;
export const MAX_COMPACT_CHARS = 360_000;

const CONTEXT_TOKENS_BY_ID: Record<string, number> = {
  default: 128_000,
  "composer-2.5": 200_000,
  "composer-2": 200_000,
  "grok-4.6": 256_000,
  "grok-4.5": 256_000,
};

/** Longest prefix wins. Conservative Cursor-hosted windows, not max advertised. */
const CONTEXT_TOKENS_BY_PREFIX: Array<[string, number]> = (
  [
    ["gpt-5.4-nano", 128_000],
    ["gpt-5.4-mini", 128_000],
    ["gpt-5-mini", 128_000],
    ["gpt-5", 272_000],
    ["claude-haiku", 200_000],
    ["claude-fable", 200_000],
    ["claude-sonnet", 200_000],
    ["claude-opus", 200_000],
    ["claude-", 200_000],
    ["gemini-", 1_000_000],
    ["grok-", 256_000],
    ["composer-", 200_000],
    ["kimi-", 256_000],
    ["glm-", 200_000],
    ["muse-", 128_000],
  ] as Array<[string, number]>
).sort((left, right) => right[0].length - left[0].length);

export function parseModelContextTokens(raw: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw?.trim()) return out;
  for (const part of raw.split(/[,;\s]+/)) {
    if (!part) continue;
    const split = part.lastIndexOf(":");
    if (split <= 0) continue;
    const id = part.slice(0, split).trim();
    const tokens = Number.parseInt(part.slice(split + 1), 10);
    if (!id || !Number.isFinite(tokens) || tokens < 16_000) continue;
    out[id] = Math.min(2_000_000, tokens);
  }
  return out;
}

export function contextTokensForModel(
  modelId: string,
  overrides: Record<string, number> = {},
): number {
  const id = modelId.trim() || "default";
  if (overrides[id] && overrides[id] > 0) return overrides[id]!;
  if (CONTEXT_TOKENS_BY_ID[id]) return CONTEXT_TOKENS_BY_ID[id]!;
  const prefix = CONTEXT_TOKENS_BY_PREFIX.find(([start]) => id.startsWith(start));
  if (prefix) return prefix[1];
  return DEFAULT_CONTEXT_TOKENS;
}

export function sdkPromptMaxCharsForModel(
  modelId: string,
  overrides: Record<string, number> = {},
  fillRatio = DEFAULT_COMPACT_FILL_RATIO,
): number {
  const context = contextTokensForModel(modelId, overrides);
  const usable = Math.max(16_000, context - OUTPUT_RESERVE_TOKENS);
  const ratio = Math.min(0.7, Math.max(0.1, fillRatio));
  const chars = Math.floor(usable * ratio) * CHARS_PER_TOKEN;
  return Math.min(MAX_COMPACT_CHARS, Math.max(MIN_COMPACT_CHARS, chars));
}

/** Fallback budget for unknown models (Auto / missing catalog). */
export const SDK_PROMPT_MAX_CHARS = sdkPromptMaxCharsForModel("default");
