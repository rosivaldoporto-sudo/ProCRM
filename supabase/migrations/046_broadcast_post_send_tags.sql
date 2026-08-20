-- ============================================================
-- 046_broadcast_post_send_tags.sql — tag contacts after dispatch
--
-- Broadcasts can optionally carry tags that are applied to each
-- contact once its message has been sent ("marcar contatos após o
-- disparo"). Stored as an array of tag ids on the broadcast row so
-- the wizard round-trips them into drafts and analytics.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS post_send_tag_ids UUID[] NOT NULL DEFAULT '{}';