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
