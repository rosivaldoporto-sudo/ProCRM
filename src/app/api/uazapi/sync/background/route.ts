import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { uazapiEnvConfig, getCachedInstanceToken } from '@/lib/uazapi/runtime-config';
import { fetchChats } from '@/lib/uazapi/uazapi-client';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    const { searchParams } = new URL(request.url);
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 500, 1),
      2000
    );
    const includeMessages = searchParams.get('messages') !== 'false';

    const env = uazapiEnvConfig();
    if (!env.serverUrl) {
      return NextResponse.json(
        { error: 'UAZAPI_SERVER_URL is not set in the environment.' },
        { status: 400 }
      );
    }

    const apiToken = await getCachedInstanceToken(supabaseAdmin(), accountId);
    if (!apiToken) {
      return NextResponse.json(
        { error: 'Uazapi instance token unavailable.' },
        { status: 400 }
      );
    }

    const chats = await fetchChats({
      serverUrl: env.serverUrl,
      apiToken,
      limit,
    });

    if (chats.length === 0) {
      return NextResponse.json({
        jobId: null,
        message: 'No chats found to sync.',
        synced: 0,
      });
    }

    const { data: job, error: jobErr } = await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .insert({
        account_id: accountId,
        user_id: userId,
        status: 'pending',
        total_chats: chats.length,
      })
      .select('id')
      .single();

    if (jobErr || !job) {
      console.error('[uazapi-sync-bg] job create error:', jobErr);
      return NextResponse.json({ error: 'Failed to create sync job' }, { status: 500 });
    }

    const jobId = job.id;

    const { error: updateErr } = await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', jobId);

    if (updateErr) {
      console.warn('[uazapi-sync-bg] job status update failed:', updateErr);
    }

    const syncPromise = runBackgroundSync(
      jobId,
      accountId,
      userId,
      chats,
      env.serverUrl,
      apiToken,
      includeMessages
    );

    syncPromise.catch((err) => {
      console.error('[uazapi-sync-bg] background sync failed:', err);
      supabaseAdmin()
        .from('uazapi_sync_jobs')
        .update({
          status: 'failed',
          error_message: err instanceof Error ? err.message : 'Unknown error',
          completed_at: new Date().toISOString(),
        })
        .eq('id', jobId)
        .then();
    });

    return NextResponse.json({
      jobId,
      totalChats: chats.length,
      message: `Sync started in background for ${chats.length} chats.`,
    });
  } catch (error) {
    console.error('[uazapi-sync-bg] error:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json({ error: 'Failed to start sync' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('admin');

    const { searchParams } = new URL(request.url);
    const jobId = searchParams.get('jobId');

    if (!jobId) {
      return NextResponse.json({ error: 'jobId is required' }, { status: 400 });
    }

    const { data: job } = await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .select('status')
      .eq('id', jobId)
      .eq('account_id', accountId)
      .maybeSingle();

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    }

    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return NextResponse.json({ error: 'Job already finished' }, { status: 400 });
    }

    await supabaseAdmin()
      .from('uazapi_sync_jobs')
      .update({ status: 'cancelled', completed_at: new Date().toISOString() })
      .eq('id', jobId);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[uazapi-sync-bg] cancel error:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json({ error: 'Failed to cancel sync' }, { status: 500 });
  }
}

async function runBackgroundSync(
  jobId: string,
  accountId: string,
  userId: string,
  chats: Awaited<ReturnType<typeof fetchChats>>,
  serverUrl: string,
  apiToken: string,
  includeMessages: boolean
) {
  const adminDb = supabaseAdmin();

  const { findExistingContact, isUniqueViolation, resolveContactName } = await import(
    '@/lib/contacts/dedupe'
  );
  const { resolveAuditUserId } = await import('@/lib/api/v1/contacts');
  const {
    fetchMessages,
    downloadMessageUrl,
    getInstanceWebhook,
    setInstanceWebhook,
  } = await import('@/lib/uazapi/uazapi-client');
  const { refreshContactProfilePhoto } = await import('@/lib/uazapi/profile-photo');
  const { buildUazapiWebhookUrl } = await import('@/lib/uazapi/webhook-auth');
  const { after } = await import('next/server');

  const ownerUserId = await resolveAuditUserId(adminDb, accountId);

  const env = uazapiEnvConfig();
  const webhookUrl = buildUazapiWebhookUrl(
    process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'http://localhost:3000',
    accountId
  );

  try {
    const current = await getInstanceWebhook({ serverUrl, apiToken });
    if (
      !current ||
      current.url !== webhookUrl ||
      current.enabled === false ||
      !current.events?.includes('messages')
    ) {
      await setInstanceWebhook({
        serverUrl,
        apiToken,
        url: webhookUrl,
        events: ['messages', 'messages_update', 'connection'],
        excludeMessages: ['wasSentByApi'],
      });
    }
  } catch (err) {
    console.warn('[uazapi-sync-bg] webhook verify/repair failed:', err);
  }

  let syncedCount = 0;
  let messagesImported = 0;
  const warnings: string[] = [];

  for (const chat of chats) {
    const phone = normalizePhone(chat.phone || chat.chatid || chat.id);
    if (!phone) continue;

    await adminDb
      .from('uazapi_sync_jobs')
      .update({ current_chat: phone, synced_chats: syncedCount, imported_messages: messagesImported })
      .eq('id', jobId);

    let contactId: string;
    const existing = await findExistingContact(adminDb, accountId, phone);
    const resolvedName = resolveContactName(chat.name, phone);

    if (existing) {
      contactId = existing.id;
      if (resolvedName !== existing.name) {
        await adminDb
          .from('contacts')
          .update({ name: resolvedName, updated_at: new Date().toISOString() })
          .eq('id', existing.id);
      }
    } else {
      const { data: created, error: createErr } = await adminDb
        .from('contacts')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          phone,
          name: resolvedName,
        })
        .select('id')
        .single();

      if (createErr || !created) {
        if (isUniqueViolation(createErr)) {
          const raced = await findExistingContact(adminDb, accountId, phone);
          if (!raced) continue;
          contactId = raced.id;
        } else {
          continue;
        }
      } else {
        contactId = created.id;
      }
    }

    if (!existing || !existing.avatar_url) {
      after(async () => {
        await refreshContactProfilePhoto({
          accountId,
          contactId,
          phone,
          serverUrl,
          apiToken,
          photoUrl: chat.image,
        });
      });
    }

    const { data: existingConv } = await adminDb
      .from('conversations')
      .select('*')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle();

    let conversationId: string;

    if (existingConv) {
      conversationId = existingConv.id;
      const syncedAt = chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : null;
      const currentAt = existingConv.last_message_at ? new Date(existingConv.last_message_at).getTime() : null;
      if (syncedAt !== null && (currentAt === null || syncedAt > currentAt)) {
        const convUpdate: Record<string, unknown> = {
          last_message_text: chat.lastMessage || existingConv.last_message_text,
          last_message_at: new Date(syncedAt).toISOString(),
          updated_at: new Date().toISOString(),
        };
        if (chat.unreadCount != null && chat.unreadCount > (existingConv.unread_count || 0)) {
          convUpdate.unread_count = chat.unreadCount;
        }
        await adminDb.from('conversations').update(convUpdate).eq('id', conversationId);
      }
    } else {
      const { data: created, error: convErr } = await adminDb
        .from('conversations')
        .insert({
          account_id: accountId,
          user_id: ownerUserId,
          contact_id: contactId,
          source: 'uazapi',
          last_message_text: chat.lastMessage || null,
          last_message_at: chat.lastMessageAt ? new Date(chat.lastMessageAt).toISOString() : null,
          unread_count: chat.unreadCount || 0,
        })
        .select('id')
        .single();

      if (convErr || !created) {
        if (isUniqueViolation(convErr)) continue;
        console.error('[uazapi-sync-bg] conversation insert error:', convErr?.message);
        continue;
      }
      conversationId = created.id;
    }

    syncedCount++;

    if (includeMessages) {
      const result = await syncChatMessagesBackground(
        adminDb,
        conversationId,
        chat.id,
        serverUrl,
        apiToken
      );
      messagesImported += result.imported;
      warnings.push(...result.warnings);
    }
  }

  await adminDb
    .from('uazapi_sync_jobs')
    .update({
      status: 'completed',
      synced_chats: syncedCount,
      imported_messages: messagesImported,
      current_chat: null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function syncChatMessagesBackground(
  db: SupabaseClient,
  conversationId: string,
  chatid: string,
  serverUrl: string,
  apiToken: string
): Promise<{ imported: number; warnings: string[] }> {
  const { data: existingRows } = await db
    .from('messages')
    .select('id, message_id, sender_type, content_text, media_url, reply_to_message_id, created_at')
    .eq('conversation_id', conversationId);

  const existingIds = new Set<string>();
  const bySenderText = new Map<string, number[]>();
  for (const row of existingRows ?? []) {
    if (row.message_id) existingIds.add(row.message_id);
    const text = String(row.content_text ?? '');
    if (!text) continue;
    const key = `${row.sender_type}|${text}`;
    const list = bySenderText.get(key) ?? [];
    list.push(new Date(row.created_at).getTime());
    bySenderText.set(key, list);
  }

  const DUP_WINDOW_MS = 90_000;

  const isDuplicate = (m: {
    messageid?: string;
    sender_type: string;
    text: string;
    createdAt: number;
  }): boolean => {
    if (m.messageid) return existingIds.has(m.messageid);
    if (!m.text) return false;
    const list = bySenderText.get(`${m.sender_type}|${m.text}`);
    if (!list) return false;
    return list.some((ts) => Math.abs(ts - m.createdAt) < DUP_WINDOW_MS);
  };

  let imported = 0;
  let offset = 0;
  const pageSize = 100;
  const warnings: string[] = [];

  const { fetchMessages, downloadMessageUrl } = await import(
    '@/lib/uazapi/uazapi-client'
  );
  const { mapUazapiContentType, mapUazapiStatus, uazapiTimestampToIso, extractUazapiQuotedId } = await import(
    '@/lib/uazapi/message-mapping'
  );
  const { isUniqueViolation } = await import('@/lib/contacts/dedupe');

  for (;;) {
    const { messages, error } = await fetchMessages({
      serverUrl,
      apiToken,
      chatid,
      limit: pageSize,
      offset,
    });
    if (error) {
      warnings.push(
        `History fetch failed for chat ${chatid} at offset ${offset} (${error}) — messages after this point were not imported.`
      );
      console.warn('[uazapi-sync-bg] fetchMessages error:', { chatid, offset, error });
      break;
    }
    if (messages.length === 0) break;

    for (const m of messages) {
      if (m.isGroup) continue;

      const text = typeof m.text === 'string' ? m.text : '';
      const content = m.content;
      const contentString =
        typeof content === 'string'
          ? content
          : (content as { text?: string } | undefined)?.text;
      const body = text || contentString || '';

      const contentType =
        mapUazapiContentType(m.messageType || '', m.mediaType || '') ||
        (body ? 'text' : null);
      if (!contentType) {
        console.warn('[uazapi-sync-bg] skipped message — no text and unmapped type:', {
          chatid,
          messageid: m.messageid,
          messageType: m.messageType,
        });
        continue;
      }

      const createdAt = uazapiTimestampToIso(m.messageTimestamp);
      const createdAtMs = createdAt ? new Date(createdAt).getTime() : Date.now();

      const isMedia = contentType !== 'text' && contentType !== 'location';
      let mediaUrl: string | null = m.fileURL || null;

      if (m.messageid && existingIds.has(m.messageid)) {
        const row = (existingRows ?? []).find((r) => r.message_id === m.messageid);
        if (row) {
          const updates: Record<string, unknown> = {};
          if (isMedia && !row.media_url && m.messageid) {
            const file = await downloadMessageUrl(
              { serverUrl, apiToken, messageId: m.messageid },
              2
            );
            if (file?.url) updates.media_url = file.url;
          }
          if (!row.reply_to_message_id) {
            const quotedId = extractUazapiQuotedId(m);
            if (quotedId) {
              const { data: quotedParent } = await db
                .from('messages')
                .select('id')
                .eq('conversation_id', conversationId)
                .eq('message_id', quotedId)
                .limit(1)
                .maybeSingle();
              if (quotedParent?.id) updates.reply_to_message_id = quotedParent.id;
            }
          }
          if (Object.keys(updates).length > 0) {
            await db
              .from('messages')
              .update({ ...updates, updated_at: new Date().toISOString() })
              .eq('id', (row as { id?: string }).id as string);
          }
        }
        continue;
      }

      if (
        isDuplicate({
          messageid: m.messageid,
          sender_type: m.fromMe ? 'agent' : 'customer',
          text: body,
          createdAt: createdAtMs,
        })
      ) {
        continue;
      }

      if (isMedia && !mediaUrl && m.messageid) {
        const file = await downloadMessageUrl(
          { serverUrl, apiToken, messageId: m.messageid },
          2
        );
        mediaUrl = file?.url || null;
      }

      const quotedId = extractUazapiQuotedId(m);
      let replyToInternalId: string | null = null;
      if (quotedId) {
        const { data: quotedParent } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('message_id', quotedId)
          .limit(1)
          .maybeSingle();
        replyToInternalId = quotedParent?.id ?? null;
      }

      const { error: insertError } = await db.from('messages').insert({
        conversation_id: conversationId,
        sender_type: m.fromMe ? 'agent' : 'customer',
        content_type: contentType,
        content_text: body || null,
        media_url: mediaUrl,
        message_id: m.messageid || null,
        status: mapUazapiStatus(m.status || ''),
        source: 'uazapi',
        reply_to_message_id: replyToInternalId,
        created_at: createdAt ?? new Date().toISOString(),
      });

      if (insertError) {
        if (isUniqueViolation(insertError)) {
          if (m.messageid) existingIds.add(m.messageid);
          continue;
        }
        console.error('[uazapi-sync-bg] message insert error:', insertError.message);
        continue;
      }

      if (m.messageid) existingIds.add(m.messageid);
      const key = `${m.fromMe ? 'agent' : 'customer'}|${body}`;
      if (body) {
        const list = bySenderText.get(key) ?? [];
        list.push(createdAtMs);
        bySenderText.set(key, list);
      }
      imported++;
    }

    if (messages.length < pageSize) break;
    offset += pageSize;
  }

  return { imported, warnings };
}
