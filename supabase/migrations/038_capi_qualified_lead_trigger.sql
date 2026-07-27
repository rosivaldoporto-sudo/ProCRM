-- ============================================================
-- 038_capi_qualified_lead_trigger
--
-- Adds a column to meta_ads_config so admins can select which
-- pipeline stage(s) trigger a "qualified lead" event to Meta's
-- Conversions API — allowing the pixel to optimize for leads
-- that were actually qualified by an agent, rather than every
-- raw inbound WhatsApp message.
--
-- Idempotent. Safe on fresh or existing DB.
-- ============================================================

ALTER TABLE meta_ads_config
  ADD COLUMN IF NOT EXISTS capi_trigger_stage_ids TEXT[] DEFAULT '{}';

COMMENT ON COLUMN meta_ads_config.capi_trigger_stage_ids
  IS 'Array of pipeline_stage.id values. When a deal moves into one of these stages, a Qualified Lead event is sent via the Conversions API. Empty = disabled.';
