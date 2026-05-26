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
-- JSONL 会话日志位于 runtime/sessions；需要彻底重置时需手工删除该目录。

DROP TABLE IF EXISTS platform_context_entries CASCADE;
DROP TABLE IF EXISTS platform_thread_context CASCADE;
DROP TABLE IF EXISTS platform_weather_jobs CASCADE;
DROP TABLE IF EXISTS platform_weather_datasets CASCADE;
DROP TABLE IF EXISTS platform_artifacts CASCADE;
DROP TABLE IF EXISTS platform_events CASCADE;
DROP TABLE IF EXISTS platform_runs CASCADE;
DROP TABLE IF EXISTS platform_threads CASCADE;
DROP TABLE IF EXISTS platform_sessions CASCADE;
DROP TABLE IF EXISTS platform_runtime_config CASCADE;
