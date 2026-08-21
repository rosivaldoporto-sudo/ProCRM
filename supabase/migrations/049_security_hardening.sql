-- ============================================================
-- 049_security_hardening
-- Close RPC privilege escalation paths and repair Meta Ads policies.
-- ============================================================

-- Trigger/service helpers are SECURITY DEFINER and must not inherit
-- PostgreSQL's default EXECUTE grant to PUBLIC. Some installations were
-- upgraded selectively and may not contain every historical helper, so
-- guard each statement with to_regprocedure() to keep this migration
-- idempotent across those databases.
DO $$
BEGIN
  IF to_regprocedure('public.record_webhook_failure(uuid,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.record_webhook_failure(UUID, INT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.record_webhook_failure(UUID, INT)
      TO service_role;
  END IF;

  IF to_regprocedure('public._bcast_bump(uuid,text,integer)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public._bcast_bump(UUID, TEXT, INT)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public._bcast_bump(UUID, TEXT, INT)
      TO service_role;
  END IF;

  IF to_regprocedure('public.recompute_broadcast_counts(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.recompute_broadcast_counts(UUID)
      FROM PUBLIC, anon, authenticated;
    GRANT EXECUTE ON FUNCTION public.recompute_broadcast_counts(UUID)
      TO service_role;
  END IF;

  IF to_regprocedure('public.broadcast_recipient_aggregate_trigger()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.broadcast_recipient_aggregate_trigger()
      FROM PUBLIC, anon, authenticated;
  END IF;

  IF to_regprocedure('public.update_meta_ads_config_updated_at()') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.update_meta_ads_config_updated_at()
      FROM PUBLIC, anon, authenticated;
  END IF;
END
$$;

-- Migration 037 referred to an account_members table that is not part of
-- this schema. The canonical membership source is profiles +
-- is_account_member(). Direct reads are admin-only because access_token is
-- encrypted application data; non-admin clients never need the ciphertext.
DO $$
BEGIN
  IF to_regclass('public.meta_ads_config') IS NOT NULL THEN
    DROP POLICY IF EXISTS meta_ads_config_select ON public.meta_ads_config;
    DROP POLICY IF EXISTS meta_ads_config_insert ON public.meta_ads_config;
    DROP POLICY IF EXISTS meta_ads_config_update ON public.meta_ads_config;
    DROP POLICY IF EXISTS meta_ads_config_delete ON public.meta_ads_config;

    CREATE POLICY meta_ads_config_select ON public.meta_ads_config FOR SELECT
      USING (public.is_account_member(account_id, 'admin'));
    CREATE POLICY meta_ads_config_insert ON public.meta_ads_config FOR INSERT
      WITH CHECK (public.is_account_member(account_id, 'admin'));
    CREATE POLICY meta_ads_config_update ON public.meta_ads_config FOR UPDATE
      USING (public.is_account_member(account_id, 'admin'))
      WITH CHECK (public.is_account_member(account_id, 'admin'));
    CREATE POLICY meta_ads_config_delete ON public.meta_ads_config FOR DELETE
      USING (public.is_account_member(account_id, 'admin'));
  END IF;
END
$$;
