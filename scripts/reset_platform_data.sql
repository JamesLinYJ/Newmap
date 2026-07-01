-- +-------------------------------------------------------------------------
--
--   地理智能平台 - 开发库平台数据重置脚本
--
--   文件:       reset_platform_data.sql
--
--   日期:       2026年05月21日
--   作者:       OpenAI Codex
-- --------------------------------------------------------------------------
--
-- 显式清空平台运行数据。API 启动不会自动执行本脚本。
-- 文件会话位于 runtime/conversations；文件清理由 npm run reset:conversations 显式执行。

DROP TABLE IF EXISTS platform_context_entries CASCADE;
DROP TABLE IF EXISTS platform_thread_context CASCADE;
TRUNCATE TABLE platform_artifacts;
TRUNCATE TABLE platform_meteorological_datasets;
TRUNCATE TABLE platform_meteorological_jobs;
DROP TABLE IF EXISTS platform_events CASCADE;
DROP TABLE IF EXISTS platform_runs CASCADE;
DROP TABLE IF EXISTS platform_threads CASCADE;
DROP TABLE IF EXISTS platform_sessions CASCADE;
