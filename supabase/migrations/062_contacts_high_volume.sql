-- ============================================================
-- 062_contacts_high_volume.sql — tela de contatos com muitos contatos
--
-- O problema
--
--   As policies de leitura chamam is_account_member() uma vez por linha.
--   Listar ou contar uma conta grande executa essa função milhares de vezes,
--   e o filtro por etiqueta ainda a executa de novo para cada vínculo em
--   contact_tags. A migration 056 somou um LEFT JOIN + DISTINCT que impede o
--   banco de partir da etiqueta.
--
-- O que muda
--
--   1. current_account_ids(): as contas do usuário, lidas uma vez por consulta.
--      `= ANY (ARRAY(SELECT ...))` vira um parâmetro único, e não uma chamada
--      por linha, além de poder usar o índice de account_id.
--   2. contacts_select e contact_tags_select passam a usar essa função. O
--      critério é o mesmo: is_account_member(id) sem papel mínimo significa
--      "existe um perfil meu nesta conta", qualquer que seja o papel.
--   3. contact_tags_modify (FOR ALL) vira policies de INSERT, UPDATE e DELETE,
--      com o mesmo critério de antes. FOR ALL também valia para SELECT e, por
--      ordem alfabética, rodava antes de contact_tags_select em toda leitura.
--   4. filter_contacts_by_tags: mesma assinatura e mesmo resultado, com EXISTS
--      no lugar de LEFT JOIN + DISTINCT e escopo explícito de conta.
--   5. Índices para a ordem da lista e para partir da etiqueta.
--
-- Segurança
--
--   Só a forma de calcular muda. Quem podia ler continua podendo, escrever
--   continua exigindo o papel de agente, e o RPC segue SECURITY INVOKER.
--   current_account_ids() é SECURITY DEFINER como is_account_member(), porque
--   precisa ler profiles, e só devolve as contas do próprio auth.uid().
--
-- Aplicação
--
--   CREATE INDEX trava gravações em contacts e contact_tags durante a criação.
--   Rode num horário calmo se essas tabelas forem muito grandes.
--
-- Idempotente — pode ser executada mais de uma vez.
-- ============================================================

BEGIN;

-- ---- índices ----------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_contacts_account_created
  ON public.contacts (account_id, created_at DESC, id);

-- Substitui idx_contact_tags_tag, que é o prefixo deste índice.
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag_contact
  ON public.contact_tags (tag_id, contact_id);
DROP INDEX IF EXISTS public.idx_contact_tags_tag;

-- ---- contas do usuário ------------------------------------------
CREATE OR REPLACE FUNCTION public.current_account_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.account_id
  FROM profiles p
  WHERE p.user_id = auth.uid()
    AND p.account_id IS NOT NULL;
$$;

ALTER FUNCTION public.current_account_ids() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_account_ids() FROM PUBLIC;
-- anon também: sem isto, uma leitura sem sessão daria erro de permissão em vez
-- de voltar vazia. Sem sessão, auth.uid() é nulo e a função não devolve nada.
GRANT EXECUTE ON FUNCTION public.current_account_ids() TO anon, authenticated, service_role;

-- ---- policies ---------------------------------------------------
DROP POLICY IF EXISTS contacts_select ON public.contacts;
CREATE POLICY contacts_select ON public.contacts FOR SELECT USING (
  account_id = ANY (ARRAY(SELECT public.current_account_ids()))
);

DROP POLICY IF EXISTS contact_tags_select ON public.contact_tags;
CREATE POLICY contact_tags_select ON public.contact_tags FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.id = contact_tags.contact_id
      AND c.account_id = ANY (ARRAY(SELECT public.current_account_ids()))
  )
);

DROP POLICY IF EXISTS contact_tags_modify ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_insert ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_update ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_delete ON public.contact_tags;
CREATE POLICY contact_tags_insert ON public.contact_tags FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_tags.contact_id AND public.is_account_member(c.account_id, 'agent'))
);
CREATE POLICY contact_tags_update ON public.contact_tags FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_tags.contact_id AND public.is_account_member(c.account_id, 'agent'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_tags.contact_id AND public.is_account_member(c.account_id, 'agent'))
);
CREATE POLICY contact_tags_delete ON public.contact_tags FOR DELETE USING (
  EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = contact_tags.contact_id AND public.is_account_member(c.account_id, 'agent'))
);

-- ---- filtro da tela ---------------------------------------------
CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0,
  p_source TEXT DEFAULT NULL
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    -- EXISTS não multiplica o contato pelas etiquetas, então dispensa DISTINCT.
    SELECT c.id, c.created_at
    FROM contacts c
    WHERE c.account_id = ANY (ARRAY(SELECT public.current_account_ids()))
      AND (
        p_tag_ids IS NULL
        OR cardinality(p_tag_ids) = 0
        OR EXISTS (
          SELECT 1 FROM contact_tags ct
          WHERE ct.contact_id = c.id
            AND ct.tag_id = ANY(p_tag_ids)
        )
      )
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
      AND (
        p_source IS NULL
        OR EXISTS (
          SELECT 1 FROM conversations conv
          WHERE conv.contact_id = c.id
            AND (
              conv.source = p_source
              OR EXISTS (
                SELECT 1 FROM messages m
                WHERE m.conversation_id = conv.id
                  AND m.source = p_source
              )
            )
        )
      )
  ),
  page AS (
    -- count(*) OVER() é avaliado antes do LIMIT: total cheio
    -- independente da página retornada.
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

COMMIT;
