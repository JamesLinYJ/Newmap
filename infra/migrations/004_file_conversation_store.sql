-- +-------------------------------------------------------------------------
--
--   地理智能平台 - 移除数据库会话投影
--
--   文件:       004_file_conversation_store.sql
--
--   日期:       2026年06月22日
--   作者:       OpenAI Codex
-- --------------------------------------------------------------------------

-- session/thread/run/transcript 已迁移到 runtime/conversations 文件事实源。
DROP TABLE IF EXISTS platform_sessions;
