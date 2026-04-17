CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS layers_metadata (
  layer_key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  geometry_type TEXT NOT NULL,
  srid INTEGER NOT NULL DEFAULT 4326,
  table_name TEXT NOT NULL,
  description TEXT NOT NULL,
  feature_count INTEGER,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS platform_sessions (
  session_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_runs (
  run_id TEXT PRIMARY KEY,
  thread_id TEXT,
  session_id TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_threads (
  thread_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES platform_sessions(session_id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES platform_runs(run_id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  name TEXT NOT NULL,
  uri TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  geojson_relative_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tool_catalog_entries (
  tool_name TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tool_name, tool_kind)
);

CREATE INDEX IF NOT EXISTS idx_platform_runs_session_updated
  ON platform_runs(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_runs_thread_updated
  ON platform_runs(thread_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_threads_session_updated
  ON platform_threads(session_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_platform_events_run_occurred
  ON platform_events(run_id, occurred_at, event_id);
