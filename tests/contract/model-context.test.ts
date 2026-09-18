import { expect, test } from "vitest";
import {
  contextTokensForModel,
  parseModelContextTokens,
  sdkPromptMaxCharsForModel,
} from "../../src/core/model-context.js";

test("compact windows follow catalog families instead of one global cap", () => {
  const auto = sdkPromptMaxCharsForModel("default");
  const composer = sdkPromptMaxCharsForModel("composer-2.5");
  const grok = sdkPromptMaxCharsForModel("grok-4.6");
  const sonnet = sdkPromptMaxCharsForModel("claude-sonnet-5");
  const mini = sdkPromptMaxCharsForModel("gpt-5.4-mini");
  const gemini = sdkPromptMaxCharsForModel("gemini-3.1-pro");
  expect(contextTokensForModel("default")).toBe(128_000);
  expect(contextTokensForModel("composer-2.5")).toBe(200_000);
  expect(contextTokensForModel("grok-4.6")).toBe(256_000);
  expect(auto).toBeLessThan(composer);
  expect(composer).toBeLessThan(grok);
  expect(sonnet).toBe(composer);
  expect(mini).toBe(auto);
  expect(gemini).toBeGreaterThan(grok);
});

test("MODEL_CONTEXT_TOKENS overrides beat the family table", () => {
  const overrides = parseModelContextTokens("grok-4.6:128000,composer-2.5:400000");
  expect(contextTokensForModel("grok-4.6", overrides)).toBe(128_000);
  expect(sdkPromptMaxCharsForModel("grok-4.6", overrides)).toBeLessThan(
    sdkPromptMaxCharsForModel("composer-2.5", overrides),
  );
});
