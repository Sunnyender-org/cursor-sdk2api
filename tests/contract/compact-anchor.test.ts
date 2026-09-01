import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { FakeClock } from "../../src/clock.js";
import {
  COMPACT_HMAC_KEY_BYTES,
  COMPACT_TOKEN_PREFIX,
  CompactAnchorStore,
} from "../../src/core/compact-anchor.js";
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
