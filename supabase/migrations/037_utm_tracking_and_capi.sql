-- ============================================================
-- 037_utm_tracking_and_capi
--
-- UTM/source tracking on contacts + conversations so inbound
-- WhatsApp leads carry their ad origin, plus a meta_ads_config
-- table that stores the Pixel ID and Conversions API token
-- needed to fire server-side conversion events back to Meta.
--
-- Idempotent. Safe to run on a fresh DB or an existing one.
-- ============================================================

-- ── UTM columns on contacts ────────────────────────────────
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
  ADD COLUMN IF NOT EXISTS utm_term      TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT;

COMMENT ON COLUMN contacts.utm_source   IS 'Origem do lead (facebook, google, whatsapp, …)';
COMMENT ON COLUMN contacts.utm_campaign IS 'Nome da campanha Meta/Google';
COMMENT ON COLUMN contacts.utm_medium   IS 'Tipo de tráfego (cpc, social, email, …)';
COMMENT ON COLUMN contacts.utm_term     IS 'Palavra-chave do anúncio';
COMMENT ON COLUMN contacts.utm_content  IS 'Identificador do criativo / anúncio';

-- ── UTM columns on conversations ───────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS utm_source    TEXT,
  ADD COLUMN IF NOT EXISTS utm_campaign  TEXT,
  ADD COLUMN IF NOT EXISTS utm_medium    TEXT,
  ADD COLUMN IF NOT EXISTS utm_term      TEXT,
  ADD COLUMN IF NOT EXISTS utm_content   TEXT;

COMMENT ON COLUMN conversations.utm_source   IS 'Origem do lead no contexto desta conversa';
COMMENT ON COLUMN conversations.utm_campaign IS 'Campanha que originou esta conversa';
COMMENT ON COLUMN conversations.utm_medium   IS 'Tipo de tráfego desta conversa';
COMMENT ON COLUMN conversations.utm_term     IS 'Palavra-chave desta conversa';
COMMENT ON COLUMN conversations.utm_content  IS 'Criativo / anúncio desta conversa';

-- ── Meta Ads config ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_ads_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  pixel_id        TEXT,
  access_token    TEXT,
  test_event_code TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  meta_ads_config         IS 'Configuração do Pixel Meta + Conversions API por conta';
COMMENT ON COLUMN meta_ads_config.pixel_id       IS 'Meta Pixel / CAPI pixel_id (ex: 1234567890)';
COMMENT ON COLUMN meta_ads_config.access_token   IS 'Conversions API access token (gerado no Events Manager)';
COMMENT ON COLUMN meta_ads_config.test_event_code IS 'Código de teste para o Meta Events Manager (opcional)';

-- Keep updated_at in sync
CREATE OR REPLACE FUNCTION update_meta_ads_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_meta_ads_config_updated_at ON meta_ads_config;
CREATE TRIGGER trg_meta_ads_config_updated_at
  BEFORE UPDATE ON meta_ads_config
  FOR EACH ROW
  EXECUTE FUNCTION update_meta_ads_config_updated_at();

-- Enable RLS
ALTER TABLE meta_ads_config ENABLE ROW LEVEL SECURITY;

-- Account members can read their own config
CREATE POLICY meta_ads_config_select ON meta_ads_config
  FOR SELECT
  USING (
    account_id IN (
      SELECT account_id FROM account_members
      WHERE user_id = auth.uid()
    )
  );

-- Admin+ can insert/update/delete
CREATE POLICY meta_ads_config_insert ON meta_ads_config
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_id = meta_ads_config.account_id
        AND user_id = auth.uid()
        AND role IN ('admin', 'owner')
    )
  );

CREATE POLICY meta_ads_config_update ON meta_ads_config
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_id = meta_ads_config.account_id
        AND user_id = auth.uid()
        AND role IN ('admin', 'owner')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_id = meta_ads_config.account_id
        AND user_id = auth.uid()
        AND role IN ('admin', 'owner')
    )
  );

CREATE POLICY meta_ads_config_delete ON meta_ads_config
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM account_members
      WHERE account_id = meta_ads_config.account_id
        AND user_id = auth.uid()
        AND role IN ('admin', 'owner')
    )
  );
