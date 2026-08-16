import type { ParsedMessages } from "./types.js";

function estimatedTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.codePointAt(0)! <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function sanitizedJson(value: unknown): string {
  return JSON.stringify(value, (key, inner) => {
    if (
      key === "data" &&
      typeof inner === "string" &&
      inner.length > 256 &&
      /^[A-Za-z0-9+/=\r\n]+$/.test(inner)
    ) {
      return "[binary omitted]";
    }
    return inner;
  }) ?? "";
}

/**
 * The official Cursor SDK has no tokenizer preflight. This intentionally
 * conservative estimate exists only for Claude Code context sizing and never
 * drives billing. Final SDK usage remains the accounting source of truth.
 */
export function estimateAnthropicInputTokens(raw: unknown, parsed: ParsedMessages): number {
  const serialized = sanitizedJson(raw);
  const text = estimatedTextTokens(serialized);
  const messageOverhead = parsed.messages.length * 4;
  const toolOverhead = parsed.tools.length * 8;
  const imageEstimate = parsed.images.length * 1_600;
  return Math.max(1, text + messageOverhead + toolOverhead + imageEstimate);
}
