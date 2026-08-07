-- ============================================================
-- 043_deals_currency_brl
--
-- 042 changed accounts.default_currency, but deals are created with
-- the static deals.currency column default (from 001) — still 'USD',
-- so every deal insert that omits currency (quick-add, inbox shortcut,
-- lead auto-create) silently landed in USD.
--
-- Fixes the column default for new deals and migrates existing deals
-- that were never customized (still on the old USD default) to BRL,
-- keeping the one-currency-per-account rule. Idempotent.
-- ============================================================

ALTER TABLE deals
  ALTER COLUMN currency SET DEFAULT 'BRL';

UPDATE deals
  SET currency = 'BRL'
  WHERE currency = 'USD';
