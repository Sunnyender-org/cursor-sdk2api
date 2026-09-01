import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadRuntimePolicyFromEnv,
  parseRuntimeLedgerV2,
  type RuntimePolicy,
} from "./core/runtime-profile.js";
import { instanceId } from "./ids.js";
import { resolveOutboundProxy } from "./sdk/proxy.js";

export type AuthMode = "byok" | "managed";

const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

export interface GatewayConfig {
  host: string;
  port: number;
  authMode: AuthMode;
  managedCursorKey?: string;
  gatewayAccessKey?: string;
  instanceId: string;
  version: string;
  sdkVersion: string;
  globalActiveRuns: number;
  perCredentialActiveRuns: number;
  maxAwaitingSessions: number;
  sessionTtlMs: number;
  replayTtlMs: number;
  runDeadlineMs: number;
  firstEventTimeoutMs: number;
  ordinaryTurnCoordinator: boolean;
  toolBatchSettleMs: number;
  catalogCacheMs: number;
  sweepIntervalMs: number;
  maxBodyBytes: number;
  emptyWorkspaceDir?: string;
  stateDir: string;
  consoleDir: string;
  logLevel: string;
  proxyConfigured: boolean;
  agentTransport: "http1-proxy" | "http2-direct";
  fetchTransport: "undici-proxy" | "fetch-direct";
  capabilities: RuntimeCapabilities;
  runtimePolicy: RuntimePolicy;
  runtimeLedgerV2: boolean;
}

export interface RuntimeCapabilities {
  messages: boolean;
  count_tokens: boolean;
  chat_completions: boolean;
  responses: boolean;
  streaming: boolean;
  thinking: boolean;
  images: boolean;
  tools: boolean;
  parallel_tools: boolean;
  replay: boolean;
  agent_resume: boolean;
  pending_tool_restart_resume: boolean;
  transcript_tool_recovery?: boolean;
  stale_auth_recovery?: boolean;
  managed_account_failover?: boolean;
  ordinary_turn_coordinator?: boolean;
  streaming_impl?: "sdk_onDelta";
  store_backend?: "jsonl";
}

export const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  messages: true,
  count_tokens: true,
  chat_completions: true,
  responses: true,
  streaming: true,
  thinking: true,
  images: true,
  tools: true,
  parallel_tools: true,
  replay: true,
  agent_resume: true,
  pending_tool_restart_resume: true,
  transcript_tool_recovery: true,
  stale_auth_recovery: true,
  managed_account_failover: true,
  ordinary_turn_coordinator: true,
  streaming_impl: "sdk_onDelta",
  store_backend: "jsonl",
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  throw new Error(`Environment variable ${name} must be a boolean`);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function loadConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  const authMode = (process.env.AUTH_MODE === "managed" ? "managed" : "byok") as AuthMode;
  const sessionTtlMs = clamp(envInt("SESSION_TTL_MS", 30 * 60_000), 5 * 60_000, 60 * 60_000);
  const proxyConfigured = Boolean(resolveOutboundProxy(process.env));
  const packagedConsoleDir = fileURLToPath(new URL("./console/", import.meta.url));
  const defaultConsoleDir = existsSync(packagedConsoleDir)
    ? packagedConsoleDir
    : join(process.cwd(), "dist", "console");
  const config: GatewayConfig = {
    host: process.env.HOST ?? "0.0.0.0",
    port: envInt("PORT", 8080),
    authMode,
    managedCursorKey: process.env.CURSOR_API_KEY || undefined,
    gatewayAccessKey: process.env.GATEWAY_ACCESS_KEY || undefined,
    instanceId: instanceId(process.env.INSTANCE_ID),
    version: process.env.GATEWAY_VERSION?.trim() || PACKAGE_VERSION,
    sdkVersion: "1.0.30",
    globalActiveRuns: envInt("GLOBAL_ACTIVE_RUNS", 4),
    perCredentialActiveRuns: envInt("PER_CREDENTIAL_ACTIVE_RUNS", 2),
    maxAwaitingSessions: envInt("MAX_AWAITING_SESSIONS", 32),
    sessionTtlMs,
    replayTtlMs: envInt("REPLAY_TTL_MS", 10 * 60_000),
    runDeadlineMs: envInt("RUN_DEADLINE_MS", 60 * 60_000),
    firstEventTimeoutMs: envInt("FIRST_EVENT_TIMEOUT_MS", 40_000),
    ordinaryTurnCoordinator: envBool(
      "ORDINARY_TURN_COORDINATOR",
      envBool("CURSOR_AGENT_TURN_COORDINATOR", true),
    ),
    toolBatchSettleMs: envInt("TOOL_BATCH_SETTLE_MS", 1_500),
    catalogCacheMs: envInt("CATALOG_CACHE_MS", 5 * 60_000),
    sweepIntervalMs: envInt("SWEEP_INTERVAL_MS", 5_000),
    maxBodyBytes: envInt("MAX_BODY_BYTES", 2 * 1024 * 1024),
    emptyWorkspaceDir: process.env.EMPTY_WORKSPACE_DIR || undefined,
    stateDir: process.env.STATE_DIR?.trim() || join(tmpdir(), "cursor-sdk2api", "state"),
    consoleDir: process.env.CONSOLE_DIR?.trim() || defaultConsoleDir,
    logLevel: process.env.LOG_LEVEL ?? "info",
    proxyConfigured,
    agentTransport: proxyConfigured ? "http1-proxy" : "http2-direct",
    fetchTransport: proxyConfigured ? "undici-proxy" : "fetch-direct",
    capabilities: { ...DEFAULT_CAPABILITIES },
    runtimePolicy: loadRuntimePolicyFromEnv(),
    runtimeLedgerV2: parseRuntimeLedgerV2(),
  };

  if (authMode === "managed") {
    if (!config.gatewayAccessKey) {
      throw new Error("AUTH_MODE=managed requires GATEWAY_ACCESS_KEY");
    }
    if (config.managedCursorKey && config.managedCursorKey === config.gatewayAccessKey) {
      throw new Error("GATEWAY_ACCESS_KEY must be a different secret from CURSOR_API_KEY");
    }
  }

  const merged = { ...config, ...overrides };
  return {
    ...merged,
    capabilities: {
      ...config.capabilities,
      ordinary_turn_coordinator: merged.ordinaryTurnCoordinator,
      ...overrides.capabilities,
    },
  };
}
