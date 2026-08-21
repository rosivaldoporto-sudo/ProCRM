-- 051_browser_data_hardening
-- Keep credential rows and teammate email addresses out of browser clients.
-- Optional tables are guarded for installations with partial migration history.

DO $$
BEGIN
  IF to_regclass('public.uazapi_config') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage own uazapi config" ON public.uazapi_config';
    EXECUTE 'DROP POLICY IF EXISTS uazapi_config_select ON public.uazapi_config';
    EXECUTE 'DROP POLICY IF EXISTS uazapi_config_insert ON public.uazapi_config';
    EXECUTE 'DROP POLICY IF EXISTS uazapi_config_update ON public.uazapi_config';
    EXECUTE 'DROP POLICY IF EXISTS uazapi_config_delete ON public.uazapi_config';
    EXECUTE 'CREATE POLICY uazapi_config_select ON public.uazapi_config FOR SELECT USING (public.is_account_member(account_id, ''admin''))';
    EXECUTE 'CREATE POLICY uazapi_config_insert ON public.uazapi_config FOR INSERT WITH CHECK (public.is_account_member(account_id, ''admin''))';
    EXECUTE 'CREATE POLICY uazapi_config_update ON public.uazapi_config FOR UPDATE USING (public.is_account_member(account_id, ''admin'')) WITH CHECK (public.is_account_member(account_id, ''admin''))';
    EXECUTE 'CREATE POLICY uazapi_config_delete ON public.uazapi_config FOR DELETE USING (public.is_account_member(account_id, ''admin''))';
  END IF;

  IF to_regclass('public.api_keys') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS api_keys_select ON public.api_keys';
    EXECUTE 'CREATE POLICY api_keys_select ON public.api_keys FOR SELECT USING (public.is_account_member(account_id, ''admin''))';
  END IF;

  IF to_regclass('public.webhook_endpoints') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS webhook_endpoints_select ON public.webhook_endpoints';
    EXECUTE 'CREATE POLICY webhook_endpoints_select ON public.webhook_endpoints FOR SELECT USING (public.is_account_member(account_id, ''admin''))';
  END IF;

  IF to_regclass('public.ai_configs') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS ai_configs_select ON public.ai_configs';
    EXECUTE 'CREATE POLICY ai_configs_select ON public.ai_configs FOR SELECT USING (public.is_account_member(account_id, ''admin''))';
  END IF;
END
$$;

-- RLS filters rows, not columns. Explicitly remove email from the columns that
-- authenticated browser sessions may select. The admin-only members API uses
-- the service role and returns email only when the caller is admin/owner.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    REVOKE SELECT ON TABLE public.profiles FROM authenticated;
    GRANT SELECT (
      id, user_id, full_name, avatar_url, role, beta_features,
      account_id, account_role, created_at, updated_at
    ) ON TABLE public.profiles TO authenticated;
  END IF;
END
$$;
