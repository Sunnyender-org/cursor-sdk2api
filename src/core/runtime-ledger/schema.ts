export const RUNTIME_LEDGER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS runtime_ledger_meta (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_agents (
  id TEXT NOT NULL PRIMARY KEY,
  credential_fingerprint TEXT NOT NULL,
  runtime_profile TEXT NOT NULL
    CHECK (runtime_profile IN ('sdk', 'sand')),
  sdk_agent_id TEXT NOT NULL,
  model TEXT,
  policy_digest TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
    CHECK (state IN ('active', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (credential_fingerprint, runtime_profile, sdk_agent_id)
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_runs (
  id TEXT NOT NULL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES runtime_agents(id),
  logical_key TEXT NOT NULL,
  runtime_profile TEXT NOT NULL
    CHECK (runtime_profile IN ('sdk', 'sand')),
  sdk_run_id TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('running', 'awaiting_tool_results', 'finished', 'error', 'runtime_lost')),
  observe_offset TEXT,
  usage_json TEXT,
  receipt_id TEXT,
  terminal_digest TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  terminal_at INTEGER
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_active_logical_key
  ON runtime_runs(logical_key)
  WHERE state IN ('running', 'awaiting_tool_results');

CREATE UNIQUE INDEX IF NOT EXISTS runtime_runs_receipt_id
  ON runtime_runs(receipt_id)
  WHERE receipt_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS runtime_interactions (
  run_id TEXT NOT NULL REFERENCES runtime_runs(id),
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  args_digest TEXT,
  result_digest TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'delivered', 'acknowledged')),
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  PRIMARY KEY (run_id, tool_call_id)
) STRICT;

CREATE TABLE IF NOT EXISTS provider_receipts (
  receipt_id TEXT NOT NULL PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE REFERENCES runtime_runs(id),
  state TEXT NOT NULL
    CHECK (state IN ('provisional', 'finalized')),
  usage_json TEXT,
  finalized_at INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS runtime_quarantine (
  id TEXT NOT NULL PRIMARY KEY,
  source TEXT NOT NULL
    CHECK (source IN ('lineage', 'ordinary-turn')),
  source_path TEXT NOT NULL,
  reason TEXT NOT NULL,
  logical_key TEXT,
  quarantined_at INTEGER NOT NULL
) STRICT;
`;
