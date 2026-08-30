-- ============================================================
-- 054_add_deepseek_provider.sql — Add DeepSeek as AI provider
--
-- Extends the existing CHECK constraints on ai_configs.provider
-- and ai_usage_log.provider to accept 'deepseek' alongside
-- 'openai' and 'anthropic'.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Drop and recreate ai_configs.provider CHECK to include 'deepseek'.
ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'deepseek'));

-- Drop and recreate ai_usage_log.provider CHECK to include 'deepseek'.
ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'deepseek'));
