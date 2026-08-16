import type { AccountPayload, ModelsPayload } from "./types.js";

export type TestState = "idle" | "testing" | "pass" | "fail";

export interface RosterItem {
  id: string;
  keyHint: string;
  addedAt: number;
  testState: TestState;
  testMs?: number;
  testError?: string;
  account?: AccountPayload;
  models?: ModelsPayload;
}

export function identityLabel(account?: AccountPayload, fallback = ""): string {
  const identity = account?.identity;
  const name = [identity?.first_name, identity?.last_name].filter(Boolean).join(" ");
  return name || identity?.api_key_name || fallback;
}
