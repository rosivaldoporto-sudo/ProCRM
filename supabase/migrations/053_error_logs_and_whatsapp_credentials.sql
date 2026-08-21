-- 053_error_logs_and_whatsapp_credentials
-- Restrict integration credentials to settings administrators and persist
-- sanitized, tenant-scoped production errors for troubleshooting.

DO $$
BEGIN
  IF to_regclass('public.whatsapp_config') IS NOT NULL THEN
    EXECUTE 'DROP POLICY IF EXISTS whatsapp_config_select ON public.whatsapp_config';
    EXECUTE 'CREATE POLICY whatsapp_config_select ON public.whatsapp_config FOR SELECT USING (public.is_account_member(account_id, ''admin''))';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.application_error_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id UUID REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  route TEXT,
  method TEXT,
  error_name TEXT,
  message TEXT NOT NULL,
  stack TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_application_error_logs_account_time
  ON public.application_error_logs (account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_application_error_logs_request
  ON public.application_error_logs (request_id);

ALTER TABLE public.application_error_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS application_error_logs_select ON public.application_error_logs;
CREATE POLICY application_error_logs_select
  ON public.application_error_logs FOR SELECT
  USING (public.is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS application_error_logs_delete ON public.application_error_logs;
CREATE POLICY application_error_logs_delete
  ON public.application_error_logs FOR DELETE
  USING (public.is_account_member(account_id, 'owner'));

REVOKE ALL ON TABLE public.application_error_logs FROM anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.application_error_logs TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE public.application_error_logs TO service_role;

