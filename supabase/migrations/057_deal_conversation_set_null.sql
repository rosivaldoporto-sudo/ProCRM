-- ============================================================
-- 057_deal_conversation_set_null.sql — allow contact/conversation
-- deletion without wiping deals.
--
-- deals.conversation_id was declared REFERENCES conversations(id)
-- with no ON DELETE action (Postgres defaults to NO ACTION). The
-- delete chain contacts →(CASCADE)→ conversations then fails with
-- 23503 (PostgREST 409) whenever any conversation is linked to a
-- deal — aborting even bulk deletes outright.
--
-- CASCADE is the wrong fix (it would silently wipe deal rows).
-- SET NULL mirrors migration 004 (contact_id on deals +
-- broadcast_recipients): the deal survives, unlinked from the
-- deleted conversation. The UI already treats missing relations
-- as null-safe.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'deals'::regclass
      AND confrelid = 'conversations'::regclass
      AND contype = 'f'
  LOOP
    EXECUTE 'ALTER TABLE deals DROP CONSTRAINT ' || quote_ident(r.conname);
  END LOOP;
END $$;

ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE SET NULL;
