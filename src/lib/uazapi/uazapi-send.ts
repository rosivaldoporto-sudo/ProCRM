import type { SupabaseClient } from '@supabase/supabase-js';
import {
  sendTextMessage,
  sendMediaMessage,
  sendMenu,
  type MediaKind,
} from '@/lib/uazapi/uazapi-client';
import {
  uazapiEnvConfig,
  getCachedInstanceToken,
} from '@/lib/uazapi/runtime-config';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';

export const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const;
export const VALID_MESSAGE_TYPES = ['text', ...MEDIA_KINDS, 'menu'] as const;

export class UazapiSendError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'UazapiSendError';
    this.code = code;
    this.status = status;
  }
}

export interface UazapiSendParams {
  conversationId: string;
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  filename?: string | null;
  menuRows?: Array<{ id: string; title: string; description?: string }> | null;
  menuTitle?: string | null;
  menuFooter?: string | null;
  replyToMessageId?: string | null;
}

export interface UazapiSendResult {
  messageId: string;
  uazapiMessageId: string;
}

export function validateUazapiSendParams(params: {
  messageType: string;
  contentText?: string | null;
  mediaUrl?: string | null;
  menuRows?: Array<{ id: string; title: string; description?: string }> | null;
}): void {
  const { messageType, contentText, mediaUrl, menuRows } = params;

  if (!messageType) {
    throw new UazapiSendError('bad_request', 'message_type is required', 400);
  }

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(messageType)) {
    throw new UazapiSendError(
      'bad_request',
      `Unsupported message_type "${messageType}"`,
      400
    );
  }

  if (messageType === 'text' && !contentText) {
    throw new UazapiSendError(
      'bad_request',
      'content_text is required for text messages',
      400
    );
  }

  if (isMediaKind && !mediaUrl) {
    throw new UazapiSendError(
      'bad_request',
      `media_url is required for ${messageType} messages`,
      400
    );
  }

  if (messageType === 'menu' && (!menuRows || menuRows.length === 0)) {
    throw new UazapiSendError(
      'bad_request',
      'menu_rows is required for menu messages',
      400
    );
  }

  if (isMediaKind && messageType !== 'audio' && typeof contentText === 'string' && contentText.length > 1024) {
    throw new UazapiSendError(
      'bad_request',
      'Caption exceeds the 1024-character limit',
      400
    );
  }
}

export async function sendMessageToConversation(
  db: SupabaseClient,
  accountId: string,
  params: UazapiSendParams
): Promise<UazapiSendResult> {
  const {
    conversationId,
    messageType,
    contentText,
    mediaUrl,
    filename,
    menuRows,
    menuTitle,
    menuFooter,
    replyToMessageId,
  } = params;

  if (!conversationId) {
    throw new UazapiSendError('bad_request', 'conversation_id is required', 400);
  }

  validateUazapiSendParams({ messageType, contentText, mediaUrl, menuRows });

  const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(messageType);

  // Load conversation + contact
  const { data: conversation, error: convError } = await db
    .from('conversations')
    .select('*, contact:contacts(*)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .single();

  if (convError || !conversation) {
    throw new UazapiSendError('not_found', 'Conversation not found', 404);
  }

  const contact = conversation.contact;
  if (!contact?.phone) {
    throw new UazapiSendError('bad_request', 'Contact phone number not found', 400);
  }

  const sanitizedPhone = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitizedPhone)) {
    throw new UazapiSendError('bad_request', 'Invalid phone number format', 400);
  }

  // Uazapi credentials come from the environment; the config row only
  // caches runtime state (status, pending QR, auto-created token).
  const env = uazapiEnvConfig();
  if (!env.serverUrl) {
    throw new UazapiSendError(
      'uazapi_not_configured',
      'Uazapi is not configured. Set UAZAPI_SERVER_URL in the environment.',
      400
    );
  }

  const { data: stateRow } = await db
    .from('uazapi_config')
    .select('status')
    .eq('account_id', accountId)
    .maybeSingle();

  if (!stateRow || stateRow.status !== 'connected') {
    throw new UazapiSendError(
      'uazapi_not_connected',
      'Uazapi instance is not connected. Please scan the QR code first.',
      400
    );
  }

  const apiToken = await getCachedInstanceToken(db, accountId);
  if (!apiToken) {
    throw new UazapiSendError(
      'uazapi_not_configured',
      'Uazapi instance token unavailable. Connect via the QR code first.',
      400
    );
  }

  // Resolve the reply target to its Uazapi message_id. The parent must
  // belong to this same conversation — otherwise a caller could quote
  // messages they can't see by guessing UUIDs.
  let quotedMessageId: string | undefined;
  if (replyToMessageId) {
    const { data: parent, error: parentError } = await db
      .from('messages')
      .select('message_id, conversation_id')
      .eq('id', replyToMessageId)
      .eq('conversation_id', conversationId)
      .maybeSingle();

    if (parentError || !parent) {
      throw new UazapiSendError(
        'bad_request',
        'reply_to_message_id not found in this conversation',
        400
      );
    }
    if (!parent.message_id) {
      console.warn('[uazapi-send] reply parent has no Uazapi message id — sending without quote');
    } else {
      quotedMessageId = parent.message_id;
    }
  }

  // Send via Uazapi
  const to = sanitizedPhone.replace('+', '');
  let uazapiMessageId = '';

  try {
    if (messageType === 'menu') {
      const result = await sendMenu({
        serverUrl: env.serverUrl,
        apiToken,
        to,
        body: contentText || '',
        title: menuTitle || undefined,
        footer: menuFooter || undefined,
        rows: menuRows || [],
        quotedMessageId,
      });
      uazapiMessageId = result.messageId;
    } else if (isMediaKind) {
      const result = await sendMediaMessage({
        serverUrl: env.serverUrl,
        apiToken,
        to,
        kind: messageType as MediaKind,
        link: mediaUrl!,
        caption: contentText || undefined,
        filename: filename || undefined,
        quotedMessageId,
      });
      uazapiMessageId = result.messageId;
    } else {
      const result = await sendTextMessage({
        serverUrl: env.serverUrl,
        apiToken,
        to,
        text: contentText!,
        quotedMessageId,
      });
      uazapiMessageId = result.messageId;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown Uazapi error';
    console.error('[uazapi-send] Send failed:', message);
    throw new UazapiSendError('uazapi_error', `Uazapi error: ${message}`, 502);
  }

  // Persist the message
  const { data: messageRecord, error: msgError } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: messageType === 'menu' ? 'interactive' : messageType,
      content_text: contentText || null,
      media_url: mediaUrl || null,
      message_id: uazapiMessageId,
      status: 'sent',
      source: 'uazapi',
      reply_to_message_id: replyToMessageId || null,
    })
    .select()
    .single();

  if (msgError) {
    console.error('[uazapi-send] error inserting sent message:', msgError);
    throw new UazapiSendError(
      'db_error',
      `Message sent to Uazapi but failed to save to DB: ${msgError.message}`,
      500
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: contentText || `[${messageType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversationId);

  // Pause active Flow runs — best-effort
  try {
    const { error: pauseErr } = await supabaseAdmin()
      .from('flow_runs')
      .update({
        status: 'paused_by_agent',
        ended_at: new Date().toISOString(),
        end_reason: 'agent_replied',
      })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
    if (pauseErr) {
      console.error('[uazapi-send][flows] pause-on-send failed:', pauseErr.message);
    }
  } catch (err) {
    console.error('[uazapi-send][flows] pause-on-send threw:', err);
  }

  return { messageId: messageRecord.id, uazapiMessageId };
}
