-- ============================================================
-- 048_inbox_last_message_sender.sql — "customer replied last"
-- inbox filter support.
--
-- The inbox needs to filter conversations where the customer was
-- the last to send a message (awaiting agent reply). The
-- `conversations` row only tracks last_message_text/at, not who
-- sent it, and touching every write site that bumps those columns
-- would be fragile. Instead we expose a security-invoker view that
-- computes the sender type of each conversation's most recent
-- message on the fly:
--
--   inbox_conversations = conversations + last_message_sender_type
--
-- security_invoker keeps the underlying tables' RLS policies in
-- force, so users only see their own rows exactly as before.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- Fastest path for "most recent message per conversation".
CREATE INDEX IF NOT EXISTS idx_messages_conversation_last
  ON messages (conversation_id, created_at DESC, id DESC);

CREATE OR REPLACE VIEW inbox_conversations
WITH (security_invoker = true) AS
SELECT c.*,
  (SELECT m.sender_type
     FROM messages m
    WHERE m.conversation_id = c.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1) AS last_message_sender_type
FROM conversations c;