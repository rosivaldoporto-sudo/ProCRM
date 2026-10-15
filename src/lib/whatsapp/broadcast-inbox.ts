import type { SupabaseClient } from '@supabase/supabase-js';

import { findExistingContact } from '@/lib/contacts/dedupe';

interface PersistBroadcastMessageInput {
  accountId: string;
  phone: string;
  renderedBody: string;
  templateName: string;
  whatsappMessageId: string;
}

/**
 * Persiste a mensagem do broadcast no inbox APENAS se já existir uma
 * conversa para o contato.
 *
 * Transmissões em massa não criam conversas: a conversa do inbox nasce
 * na resposta do cliente (webhook inbound faz find-or-create). Se o
 * número já tem conversa aberta, a mensagem do template aparece na
 * thread existente; caso contrário, só o envio Meta + o carimbo em
 * `broadcast_recipients` acontecem.
 *
 * Retorna true quando persistiu, false quando não havia conversa
 * (nada a fazer — não é erro).
 */
export async function persistBroadcastMessageIfConversationExists(
  db: SupabaseClient,
  input: PersistBroadcastMessageInput
): Promise<boolean> {
  const { accountId, phone, renderedBody, templateName, whatsappMessageId } =
    input;

  const existing = await findExistingContact(db, accountId, phone);
  if (!existing) return false;

  const { data: convs, error: findErr } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', existing.id)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findErr) throw findErr;
  const conversationId = convs?.[0]?.id as string | undefined;
  if (!conversationId) return false;

  await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'agent',
    content_type: 'template',
    content_text: renderedBody,
    template_name: templateName,
    message_id: whatsappMessageId,
    status: 'sent',
    created_at: new Date().toISOString(),
  });
  await db
    .from('conversations')
    .update({
      last_message_text: renderedBody,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  return true;
}
