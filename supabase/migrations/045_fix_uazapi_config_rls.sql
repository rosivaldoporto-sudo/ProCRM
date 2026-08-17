-- ============================================================
-- Fix RLS on uazapi_config: allow INSERT via upsert.
--
-- The original policy (039) was `FOR ALL ... USING (...)` with NO
-- WITH CHECK clause. In Postgres, INSERT is only governed by
-- WITH CHECK — so with a user-scoped client, upserting a brand-new
-- row silently failed (RLS denied the insert). The status/QR state
-- was never persisted, and the send route kept answering
-- "Uazapi instance is not connected" even after a successful scan.
--
-- Credentials are env-based now; the table is only a per-account
-- runtime-state cache (status, qr_code, connected_at, auto-created
-- instance token), and routes upsert it with the user's own session.
-- ============================================================

DROP POLICY IF EXISTS "Users can manage own uazapi config" ON uazapi_config;
CREATE POLICY "Users can manage own uazapi config" ON uazapi_config
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.account_id = uazapi_config.account_id
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.account_id = uazapi_config.account_id
    )
  );