-- ============================================================
-- 061_lead_forms_security.sql — fecha três lacunas das migrations
-- 052 e 055 (formulários e jobs de sincronização).
--
-- 1. increment_lead_form_counter (055) nasceu SECURITY DEFINER, sem
--    search_path e sem REVOKE. Funções novas têm EXECUTE para PUBLIC, então
--    qualquer visitante com a anon key podia chamar
--    POST /rest/v1/rpc/increment_lead_form_counter e inflar os contadores de
--    qualquer formulário. Só o backend (service_role) incrementa contadores.
--
-- 2. As policies de lead_forms, lead_form_blocks, lead_form_bookings,
--    lead_form_responses e uazapi_sync_jobs conferem só "é da conta", sem
--    papel. As rotas exigem `agent` (ou `admin`), mas um `viewer` conseguia
--    alterar e excluir essas linhas direto pelo PostgREST com o próprio JWT.
--    Leitura continua aberta a todo membro; escrita segue o mesmo papel das
--    rotas. Toda escrita legítima do app passa por service_role, que ignora
--    RLS, então nenhum fluxo da aplicação muda.
--
-- 3. Slug público único entre contas. O índice só é criado quando não há
--    duplicatas: havendo, esta migration não falha e avisa quais resolver
--    (a aplicação já impede colisões novas e serve o formulário mais antigo).
--
-- Idempotente: DROP POLICY IF EXISTS / CREATE OR REPLACE.
-- ============================================================

-- ---------- 1. Contador ----------
CREATE OR REPLACE FUNCTION public.increment_lead_form_counter(p_form_id UUID, p_field TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_field = 'view' THEN
    UPDATE lead_forms SET view_count = view_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'response' THEN
    UPDATE lead_forms SET response_count = response_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'qualified' THEN
    UPDATE lead_forms SET qualified_count = qualified_count + 1 WHERE id = p_form_id;
  ELSIF p_field = 'booked' THEN
    UPDATE lead_forms SET booked_count = booked_count + 1 WHERE id = p_form_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_lead_form_counter(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_lead_form_counter(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.increment_lead_form_counter(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_lead_form_counter(UUID, TEXT) TO service_role;

-- ---------- 2. Policies por papel ----------
DROP POLICY IF EXISTS "Users manage own lead forms" ON public.lead_forms;
DROP POLICY IF EXISTS lead_forms_select ON public.lead_forms;
DROP POLICY IF EXISTS lead_forms_insert ON public.lead_forms;
DROP POLICY IF EXISTS lead_forms_update ON public.lead_forms;
DROP POLICY IF EXISTS lead_forms_delete ON public.lead_forms;
CREATE POLICY lead_forms_select ON public.lead_forms FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY lead_forms_insert ON public.lead_forms FOR INSERT
  WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY lead_forms_update ON public.lead_forms FOR UPDATE
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));
CREATE POLICY lead_forms_delete ON public.lead_forms FOR DELETE
  USING (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS "Users manage blocks on their forms" ON public.lead_form_blocks;
DROP POLICY IF EXISTS lead_form_blocks_select ON public.lead_form_blocks;
DROP POLICY IF EXISTS lead_form_blocks_modify ON public.lead_form_blocks;
CREATE POLICY lead_form_blocks_select ON public.lead_form_blocks FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.lead_forms f
    WHERE f.id = lead_form_blocks.form_id
      AND public.is_account_member(f.account_id)
  ));
CREATE POLICY lead_form_blocks_modify ON public.lead_form_blocks FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.lead_forms f
    WHERE f.id = lead_form_blocks.form_id
      AND public.is_account_member(f.account_id, 'agent')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.lead_forms f
    WHERE f.id = lead_form_blocks.form_id
      AND public.is_account_member(f.account_id, 'agent')
  ));

DROP POLICY IF EXISTS "Users see own form responses" ON public.lead_form_responses;
DROP POLICY IF EXISTS "Users delete own form responses" ON public.lead_form_responses;
DROP POLICY IF EXISTS lead_form_responses_select ON public.lead_form_responses;
DROP POLICY IF EXISTS lead_form_responses_delete ON public.lead_form_responses;
CREATE POLICY lead_form_responses_select ON public.lead_form_responses FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY lead_form_responses_delete ON public.lead_form_responses FOR DELETE
  USING (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS "Users see own form bookings" ON public.lead_form_bookings;
DROP POLICY IF EXISTS lead_form_bookings_select ON public.lead_form_bookings;
DROP POLICY IF EXISTS lead_form_bookings_modify ON public.lead_form_bookings;
CREATE POLICY lead_form_bookings_select ON public.lead_form_bookings FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY lead_form_bookings_modify ON public.lead_form_bookings FOR ALL
  USING (public.is_account_member(account_id, 'agent'))
  WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS "Users can manage own sync jobs" ON public.uazapi_sync_jobs;
DROP POLICY IF EXISTS uazapi_sync_jobs_select ON public.uazapi_sync_jobs;
DROP POLICY IF EXISTS uazapi_sync_jobs_modify ON public.uazapi_sync_jobs;
CREATE POLICY uazapi_sync_jobs_select ON public.uazapi_sync_jobs FOR SELECT
  USING (public.is_account_member(account_id));
CREATE POLICY uazapi_sync_jobs_modify ON public.uazapi_sync_jobs FOR ALL
  USING (public.is_account_member(account_id, 'admin'))
  WITH CHECK (public.is_account_member(account_id, 'admin'));

-- ---------- 3. Slug público único ----------
DO $$
DECLARE
  duplicated TEXT;
BEGIN
  SELECT string_agg(slug, ', ') INTO duplicated
  FROM (SELECT slug FROM public.lead_forms GROUP BY slug HAVING count(*) > 1) d;

  IF duplicated IS NULL THEN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_lead_forms_slug_unique
      ON public.lead_forms (slug);
  ELSE
    RAISE WARNING 'lead_forms: índice único de slug não criado; resolva as duplicatas: %', duplicated;
  END IF;
END
$$;
