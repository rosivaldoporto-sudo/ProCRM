-- Adiciona coluna `source` à tabela conversations para rastrear
-- de qual canal (whatsapp / uazapi) a conversa se originou.
-- Permite filtrar conversas por canal no inbox.

ALTER TABLE conversations ADD COLUMN source TEXT CHECK (source IN ('whatsapp', 'uazapi'));

-- Backfill: define source com base na primeira mensagem de cada conversa
UPDATE conversations c SET source = sub.source
FROM (
  SELECT DISTINCT ON (conversation_id) conversation_id, source
  FROM messages
  WHERE source IS NOT NULL
  ORDER BY conversation_id, created_at ASC
) sub
WHERE c.id = sub.conversation_id;
