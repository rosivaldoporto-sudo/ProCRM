-- ============================================================
-- 042_brl_default_currency
--
-- Default account/deal currency becomes BRL (Brazilian Real) for
-- new accounts, and existing accounts that never customized their
-- currency (still the old USD default) are migrated in place.
-- Idempotent.
-- ============================================================

ALTER TABLE accounts
  ALTER COLUMN default_currency SET DEFAULT 'BRL';

UPDATE accounts
  SET default_currency = 'BRL'
  WHERE default_currency = 'USD';
