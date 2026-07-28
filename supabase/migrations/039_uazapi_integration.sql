-- ============================================================
-- Uazapi WhatsApp channel integration (non-official WhatsApp
-- channel running in parallel with Meta WhatsApp Cloud API).
--
-- Creates the uazapi_config table for storing instance
-- credentials and adds a `source` column to messages to
-- distinguish which channel produced each message.
-- ============================================================

-- -----------------------------------------------------------
-- UAZAPI_CONFIG
-- -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS uazapi_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instance_name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  api_token TEXT NOT NULL,
  webhook_secret TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'qrcode')),
  qr_code TEXT,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(account_id)
);

ALTER TABLE uazapi_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own uazapi config" ON uazapi_config;
CREATE POLICY "Users can manage own uazapi config" ON uazapi_config
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.account_id = uazapi_config.account_id
    )
  );

-- -----------------------------------------------------------
-- Add `source` column to messages so we can distinguish
-- between Meta WhatsApp (default) and Uazapi messages.
-- -----------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (source IN ('whatsapp', 'uazapi'));

-- Index for efficient querying by source
CREATE INDEX IF NOT EXISTS idx_messages_source ON messages(source);
