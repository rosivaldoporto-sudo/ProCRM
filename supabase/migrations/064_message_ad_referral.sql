-- ============================================================
-- 064_message_ad_referral.sql — anúncio que originou a mensagem
--
-- Quem clica num anúncio Click-to-WhatsApp (ou numa publicação
-- impulsionada) chega com uma mensagem que traz os dados do anúncio:
-- link, título, texto, miniatura e o ctwa_clid. A Cloud API manda isso no
-- objeto `referral` da mensagem; a Uazapi, em
-- `contextInfo.externalAdReply`. Até aqui só o ctwa_clid e o ID do anúncio
-- iam para `contacts` (migration 041), e o inbox não tinha como mostrar
-- de qual anúncio a conversa veio.
--
-- O que muda
--
--   messages.referral (jsonb, opcional): o anúncio no formato da Cloud API
--   (source_url, source_id, source_type, headline, body, media_type,
--   image_url, video_url, thumbnail_url, ctwa_clid). Gravado pelos
--   webhooks só nas mensagens que vieram de um anúncio; nas demais fica
--   NULL. O inbox mostra um cartão com link para o anúncio acima da
--   mensagem.
--
-- Segurança
--
--   O conteúdo vem da Meta / do WhatsApp e é tratado como não confiável:
--   os webhooks guardam só texto com tamanho limitado e URLs `https:`, e o
--   inbox confere a URL de novo antes de usar. As policies de `messages`
--   não mudam.
--
-- Aplicação
--
--   Coluna nula sem DEFAULT: só altera o catálogo, sem reescrever a
--   tabela. Mensagens antigas não ganham o anúncio (o dado nunca foi
--   guardado). Até esta migration rodar, os webhooks gravam a mensagem
--   sem o anúncio.
--
-- Idempotente — pode ser executada mais de uma vez.
-- ============================================================

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS referral JSONB;

COMMENT ON COLUMN public.messages.referral IS
  'Anúncio Click-to-WhatsApp que originou a mensagem (formato do referral da Cloud API). NULL nas demais mensagens.';
