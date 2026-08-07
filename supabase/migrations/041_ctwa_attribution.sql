-- ============================================================
-- 041_ctwa_attribution
--
-- Click-to-WhatsApp (CTWA) ad attribution on contacts. When a lead
-- arrives from a Meta Ads CTWA campaign, the WhatsApp webhook carries
-- a `referral` object with `ctwa_clid` (unique click id) and
-- `source_id` (ad id). The ad/campaign NAMES are only available via
-- GET /{phone_number_id}/messages/{message_id}, which the webhook
-- calls once per lead and caches here.
--
-- Idempotent. Safe to run on a fresh DB or an existing one.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid      TEXT,
  ADD COLUMN IF NOT EXISTS ad_id          TEXT,
  ADD COLUMN IF NOT EXISTS ad_name        TEXT,
  ADD COLUMN IF NOT EXISTS campaign_id    TEXT,
  ADD COLUMN IF NOT EXISTS campaign_name  TEXT,
  ADD COLUMN IF NOT EXISTS ad_source_type TEXT;

COMMENT ON COLUMN contacts.ctwa_clid      IS 'Click-to-WhatsApp click id (atribuição do clique no anúncio Meta)';
COMMENT ON COLUMN contacts.ad_id          IS 'ID do anúncio CTWA que originou o lead';
COMMENT ON COLUMN contacts.ad_name        IS 'Nome do anúncio CTWA (enriquecido via GET message details)';
COMMENT ON COLUMN contacts.campaign_id    IS 'ID da campanha Meta que originou o lead';
COMMENT ON COLUMN contacts.campaign_name  IS 'Nome da campanha Meta (enriquecido via GET message details)';
COMMENT ON COLUMN contacts.ad_source_type IS 'Tipo de origem do anúncio (ad, ctwa, ig_ctwa, …)';

-- Índice parcial para consultas de atribuição por clique.
CREATE INDEX IF NOT EXISTS idx_contacts_ctwa_clid
  ON contacts(ctwa_clid)
  WHERE ctwa_clid IS NOT NULL;
