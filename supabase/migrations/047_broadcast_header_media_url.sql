-- ============================================================
-- 047_broadcast_header_media_url.sql — persist the send-time media
--
-- Media-header templates (image/video/document) need a URL at send
-- time. The wizard can upload media that is NOT the template's stored
-- URL (template.header_media_url) — e.g. a per-campaign creative
-- uploaded to the chat-media bucket. Persisting it here lets the
-- "Resume sending" button reuse the exact same media when it finishes
-- a broadcast whose run was cut short.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;