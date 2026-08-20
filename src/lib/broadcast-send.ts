// ============================================================
// Shared broadcast fan-out logic.
//
// The dashboard wizard and the "Resume sending" button on the
// broadcast detail page run the SAME dispatch loop: fetch the
// pending recipients for a broadcast, POST them to
// /api/whatsapp/broadcast in small batches (respecting Meta's
// per-phone messaging rate), stamp each recipient row, apply the
// post-send tags, and finalize the broadcast status once nothing
// is left pending.
//
// Splitting it here keeps the two call sites from drifting — the
// wizard previously owned this loop exclusively, so a broadcast
// that got cut short (tab closed / background tab throttling)
// stranded its remaining recipients as 'pending' forever with no
// way to finish them.
// ============================================================

import { createClient } from '@/lib/supabase/client';
import type { Contact } from '@/types';

/** Tag-filter / custom-field / CSV audience definition. */
export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv' | 'manual_list';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

/**
 * Variable mapping — each template placeholder (by key, usually "1",
 * "2", …) is resolved at send time. `field` maps to a built-in contact
 * field (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */
export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
export const SEND_BATCH_SIZE = 10;
export const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
export const INSERT_BATCH_SIZE = 200;

/** contactId → (customFieldId → value). */
type CustomValueIndex = Map<string, Map<string, string>>;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Per-contact resolution of custom-field placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
): string[] {
  // Keys are typically "1","2",... — numeric-aware sort keeps
  // {{1}} before {{10}}.
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });

  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return fieldMap[v.value] ?? '';
    }

    // custom_field
    return customValues?.get(v.value) ?? '';
  });
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
): Promise<CustomValueIndex> {
  const index: CustomValueIndex = new Map();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST caps the .in(...) IN-clause roughly at 1000
  // values. Page through to stay safe.
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

export interface SendPendingResult {
  /** Recipients dispatched successfully this run. */
  sent: number;
  /** Recipients that failed this run (incl. no-phone rows). */
  failed: number;
  /** Recipients still waiting after this run (concurrent resume etc.). */
  pendingRemaining: number;
}

/**
 * Fan out every `pending` recipient of a broadcast through the same
 * API path the wizard uses. Re-entrant: safe to call again later for
 * whatever is still pending. Best-effort per recipient — one failure
 * never aborts the rest; the broadcast is finalized to a terminal
 * status only when nothing is left pending.
 */
export async function sendPendingRecipients(
  supabase: ReturnType<typeof createClient>,
  broadcastId: string,
  onProgress?: (percent: number) => void,
): Promise<SendPendingResult> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const user = session?.user;
  if (!user) {
    throw new Error('You are not signed in.');
  }

  const { data: broadcast, error: bErr } = await supabase
    .from('broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .single();
  if (bErr || !broadcast) {
    throw new Error('Failed to load broadcast');
  }

  // Template row — used to detect media headers and to fall back to the
  // template's stored media URL when the broadcast didn't persist one.
  const { data: rawTemplateRow } = await supabase
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', broadcast.template_name)
    .eq('language', broadcast.template_language ?? 'en_US')
    .maybeSingle();
  const templateRow = rawTemplateRow ?? null;

  const headerType = templateRow?.header_type;
  const isMediaHeader =
    headerType === 'image' || headerType === 'video' || headerType === 'document';
  const headerMediaUrl =
    (broadcast.header_media_url as string | null)?.trim() ||
    (templateRow?.header_media_url as string | null) ||
    undefined;
  const messageParams =
    isMediaHeader && headerMediaUrl ? { headerMediaUrl } : undefined;

  const { data: recipients, error: rErr } = await supabase
    .from('broadcast_recipients')
    .select('*, contact:contacts(*)')
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  if (rErr) {
    throw new Error('Failed to fetch pending recipients');
  }
  if (!recipients || recipients.length === 0) {
    return { sent: 0, failed: 0, pendingRemaining: 0 };
  }

  const variables = (broadcast.template_variables ?? {}) as Record<
    string,
    VariableMapping
  >;
  const postSendTagIds = (broadcast.post_send_tag_ids ?? []) as string[];

  const contactIds = recipients
    .map((r) => r.contact?.id)
    .filter((id): id is string => Boolean(id));
  const customValueIndex = await fetchCustomValueIndex(supabase, contactIds);

  let failedCount = 0;
  const totalPending = recipients.length;
  const sentContactIds = new Set<string>();

  for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
    const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

    const apiRecipients = batch
      .filter((r) => r.contact?.phone)
      .map((r) => ({
        phone: r.contact!.phone as string,
        params: r.contact
          ? resolveVariables(
              variables,
              r.contact,
              customValueIndex.get(r.contact.id),
            )
          : [],
        ...(messageParams ? { messageParams } : {}),
      }));

    if (apiRecipients.length === 0) {
      for (const recipient of batch) {
        failedCount++;
        await supabase
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: 'No phone number on contact',
          })
          .eq('id', recipient.id);
      }
      continue;
    }

    try {
      const res = await fetch('/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: apiRecipients,
          template_name: broadcast.template_name,
          template_language: broadcast.template_language ?? 'en_US',
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Broadcast API request failed');
      }

      const resultsByPhone = new Map<string, BroadcastApiResult>();
      for (const r of (data.results ?? []) as BroadcastApiResult[]) {
        resultsByPhone.set(r.phone, r);
      }

      for (const recipient of batch) {
        const phone = recipient.contact?.phone;
        const result = phone ? resultsByPhone.get(phone) : undefined;

        if (!result) {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: 'No phone number on contact',
            })
            .eq('id', recipient.id);
          continue;
        }

        if (result.status === 'sent') {
          if (recipient.contact?.id) sentContactIds.add(recipient.contact.id);
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'sent',
              sent_at: new Date().toISOString(),
              whatsapp_message_id: result.whatsapp_message_id ?? null,
              error_message: null,
            })
            .eq('id', recipient.id);
        } else {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: result.error ?? 'Unknown error',
            })
            .eq('id', recipient.id);
        }
      }
    } catch (err) {
      for (const recipient of batch) {
        failedCount++;
        await supabase
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            error_message: err instanceof Error ? err.message : 'Unknown error',
          })
          .eq('id', recipient.id);
      }
    }

    onProgress?.(Math.round(((i + batch.length) / totalPending) * 90));
    if (i + SEND_BATCH_SIZE < recipients.length) {
      await sleep(SEND_BATCH_DELAY_MS);
    }
  }

  // Apply post-send tags to every contact dispatched during this run.
  // Best-effort — a tagging failure is logged, never fatal.
  if (postSendTagIds.length > 0 && sentContactIds.size > 0) {
    const tagRows = [...sentContactIds].flatMap((contactId) =>
      postSendTagIds.map((tagId) => ({
        contact_id: contactId,
        tag_id: tagId,
      })),
    );
    for (let i = 0; i < tagRows.length; i += INSERT_BATCH_SIZE) {
      const batch = tagRows.slice(i, i + INSERT_BATCH_SIZE);
      const { error: tagError } = await supabase
        .from('contact_tags')
        .upsert(batch, {
          onConflict: 'contact_id,tag_id',
          ignoreDuplicates: true,
        });
      if (tagError) {
        console.error(
          `Failed to apply post-send tags (batch ${i / INSERT_BATCH_SIZE + 1}):`,
          tagError.message,
        );
      }
    }
  }

  // Re-check what's left. Another resume (or the original wizard loop)
  // may have raced us; only finalize when nothing is pending.
  const { count: pendingCount } = await supabase
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');

  if ((pendingCount ?? 0) === 0) {
    const { count: sentCount } = await supabase
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .in('status', ['sent', 'delivered', 'read', 'replied']);
    const finalStatus = (sentCount ?? 0) > 0 ? 'sent' : 'failed';
    await supabase
      .from('broadcasts')
      .update({
        status: finalStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', broadcastId);
  }

  return { sent: sentContactIds.size, failed: failedCount, pendingRemaining: pendingCount ?? 0 };
}