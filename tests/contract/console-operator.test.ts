import { expect, test } from "vitest";
import { catalogHasFable5, modelLooksLikeFable5 } from "../../web/src/fable5.js";
import { formatQuota, formatQuotaBreakdown } from "../../web/src/quota.js";
import { maskKey } from "../../web/src/accounts.js";
import { RECIPE_ORDER } from "../../web/src/recipes.js";

test("Fable 5 is recognized from official model ids", () => {
  expect(modelLooksLikeFable5("claude-fable-5")).toBe(true);
  expect(modelLooksLikeFable5("composer-2.5")).toBe(false);
  expect(
    catalogHasFable5({
      object: "list",
      status: "ok",
      data: [{ id: "claude-fable-5", display_name: "Claude Fable 5" }],
      cache: { stale: false },
    }),
  ).toBe(true);
  expect(
    catalogHasFable5({
      object: "list",
      status: "ok",
      data: [{ id: "composer-2.5" }],
      cache: { stale: false },
    }),
  ).toBe(false);
});

test("quota formatter never invents remaining when the official surface is empty", () => {
  expect(
    formatQuota({
      status: "partial",
      identity: { api_key_name: "local-dev" },
      capabilities: { identity: true, spending: false, limits: false },
    }),
  ).toBe("");
});

test("quota formatter does not publish an empty zero quota as real usage", () => {
  expect(
    formatQuota({
      status: "ok",
      identity: { api_key_name: "local-dev" },
      limits: { remaining_usd: 0, limit_usd: 0 },
      capabilities: { identity: true, spending: false, limits: true },
    }),
  ).toBe("");
});

test("quota formatter renders the dashboard remaining and included limit compactly", () => {
  expect(
    formatQuota({
      status: "ok",
      identity: { api_key_name: "local-dev" },
      spending: { plan_name: "Ultra", used_usd: 19.65 },
      limits: {
        remaining_usd: 380.35,
        limit_usd: 400,
        cursor_models_percent_used: 1.04,
        other_models_percent_used: 5.16,
      },
      capabilities: { identity: true, spending: true, limits: true },
    }),
  ).toBe("$380.35 / $400.00");
});

test("quota formatter keeps Cursor and Claude-family usage percentages separate", () => {
  expect(
    formatQuotaBreakdown({
      status: "ok",
      identity: { api_key_name: "local-dev" },
      spending: { plan_name: "Ultra" },
      limits: { cursor_models_percent_used: 1.04, other_models_percent_used: 5.16 },
      capabilities: { identity: true, spending: true, limits: true },
    }),
  ).toBe("Cursor Models 1.0% · Other Models 5.2%");
});

test("key mask keeps the edges and hides the middle", () => {
  expect(maskKey("cursor_abcdefghijklmnop")).toBe("cursor…mnop");
});

test("quick-start recipes pin Claude to Messages and Grok to Responses", () => {
  expect(RECIPE_ORDER).toEqual(["claude", "grok", "openai", "newapi"]);
});
