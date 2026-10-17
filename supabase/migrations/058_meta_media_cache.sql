-- ============================================================
-- 058_meta_media_cache.sql — cache of Meta media ids for outbound
-- media-header template sends.
--
-- Sending a template whose header is image/video/document by public
-- `link` makes Meta download the file from our storage on EVERY
-- send. A 15-recipient video campaign therefore consumed
-- file_size × N of Storage egress. Meta's documented alternative is
-- to upload the file once (POST /{phone_number_id}/media) and then
-- reference `{ header: { id } }` on every send — no per-recipient
-- download from our storage.
--
-- This table memoizes source_url → Meta media_id, scoped per phone
-- number (media ids belong to the uploading phone number / WABA).
-- Meta media ids expire after 30 days, so rows carry `expires_at`
-- (~25 days) and the resolver re-uploads once a row is stale.
--
-- Server-only: read/written exclusively with the service-role
-- client during broadcast fan-out, so RLS is enabled with no client
-- policies and direct privileges are revoked below (same pattern as
-- 050_distributed_rate_limits).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meta_media_cache (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  phone_number_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  media_id TEXT NOT NULL,
  mime_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- One cached id per source file per sending number; the resolver
  -- upserts on this pair when a cached id has expired.
  UNIQUE (phone_number_id, source_url)
);

ALTER TABLE public.meta_media_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.meta_media_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.meta_media_cache TO service_role;

-- The UNIQUE constraint backs the exact-match lookup; this extra
-- index covers account-scoped maintenance (e.g. purging expired rows).
CREATE INDEX IF NOT EXISTS idx_meta_media_cache_account
  ON public.meta_media_cache(account_id, expires_at DESC);
