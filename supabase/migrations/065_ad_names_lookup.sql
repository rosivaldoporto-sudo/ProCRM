-- ============================================================
-- 065_ad_names_lookup.sql — nomes da campanha, do conjunto e do anúncio
--
-- O problema
--
--   A mensagem que chega de um anúncio Click-to-WhatsApp só traz o ID do
--   anúncio (`referral.source_id`). Os nomes da campanha, do conjunto e do
--   anúncio só existem na API de Marketing da Meta:
--     GET /{ad_id}?fields=name,adset{id,name},campaign{id,name}
--   Essa leitura exige um token com a permissão `ads_read` na conta de
--   anúncios. O token do WhatsApp e o da Conversions API normalmente não
--   têm essa permissão.
--
-- O que muda
--
--   1. meta_ads_config.marketing_access_token: token com ads_read,
--      criptografado pela aplicação como o access_token (mesmas policies:
--      só admin lê a linha).
--   2. contacts.adset_id / contacts.adset_name: o conjunto de anúncios. A
--      campanha e o anúncio já tinham colunas (migration 041).
--   3. meta_ad_lookups: cache dos nomes por (conta, anúncio). Vários leads
--      chegam do mesmo anúncio e a API de Marketing tem limite de chamadas.
--      Guarda também a falha (`error`) para não insistir a cada mensagem
--      quando o token não tem acesso. Só o servidor lê e grava.
--
-- Aplicação
--
--   Colunas nulas sem DEFAULT e uma tabela nova: não reescreve tabelas.
--   Sem esta migration, o CRM continua funcionando e só não busca os
--   nomes (ou não grava o conjunto no contato).
--
-- Idempotente — pode ser executada mais de uma vez.
-- ============================================================

ALTER TABLE public.meta_ads_config
  ADD COLUMN IF NOT EXISTS marketing_access_token TEXT;

COMMENT ON COLUMN public.meta_ads_config.marketing_access_token IS
  'Token com ads_read para ler nomes de campanha, conjunto e anúncio (criptografado pela aplicação)';

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS adset_id   TEXT,
  ADD COLUMN IF NOT EXISTS adset_name TEXT;

COMMENT ON COLUMN public.contacts.adset_id   IS 'ID do conjunto de anúncios CTWA que originou o lead';
COMMENT ON COLUMN public.contacts.adset_name IS 'Nome do conjunto de anúncios (API de Marketing)';

CREATE TABLE IF NOT EXISTS public.meta_ad_lookups (
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  ad_id         TEXT NOT NULL,
  ad_name       TEXT,
  adset_id      TEXT,
  adset_name    TEXT,
  campaign_id   TEXT,
  campaign_name TEXT,
  -- Preenchido quando a Meta recusou a leitura; os nomes ficam nulos.
  error         TEXT,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, ad_id)
);

COMMENT ON TABLE public.meta_ad_lookups IS
  'Cache dos nomes de campanha/conjunto/anúncio lidos na API de Marketing (só servidor)';

ALTER TABLE public.meta_ad_lookups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meta_ad_lookups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.meta_ad_lookups TO service_role;
