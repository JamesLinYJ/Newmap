-- +-------------------------------------------------------------------------
--
--   地理智能平台 - Migration 002: 按 thread 隔离上传数据
--
--   日期:       2026年05月21日
--   作者:       Claude Code
-- --------------------------------------------------------------------------
--
-- layers_metadata 的 session_id / thread_id 存在 metadata_json 里，
-- 已有数据用 session 级通配（thread_id IS NULL 表示所有 thread 可见）。
--
-- platform_weather_datasets 新增 thread_id 列。

ALTER TABLE platform_weather_datasets
    ADD COLUMN IF NOT EXISTS thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_weather_datasets_thread_updated
    ON platform_weather_datasets(thread_id, updated_at DESC);
