export type RuntimeProfile = "sdk" | "sand";
export type HostedSearchMode = "off" | "auto";

export interface RuntimePolicy {
  defaultProfile: RuntimeProfile;
  allowRequestOverride: boolean;
  hostedSearchMode: HostedSearchMode;
}

export const DEFAULT_RUNTIME_PROFILE: RuntimeProfile = "sdk";

export const DEFAULT_RUNTIME_POLICY: RuntimePolicy = {
  defaultProfile: DEFAULT_RUNTIME_PROFILE,
  allowRequestOverride: false,
  hostedSearchMode: "off",
};

const HOSTED_SEARCH_MODES = new Set<string>(["off", "auto"]);
const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off"]);

export function isRuntimeProfile(value: string): value is RuntimeProfile {
  return value === "sdk" || value === "sand";
}

export function parseRuntimeProfile(
  raw: string | undefined | null,
  name = "DEFAULT_RUNTIME_PROFILE",
): RuntimeProfile {
  if (raw == null || raw.trim() === "") return DEFAULT_RUNTIME_PROFILE;
  const trimmed = raw.trim();
  const value = trimmed.toLowerCase();
  if (isRuntimeProfile(value)) return value;
  throw new Error(`${name}: invalid runtime profile "${trimmed}". Expected sdk or sand`);
}

export function boundRuntimeProfile(profile: RuntimeProfile | undefined | null): RuntimeProfile {
  if (profile == null) return DEFAULT_RUNTIME_PROFILE;
  if (profile === "sdk" || profile === "sand") return profile;
  throw new Error(`Invalid runtime profile. Expected sdk or sand`);
}

export function parseHostedSearchMode(
  raw: string | undefined | null,
  name = "HOSTED_SEARCH_MODE",
): HostedSearchMode {
  if (raw == null || raw.trim() === "") return "off";
  const trimmed = raw.trim();
  const value = trimmed.toLowerCase();
  if (HOSTED_SEARCH_MODES.has(value)) return value as HostedSearchMode;
  throw new Error(`${name}: invalid hosted search mode "${trimmed}". Expected off or auto`);
}

export function parseEnvFlag(raw: string | undefined | null, fallback: boolean, name: string): boolean {
  if (raw == null || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (BOOL_TRUE.has(value)) return true;
  if (BOOL_FALSE.has(value)) return false;
  throw new Error(`Environment variable ${name} must be a boolean`);
}

export function loadRuntimePolicyFromEnv(env: NodeJS.Dict<string> = process.env): RuntimePolicy {
  return {
    defaultProfile: parseRuntimeProfile(env.DEFAULT_RUNTIME_PROFILE, "DEFAULT_RUNTIME_PROFILE"),
    allowRequestOverride: parseEnvFlag(
      env.ALLOW_REQUEST_RUNTIME_PROFILE,
      false,
      "ALLOW_REQUEST_RUNTIME_PROFILE",
    ),
    hostedSearchMode: parseHostedSearchMode(env.HOSTED_SEARCH_MODE, "HOSTED_SEARCH_MODE"),
  };
}

export function parseRuntimeLedgerV2(env: NodeJS.Dict<string> = process.env): boolean {
  return parseEnvFlag(env.RUNTIME_LEDGER_V2, false, "RUNTIME_LEDGER_V2");
}

/**
 * Resolve the runtime profile for a request.
 *
 * Sand is never selected unless the operator default or an allowed override
 * explicitly names it. There is no SDK↔Sand auto-fallback.
 *
 * BYOK: `x-cursor-runtime-profile` is ignored unless `allowRequestOverride`.
 *
 * Managed `accountDefaultProfile` applies to *new* sessions only.
 * Existing sessions keep the profile bound on the Agent/Run.
 */
export function resolveRequestProfile(input: {
  header?: string | null;
  policy: RuntimePolicy;
  authMode: "byok" | "managed";
  accountDefaultProfile?: RuntimeProfile | null;
}): RuntimeProfile {
  const header = input.header?.trim() ?? "";
  if (header && input.policy.allowRequestOverride) {
    return parseRuntimeProfile(header, "x-cursor-runtime-profile");
  }
  if (input.accountDefaultProfile) {
    return boundRuntimeProfile(input.accountDefaultProfile);
  }
  return boundRuntimeProfile(input.policy.defaultProfile);
}
