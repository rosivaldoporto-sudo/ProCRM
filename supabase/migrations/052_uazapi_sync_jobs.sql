-- ============================================================
-- UAZAPI_SYNC_JOBS
-- Background sync job tracking for large-volume UAZAPI syncs.
-- ============================================================

CREATE TABLE IF NOT EXISTS uazapi_sync_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
  total_chats INTEGER NOT NULL DEFAULT 0,
  synced_chats INTEGER NOT NULL DEFAULT 0,
  imported_messages INTEGER NOT NULL DEFAULT 0,
  current_chat TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE uazapi_sync_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own sync jobs" ON uazapi_sync_jobs;
CREATE POLICY "Users can manage own sync jobs" ON uazapi_sync_jobs
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.account_id = uazapi_sync_jobs.account_id
    )
  );

-- Index for efficient querying by account
CREATE INDEX IF NOT EXISTS idx_uazapi_sync_jobs_account ON uazapi_sync_jobs(account_id, created_at DESC);

-- Trigger to auto-update updated_at
DROP TRIGGER IF EXISTS update_uazapi_sync_jobs_updated_at ON uazapi_sync_jobs;
CREATE TRIGGER update_uazapi_sync_jobs_updated_at
  BEFORE UPDATE ON uazapi_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();