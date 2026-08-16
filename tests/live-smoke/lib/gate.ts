import { DEFAULT_LIVE_MODELS } from "./catalog.js";

export interface GateResult {
  ok: boolean;
  code: number;
  message?: string;
}

export function liveSmokeGate(env: Record<string, string | undefined>): GateResult {
  if (env.CURSOR_LIVE_SMOKE !== "1") {
    return {
      ok: false,
      code: 2,
      message: "Refusing live smoke. Set CURSOR_LIVE_SMOKE=1 to opt in.",
    };
  }
  const key = env.CURSOR_API_KEY?.trim();
  if (!key) {
    return {
      ok: false,
      code: 3,
      message: "CURSOR_API_KEY is required when CURSOR_LIVE_SMOKE=1.",
    };
  }
  return { ok: true, code: 0 };
}

export function defaultRequestedModels(env: Record<string, string | undefined>): string[] {
  const raw = env.LIVE_SMOKE_MODELS?.trim();
  if (!raw) {
    return [...DEFAULT_LIVE_MODELS];
  }
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
