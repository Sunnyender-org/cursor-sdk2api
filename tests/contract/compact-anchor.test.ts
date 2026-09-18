import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import {
  COMPACT_HMAC_KEY_BYTES,
  COMPACT_TOKEN_PREFIX,
  CompactAnchorStore,
  compactTranscriptDigest,
} from "../../src/core/compact-anchor.js";
import { renderPrompt } from "../../src/protocols/anthropic/parse.js";
import { sdkPromptMaxCharsForModel } from "../../src/core/model-context.js";
import type { ParsedMessages } from "../../src/protocols/anthropic/types.js";
import { GatewayError } from "../../src/errors.js";

function storeAt(clock = new FakeClock(1_000_000)): { store: CompactAnchorStore; dir: string; clock: FakeClock } {
  const dir = mkdtempSync(join(tmpdir(), "cursor-sdk2api-compact-"));
  return { store: new CompactAnchorStore(dir, clock), dir, clock };
}

const binding = {
  account: "acct-a",
  profile: "sdk" as const,
  policyDigest: "policy-a",
  model: "composer-2.5",
  transcriptDigest: "digest-a",
};

test("mints a csgw1 HMAC token and refuses v3 prefixes", () => {
  const { store, dir } = storeAt();
  const { token, record } = store.mint(binding);
  expect(token.startsWith(COMPACT_TOKEN_PREFIX)).toBe(true);
  expect(token.startsWith("v3.")).toBe(false);
  expect(record.transcriptDigest).toBe("digest-a");
  const key = readFileSync(join(dir, "compact-hmac.key"));
  expect(key).toHaveLength(COMPACT_HMAC_KEY_BYTES);
  chmodSync(join(dir, "compact-hmac.key"), 0o600);
  expect(store.verify(token, binding).compactId).toBe(record.compactId);

  const err = (): unknown => {
    try {
      store.verify("v3.not-this-gateway", binding);
      return undefined;
    } catch (error) {
      return error;
    }
  };
  const thrown = err();
  expect(thrown).toBeInstanceOf(GatewayError);
  expect(thrown).toMatchObject({ code: "invalid_request", httpStatus: 422 });
});

test("tamper, expiry, account, profile, and model/policy mismatches fail closed", () => {
  const { store, clock } = storeAt();
  const { token } = store.mint(binding);

  expect(() => store.verify(`${token}x`, binding)).toThrowError(/must be a valid continuation token/);
  expect(() => store.verify(token, { ...binding, account: "acct-b" })).toThrowError(/different account/);
  expect(() => store.verify(token, { ...binding, profile: "sand" })).toThrowError(/runtime profile/);
  expect(() => store.verify(token, { ...binding, model: "other" })).toThrowError(/model or tools/);
  expect(() => store.verify(token, { ...binding, policyDigest: "other" })).toThrowError(/model or tools/);

  clock.advance(8 * 24 * 60 * 60 * 1000);
  expect(() => store.verify(token, binding)).toThrowError(/expired/);
});

test("missing local compact state fails closed without the transcript", () => {
  const { store, dir } = storeAt();
  const { token } = store.mint({ ...binding, transcriptDigest: "digest-secret-history" });
  rmSync(join(dir, "compacts"), { recursive: true, force: true });
  try {
    store.verify(token, binding);
    throw new Error("expected missing state to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayError);
    expect(error).toMatchObject({ code: "cursor_session_conflict", httpStatus: 409 });
  }
  const leftover = readdirSync(dir);
  expect(leftover.some((name) => name.includes("digest-secret-history"))).toBe(false);
});

test("compact transcript digest hashes blobs instead of stuffing raw image bytes", () => {
  const pngA = "A".repeat(80_000);
  const pngB = "B".repeat(80_000);
  const digestOf = (data: string) =>
    compactTranscriptDigest({
      model: "composer-2.5",
      systemText: "sys",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data } },
          ],
        },
      ],
      tools: [],
    });
  const first = digestOf(pngA);
  expect(first).toMatch(/^[a-f0-9]{64}$/);
  expect(digestOf(pngA)).toBe(first);
  expect(digestOf(pngB)).not.toBe(first);
});

function parsedWithHistory(turns: number, chunk: string): ParsedMessages {
  return {
    model: "composer-2.5",
    modelParams: [],
    stream: false,
    systemText: "keep",
    messages: Array.from({ length: turns }, (_, index) => ({
      role: "user" as const,
      content: `turn-${index} ${chunk}`,
    })),
    tools: [],
    images: [],
    lastUser: undefined,
    continuation: undefined,
    toolChoice: { mode: "auto", disableParallel: false },
  };
}

test("rebuild prompt keeps the tail under the SDK send budget", () => {
  const parsed = parsedWithHistory(40, "x".repeat(8_000));
  const budget = sdkPromptMaxCharsForModel("composer-2.5");
  const full = renderPrompt(parsed);
  expect(full.text.length).toBeGreaterThan(budget);
  const bounded = renderPrompt(parsed, { maxChars: budget });
  expect(bounded.text.length).toBeLessThanOrEqual(budget + 120);
  expect(bounded.text).toContain("local compact omitted");
  expect(bounded.text).toContain("turn-39");
  expect(bounded.text).not.toContain("turn-0 ");
});
