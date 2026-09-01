export interface HealthPayload {
  status: "ok" | "not_ready";
  service: string;
  version: string;
  sdk_version: string;
  instance_id: string;
  runtime: string;
  network: {
    proxy_configured: boolean;
    agent_transport: string;
    fetch_transport: string;
  };
  readiness: {
    accepting_sessions: boolean;
    shutting_down: boolean;
  };
  capabilities: Record<string, boolean | string>;
}

export interface ModelPayload {
  id: string;
  display_name?: string;
  description?: string;
  parameters?: unknown[];
  variants?: unknown[];
}

export interface ModelsPayload {
  object: "list";
  status: "ok" | "stale" | "unavailable";
  reason?: string;
  data: ModelPayload[];
  cache: { stale: boolean; reason?: string };
}

export interface AccountPayload {
  status: "ok" | "partial" | "unavailable";
  identity: null | {
    api_key_name?: string;
    user_id?: string;
    first_name?: string;
    last_name?: string;
    created_at?: string;
  };
  spending?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  grok_bot?: {
    available?: boolean;
    used_percent?: unknown;
    remaining_percent?: unknown;
    plan_label?: unknown;
    next_reset_timestamp_utc?: unknown;
    reason?: unknown;
  };
  runtime?: {
    default_profile?: "sdk" | "sand" | string;
    sand_selectable?: boolean;
    applies_to_new_sessions?: boolean;
  };
  capabilities: {
    identity: boolean;
    spending: boolean;
    limits: boolean;
    grok_bot?: boolean;
  };
  reasons?: Record<string, string>;
}

export type Protocol = "messages" | "chat" | "responses";
