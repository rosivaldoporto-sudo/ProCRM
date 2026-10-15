-- ============================================================
-- 056_filter_contacts_by_channel.sql — filtro de canal nos contatos
--
-- Estende `filter_contacts_by_tags` com `p_source` ('whatsapp' =
-- API oficial / 'uazapi', NULL = todos os canais) para a tela de
-- Contatos filtrar por canal, no mesmo critério do inbox
-- (conversations.source OU alguma messages.source do canal —
-- cobre conversas mistas com source NULL e linhas legadas).
--
-- A lista de tags passa a ser opcional: p_tag_ids NULL ou vazio
-- desliga o filtro de tags, então a mesma função atende os dois
-- caminhos do cliente (só canal, só tags, ou ambos), com join +
-- distinct + total + LIMIT/OFFSET em uma única query.
--
-- SECURITY INVOKER (padrão): RLS de contacts/contact_tags/
-- conversations/messages continua valendo — sem bypass.
-- ============================================================

DROP FUNCTION IF EXISTS public.filter_contacts_by_tags(UUID[], TEXT, INT, INT);

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
    -- Contatos distintos com QUALQUER das tags (OR) quando o filtro
    -- de tags está ativo, estreitados pela mesma busca
    -- nome/telefone/e-mail da lista — e pelo canal quando pedido.
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    LEFT JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE (p_tag_ids IS NULL OR cardinality(p_tag_ids) = 0 OR ct.tag_id = ANY(p_tag_ids))
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

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT, TEXT) TO authenticated;
