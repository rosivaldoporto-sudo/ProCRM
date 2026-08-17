-- ============================================================
-- Uazapi: admin token + optional phone for pairing code.
--
-- The UAZAPI v2 API (docs.uazapi.com) separates credentials:
--   - `token`       → instance-level token (sending, connect,
--                     status, webhooks) — stored in api_token.
--   - `admintoken`  → account-level token that can CREATE
--                     instances (POST /instance/init) and manage
--                     all of them (GET /instance/all, ...).
--
-- With an admin token the CRM can bootstrap the whole flow:
-- create the instance if missing, then connect and show the QR
-- code. Without it, the user pastes an existing instance token
-- and the connect step only needs the QR.
--
-- `pairing_phone` is an optional phone number that makes
-- /instance/connect return a 6-digit pairing code instead of a
-- QR (UAZAPI v2 supports both; if omitted, QR is returned).
-- ============================================================

ALTER TABLE uazapi_config
  ADD COLUMN IF NOT EXISTS admin_token TEXT,
  ADD COLUMN IF NOT EXISTS pairing_phone TEXT;