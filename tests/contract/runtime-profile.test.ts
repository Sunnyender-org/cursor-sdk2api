import { afterEach, expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  DEFAULT_RUNTIME_POLICY,
  loadRuntimePolicyFromEnv,
  parseHostedSearchMode,
  parseRuntimeLedgerV2,
  parseRuntimeProfile,
  resolveRequestProfile,
  type RuntimePolicy,
} from "../../src/core/runtime-profile.js";

const RUNTIME_ENV = [
  "DEFAULT_RUNTIME_PROFILE",
  "ALLOW_REQUEST_RUNTIME_PROFILE",
  "HOSTED_SEARCH_MODE",
  "RUNTIME_LEDGER_V2",
] as const;

const originalRuntimeEnv = Object.fromEntries(RUNTIME_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  restoreRuntimeEnv();
});

function restoreRuntimeEnv(): void {
  for (const key of RUNTIME_ENV) {
    const value = originalRuntimeEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function withClearedRuntimeEnv(run: () => void): void {
  for (const key of RUNTIME_ENV) delete process.env[key];
  run();
}

const sdkPolicy: RuntimePolicy = { ...DEFAULT_RUNTIME_POLICY };

test("runtime policy env defaults are sdk, no request override, hosted search off, ledger v2 off", () => {
  expect(loadRuntimePolicyFromEnv({})).toEqual(DEFAULT_RUNTIME_POLICY);
  expect(parseRuntimeLedgerV2({})).toBe(false);
  expect(parseRuntimeProfile(undefined)).toBe("sdk");
  expect(parseRuntimeProfile("")).toBe("sdk");
  expect(parseHostedSearchMode(undefined)).toBe("off");
  withClearedRuntimeEnv(() => {
    const config = loadConfig();
    expect(config.runtimePolicy).toEqual(DEFAULT_RUNTIME_POLICY);
    expect(config.runtimeLedgerV2).toBe(false);
  });
});

test("runtime policy env accepts explicit sdk, sand, override, hosted auto, and ledger v2", () => {
  expect(
    loadRuntimePolicyFromEnv({
      DEFAULT_RUNTIME_PROFILE: "sand",
      ALLOW_REQUEST_RUNTIME_PROFILE: "true",
      HOSTED_SEARCH_MODE: "auto",
    }),
  ).toEqual({
    defaultProfile: "sand",
    allowRequestOverride: true,
    hostedSearchMode: "auto",
  });
  expect(loadRuntimePolicyFromEnv({ DEFAULT_RUNTIME_PROFILE: "SDK" }).defaultProfile).toBe("sdk");
  expect(parseRuntimeLedgerV2({ RUNTIME_LEDGER_V2: "1" })).toBe(true);
  withClearedRuntimeEnv(() => {
    process.env.DEFAULT_RUNTIME_PROFILE = "sand";
    process.env.ALLOW_REQUEST_RUNTIME_PROFILE = "yes";
    process.env.HOSTED_SEARCH_MODE = "auto";
    process.env.RUNTIME_LEDGER_V2 = "true";
    const config = loadConfig();
    expect(config.runtimePolicy).toEqual({
      defaultProfile: "sand",
      allowRequestOverride: true,
      hostedSearchMode: "auto",
    });
    expect(config.runtimeLedgerV2).toBe(true);
  });
});

test("invalid runtime profile and hosted search mode fail closed", () => {
  expect(() => loadRuntimePolicyFromEnv({ DEFAULT_RUNTIME_PROFILE: "cpu" })).toThrow(
    /invalid runtime profile "cpu"/,
  );
  expect(() => loadRuntimePolicyFromEnv({ DEFAULT_RUNTIME_PROFILE: "sandbox" })).toThrow(
    /Expected sdk or sand/,
  );
  expect(() => parseRuntimeProfile("default")).toThrow(/Expected sdk or sand/);
  expect(() => loadRuntimePolicyFromEnv({ HOSTED_SEARCH_MODE: "on" })).toThrow(
    /invalid hosted search mode "on"/,
  );
  expect(() => loadRuntimePolicyFromEnv({ ALLOW_REQUEST_RUNTIME_PROFILE: "maybe" })).toThrow(
    /must be a boolean/,
  );
  withClearedRuntimeEnv(() => {
    process.env.DEFAULT_RUNTIME_PROFILE = "cpu";
    expect(() => loadConfig()).toThrow(/invalid runtime profile "cpu"/);
  });
});

test("BYOK request header is ignored unless allowRequestOverride", () => {
  expect(
    resolveRequestProfile({
      header: "sand",
      policy: sdkPolicy,
      authMode: "byok",
    }),
  ).toBe("sdk");
  expect(
    resolveRequestProfile({
      header: "sand",
      policy: { ...sdkPolicy, allowRequestOverride: true },
      authMode: "byok",
    }),
  ).toBe("sand");
  expect(
    resolveRequestProfile({
      header: "cpu",
      policy: sdkPolicy,
      authMode: "byok",
    }),
  ).toBe("sdk");
  expect(() =>
    resolveRequestProfile({
      header: "cpu",
      policy: { ...sdkPolicy, allowRequestOverride: true },
      authMode: "byok",
    }),
  ).toThrow(/invalid runtime profile "cpu"/);
});

test("request profile falls back to policy default when header is omitted", () => {
  expect(
    resolveRequestProfile({
      header: undefined,
      policy: sdkPolicy,
      authMode: "byok",
    }),
  ).toBe("sdk");
  expect(
    resolveRequestProfile({
      header: "  ",
      policy: { ...sdkPolicy, defaultProfile: "sand" },
      authMode: "managed",
    }),
  ).toBe("sand");
});

test("managed account default_profile applies to new sessions unless a request override is allowed", () => {
  expect(
    resolveRequestProfile({
      policy: sdkPolicy,
      authMode: "managed",
      accountDefaultProfile: "sand",
    }),
  ).toBe("sand");
  expect(
    resolveRequestProfile({
      header: "sdk",
      policy: sdkPolicy,
      authMode: "managed",
      accountDefaultProfile: "sand",
    }),
  ).toBe("sand");
  expect(
    resolveRequestProfile({
      header: "sdk",
      policy: { ...sdkPolicy, allowRequestOverride: true },
      authMode: "managed",
      accountDefaultProfile: "sand",
    }),
  ).toBe("sdk");
});
