-- ============================================================
-- 066_storage_listing_lockdown
--
-- Fecha a listagem pública dos buckets de mídia e alinha a escrita ao
-- papel exigido pelas rotas.
--
-- 1. LISTAGEM ABERTA (o problema principal)
--    Os buckets `chat-media`, `flow-media` e `avatars` são públicos de
--    propósito: a Meta e o navegador precisam baixar a mídia por URL sem
--    cabeçalho de autenticação. Só que as migrations 008, 016 e 023 também
--    criaram policies de SELECT em storage.objects com `USING (bucket_id =
--    '...')`, sem papel e sem conta. Uma policy de SELECT assim não serve
--    para baixar por URL pública (bucket público dispensa RLS no download);
--    o que ela libera é a API de LISTAGEM. Com a anon key — que vai no
--    JavaScript do site — qualquer pessoa podia chamar
--    POST /storage/v1/object/list/chat-media e enumerar as pastas e os
--    arquivos de TODAS as contas: fotos, áudios e documentos trocados com
--    clientes. Os nomes aleatórios dos arquivos, única proteção das URLs,
--    ficavam expostos.
--
--    Aqui o SELECT passa a valer só para usuário autenticado e só na pasta
--    da própria conta (ou do próprio usuário, no caso do avatar). Baixar
--    por URL pública continua funcionando igual: nada muda para a Meta,
--    para o inbox, para os fluxos ou para as fotos de perfil.
--
-- 2. ESCRITA POR PAPEL
--    Upload, alteração e exclusão em `chat-media` e `flow-media` conferiam
--    só "é da conta". Um `viewer` (somente leitura) conseguia subir e apagar
--    mídia direto pela API de Storage com o próprio JWT. Passa a exigir
--    `agent` ou acima, o mesmo papel das rotas de envio e dos fluxos.
--
-- 3. ÍNDICE do contador de não lidas (ver src/hooks/use-total-unread.ts).
--
-- O app usa apenas upload, getPublicUrl e remove; nenhuma tela lista
-- arquivos. Uploads do servidor (mídia recebida pelos webhooks) usam
-- service_role, que ignora RLS.
--
-- Idempotente: DROP POLICY IF EXISTS antes de cada CREATE.
-- ============================================================

-- ---------- 1. Fim da listagem pública ----------
DROP POLICY IF EXISTS "Chat media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Flow media is publicly readable" ON storage.objects;
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;

DROP POLICY IF EXISTS "Members can read chat media" ON storage.objects;
CREATE POLICY "Members can read chat media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can read flow media" ON storage.objects;
CREATE POLICY "Members can read flow media"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND (
      EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = auth.uid()
          AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
      )
      -- Caminho antigo (pré-020): pasta com o id de quem enviou.
      OR auth.uid()::text = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Users can read their own avatar" ON storage.objects;
CREATE POLICY "Users can read their own avatar"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'avatars'
    AND auth.uid()::text = (storage.foldername(name))[1]
  );

-- ---------- 2. Escrita exige agent ou acima ----------
DROP POLICY IF EXISTS "Members can upload chat media" ON storage.objects;
CREATE POLICY "Members can upload chat media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can update chat media" ON storage.objects;
CREATE POLICY "Members can update chat media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  )
  WITH CHECK (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can delete chat media" ON storage.objects;
CREATE POLICY "Members can delete chat media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'chat-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
    )
  );

DROP POLICY IF EXISTS "Members can upload flow media" ON storage.objects;
CREATE POLICY "Members can upload flow media"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR p.user_id::text = (storage.foldername(name))[1]
        )
    )
  );

DROP POLICY IF EXISTS "Members can update flow media" ON storage.objects;
CREATE POLICY "Members can update flow media"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR p.user_id::text = (storage.foldername(name))[1]
        )
    )
  )
  WITH CHECK (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR p.user_id::text = (storage.foldername(name))[1]
        )
    )
  );

DROP POLICY IF EXISTS "Members can delete flow media" ON storage.objects;
CREATE POLICY "Members can delete flow media"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'flow-media'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND p.account_role IN ('owner', 'admin', 'agent')
        AND (
          ('account-' || p.account_id::text) = (storage.foldername(name))[1]
          OR p.user_id::text = (storage.foldername(name))[1]
        )
    )
  );

-- ---------- 3. Contador de conversas não lidas ----------
-- A barra lateral busca só as conversas com unread_count > 0. O índice
-- parcial fica pequeno (a maioria das conversas está lida) e evita varrer
-- a tabela inteira da conta em toda página do painel.
CREATE INDEX IF NOT EXISTS idx_conversations_unread
  ON public.conversations (account_id)
  WHERE unread_count > 0;
