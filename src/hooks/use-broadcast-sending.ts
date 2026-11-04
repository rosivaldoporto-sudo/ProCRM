'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { MessageTemplate } from '@/types';
import {
  AudienceConfig,
  headerMediaKind,
  prepareBroadcastMedia,
  sendPendingRecipients,
  VariableMapping,
} from '@/lib/broadcast-send';
import { resolveAudienceContacts } from '@/lib/broadcast-audience';

// Re-exported so callers that imported these from the hook keep working.
export type {
  AudienceConfig,
  CustomFieldFilter,
  CustomFieldOperator,
  VariableMapping,
} from '@/lib/broadcast-send';

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  /**
   * Media URL for an IMAGE/VIDEO/DOCUMENT header. Required at send
   * time for media-header templates — Meta rejects the send without
   * it. Passed through as `messageParams.headerMediaUrl`; the builder
   * falls back to the template's stored URL only when this is empty.
   * Persisted on the broadcast row (migration 047) so a later
   * "Resume sending" run reuses the same media.
   */
  headerMediaUrl?: string;
  /**
   * Tags applied to a contact once its message has been dispatched
   * (status 'sent'). Lets campaigns mark their audience for later
   * filtering, e.g. "campaign_july".
   */
  postSendTagIds?: string[];
}

interface UseBroadcastSendingReturn {
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const { accountId } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      // broadcasts.user_id is NOT NULL + guarded by RLS
      // (auth.uid() = user_id). Without this, the INSERT below was
      // silently failing with 23502 / 42501 — the wizard would
      // no-op with no feedback.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('Você não está conectado.');
      }
      if (!accountId) {
        throw new Error('Seu perfil não está vinculado a uma conta.');
      }

      // ── Step 0b: Prepare the header media ─────────────────────────
      // Before anything is created: if the media can't be prepared, the
      // user can retry with no broadcast left behind to resume by mistake.
      const mediaKind = headerMediaKind(payload.template.header_type);
      const mediaUrl =
        payload.headerMediaUrl?.trim() ||
        payload.template.header_media_url?.trim();
      const headerMediaId =
        mediaKind && mediaUrl
          ? await prepareBroadcastMedia(mediaUrl, mediaKind)
          : undefined;

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudienceContacts(
        supabase,
        { userId: user.id, accountId },
        payload.audience,
      );

      if (contacts.length === 0) {
        throw new Error('Nenhum contato encontrado para este público.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          account_id: accountId,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          header_media_url: payload.headerMediaUrl?.trim() || null,
          post_send_tag_ids: payload.postSendTagIds ?? [],
          status: 'sending',
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Falha ao criar a transmissão: ${broadcastError?.message ?? 'erro desconhecido'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_CHUNK_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_CHUNK_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          // Previous impl logged and marched on — the broadcast then ran
          // with an incomplete recipient set, so webhook status updates
          // couldn't find some rows and the aggregate counts drifted.
          // Flip the broadcast to failed so the user sees the problem
          // immediately, then throw to abort the send loop.
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Falha ao inserir o lote de destinatários ${i / INSERT_CHUNK_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // ── Step 4: Fan out (shared with the detail page's resume) ────
      // Everything from here (batch loop → API → recipient stamps →
      // post-send tags → final status) lives in lib/broadcast-send so
      // a broadcast cut short by a closed tab can be finished later.
      await sendPendingRecipients(
        supabase,
        broadcast.id,
        (pct) => setProgress(20 + Math.round(pct * 0.8)),
        { headerMediaId },
      );

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, isProcessing, progress };
}

/** Recipient inserts — independent of the send rate (200 keeps the payload small). */
const INSERT_CHUNK_SIZE = 200;