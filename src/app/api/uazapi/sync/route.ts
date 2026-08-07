import { NextResponse, after } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchChats, fetchMessages, downloadMessageUrl } from '@/lib/uazapi/uazapi-client'
import { refreshContactProfilePhoto } from '@/lib/uazapi/profile-photo'
import {
  mapUazapiContentType,
  mapUazapiStatus,
  uazapiTimestampToIso,
  extractUazapiQuotedId,
} from '@/lib/uazapi/message-mapping'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export const maxDuration = 120

/**
 * POST /api/uazapi/sync
 *
 * Pulls existing chats from the Uazapi server and mirrors them into the
 * CRM:
 *   1. Lists individual chats (POST /chat/find, most recent first).
 *   2. For each chat, finds/creates the contact and conversation.
 *   3. Imports the stored message history (POST /message/find) so the
 *      conversations aren't empty shells.
 *
 * Query params:
 *   limit    — max chats to process (default 100, max 500)
 *   messages — "false" skips the message-history import (default true)
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    const { data: config } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || config.status !== 'connected') {
      return NextResponse.json({ error: 'Uazapi is not connected.' }, { status: 400 })
    }

    const { searchParams } = new URL(request.url)
    const limit = Math.min(
      Math.max(Number(searchParams.get('limit')) || 100, 1),
      500,
    )
    const includeMessages = searchParams.get('messages') !== 'false'

    const apiToken = decrypt(config.api_token)
    const ownerUserId = await resolveAuditUserId(supabase, accountId)

    // Fetch recent chats from Uazapi server
    const chats = await fetchChats({ serverUrl: config.server_url, apiToken, limit })

    if (chats.length === 0) {
      return NextResponse.json({ synced: 0, messagesImported: 0, message: 'No chats found to sync.' })
    }

    let syncedCount = 0
    let messagesImported = 0
    const syncWarnings: string[] = []

    for (const chat of chats) {
      const phone = normalizePhone(chat.phone || chat.chatid || chat.id)
      if (!phone) continue

      // Find or create contact
      let contactId: string
      const existing = await findExistingContact(supabase, accountId, phone)
      if (existing) {
        contactId = existing.id
        if (chat.name && chat.name !== existing.name) {
          await supabase
            .from('contacts')
            .update({ name: chat.name, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
        }
      } else {
        const { data: created, error: createErr } = await supabase
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            phone,
            name: chat.name || phone,
          })
          .select('id')
          .single()

        if (createErr || !created) {
          if (isUniqueViolation(createErr)) {
            const raced = await findExistingContact(supabase, accountId, phone)
            if (!raced) continue
            contactId = raced.id
          } else {
            continue
          }
        } else {
          contactId = created.id
        }
      }

      // Backfill: fetch the WhatsApp profile picture for contacts that
      // don't have one yet (new contacts never do). Runs after the
      // response — best-effort, never blocks the sync (see
      // refreshContactProfilePhoto).
      if (!existing || !existing.avatar_url) {
        after(async () => {
          await refreshContactProfilePhoto({
            accountId,
            contactId,
            phone,
            serverUrl: config.server_url,
            apiToken,
          })
        })
      }

      // Find or create conversation with source='uazapi'
      const { data: existingConv } = await supabase
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .maybeSingle()

      let conversationId: string

      if (existingConv) {
        conversationId = existingConv.id
        // Refresh metadata when the server has a newer last message.
        const syncedAt = chat.lastMessageAt ? new Date(chat.lastMessageAt).getTime() : null
        const currentAt = existingConv.last_message_at
          ? new Date(existingConv.last_message_at).getTime()
          : null
        if (syncedAt !== null && (currentAt === null || syncedAt > currentAt)) {
          const convUpdate: Record<string, unknown> = {
            last_message_text: chat.lastMessage || existingConv.last_message_text,
            last_message_at: new Date(syncedAt).toISOString(),
            updated_at: new Date().toISOString(),
          }
          if (
            chat.unreadCount != null &&
            chat.unreadCount > (existingConv.unread_count || 0)
          ) {
            convUpdate.unread_count = chat.unreadCount
          }
          await supabase.from('conversations').update(convUpdate).eq('id', conversationId)
        }
      } else {
        const { data: created, error: convErr } = await supabase
          .from('conversations')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            contact_id: contactId,
            source: 'uazapi',
            last_message_text: chat.lastMessage || null,
            last_message_at: chat.lastMessageAt
              ? new Date(chat.lastMessageAt).toISOString()
              : null,
            unread_count: chat.unreadCount || 0,
          })
          .select('id')
          .single()

        if (convErr || !created) {
          if (isUniqueViolation(convErr)) continue // Race: already exists
          console.error('[uazapi-sync] conversation insert error:', convErr?.message)
          continue
        }
        conversationId = created.id
      }

      syncedCount++

      // Import stored message history for this chat
      if (includeMessages) {
        const result = await syncChatMessages(
          supabase,
          conversationId,
          chat.id,
          config.server_url,
          apiToken,
        )
        messagesImported += result.imported
        syncWarnings.push(...result.warnings)
      }
    }

    return NextResponse.json({
      synced: syncedCount,
      messagesImported,
      found: chats.length,
      warnings: syncWarnings,
      message: `Synced ${syncedCount} of ${chats.length} chats found (${messagesImported} messages imported).`,
    })
  } catch (error) {
    console.error('[uazapi-sync] error:', error)
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 })
  }
}

/**
 * Import the stored messages of one chat via POST /message/find,
 * skipping rows that already exist locally. Dedupe is done on the
 * Uazapi message id (plus a fuzzy check — same sender + text within a
 * short time window — ONLY for messages that carry no id, since a
 * message_id is the strongest identity we have). Messages that already
 * exist but are missing their media URL get it backfilled instead of
 * being skipped, so a failed webhook download no longer loses the
 * media permanently.
 */
async function syncChatMessages(
  db: Awaited<ReturnType<typeof createClient>>,
  conversationId: string,
  chatid: string,
  serverUrl: string,
  apiToken: string,
): Promise<{ imported: number; warnings: string[] }> {
  // Load what we already have for the conversation.
  const { data: existingRows } = await db
    .from('messages')
    .select('id, message_id, sender_type, content_text, media_url, reply_to_message_id, created_at')
    .eq('conversation_id', conversationId)

  const existingIds = new Set<string>()
  const bySenderText = new Map<string, number[]>()
  for (const row of existingRows ?? []) {
    if (row.message_id) existingIds.add(row.message_id)
    const text = String(row.content_text ?? '')
    if (!text) continue
    const key = `${row.sender_type}|${text}`
    const list = bySenderText.get(key) ?? []
    list.push(new Date(row.created_at).getTime())
    bySenderText.set(key, list)
  }

  const DUP_WINDOW_MS = 90_000

  const isDuplicate = (m: {
    messageid?: string
    sender_type: string
    text: string
    createdAt: number
  }): boolean => {
    if (m.messageid) return existingIds.has(m.messageid)
    // Only messages WITHOUT an id fall back to the fuzzy check.
    if (!m.text) return false
    const list = bySenderText.get(`${m.sender_type}|${m.text}`)
    if (!list) return false
    return list.some((ts) => Math.abs(ts - m.createdAt) < DUP_WINDOW_MS)
  }

  let imported = 0
  let offset = 0
  const pageSize = 100
  const warnings: string[] = []

  for (;;) {
    const { messages, error } = await fetchMessages({
      serverUrl,
      apiToken,
      chatid,
      limit: pageSize,
      offset,
    })
    if (error) {
      warnings.push(
        `History fetch failed for chat ${chatid} at offset ${offset} (${error}) — messages after this point were not imported.`,
      )
      console.warn('[uazapi-sync] fetchMessages error:', { chatid, offset, error })
      break
    }
    if (messages.length === 0) break

    for (const m of messages) {
      if (m.isGroup) continue

      const text = typeof m.text === 'string' ? m.text : ''
      const content = m.content
      const contentString =
        typeof content === 'string'
          ? content
          : (content as { text?: string } | undefined)?.text
      const body = text || contentString || ''

      const contentType =
        mapUazapiContentType(m.messageType || '', m.mediaType || '') ||
        (body ? 'text' : null)
      if (!contentType) {
        console.warn('[uazapi-sync] skipped message — no text and unmapped type:', {
          chatid,
          messageid: m.messageid,
          messageType: m.messageType,
        })
        continue
      }

      const createdAt = uazapiTimestampToIso(m.messageTimestamp)
      const createdAtMs = createdAt ? new Date(createdAt).getTime() : Date.now()

      const isMedia = contentType !== 'text' && contentType !== 'location'
      let mediaUrl: string | null = m.fileURL || null

      // Existing row (matched by message id): backfill missing media
      // URL and reply link — an earlier webhook may have failed its
      // async download or pre-dates reply extraction.
      if (m.messageid && existingIds.has(m.messageid)) {
        const row = (existingRows ?? []).find(
          (r) => r.message_id === m.messageid,
        )
        if (row) {
          const updates: Record<string, unknown> = {}
          if (isMedia && !row.media_url && m.messageid) {
            const file = await downloadMessageUrl(
              { serverUrl, apiToken, messageId: m.messageid },
              2,
            )
            if (file?.url) updates.media_url = file.url
          }
          if (!row.reply_to_message_id) {
            const quotedId = extractUazapiQuotedId(m)
            if (quotedId) {
              const { data: quotedParent } = await db
                .from('messages')
                .select('id')
                .eq('conversation_id', conversationId)
                .eq('message_id', quotedId)
                .limit(1)
                .maybeSingle()
              if (quotedParent?.id) updates.reply_to_message_id = quotedParent.id
            }
          }
          if (Object.keys(updates).length > 0) {
            await db
              .from('messages')
              .update({ ...updates, updated_at: new Date().toISOString() })
              .eq('id', (row as { id?: string }).id as string)
          }
        }
        continue
      }

      if (isDuplicate({
        messageid: m.messageid,
        sender_type: m.fromMe ? 'agent' : 'customer',
        text: body,
        createdAt: createdAtMs,
      })) {
        continue
      }

      // Media without a fileURL in /message/find — resolve it now so
      // the inbox has a URL instead of an eternal "unavailable" tile.
      if (isMedia && !mediaUrl && m.messageid) {
        const file = await downloadMessageUrl(
          { serverUrl, apiToken, messageId: m.messageid },
          2,
        )
        mediaUrl = file?.url || null
      }

      // Resolve the quoted (reply) message id to an internal id so the
      // inbox can render the quote. Best-effort: the parent may be
      // older than the sync window — the quote is just not shown then.
      const quotedId = extractUazapiQuotedId(m)
      let replyToInternalId: string | null = null
      if (quotedId) {
        const { data: quotedParent } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversationId)
          .eq('message_id', quotedId)
          .limit(1)
          .maybeSingle()
        replyToInternalId = quotedParent?.id ?? null
        if (!quotedParent) {
          console.warn('[uazapi-sync] quoted parent not found:', {
            chatid,
            messageid: m.messageid,
            quotedId,
          })
        }
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
      })

      if (insertError) {
        if (isUniqueViolation(insertError)) {
          // Race with a webhook insert — treat as already imported.
          if (m.messageid) existingIds.add(m.messageid)
          continue
        }
        console.error('[uazapi-sync] message insert error:', insertError.message)
        continue
      }

      if (m.messageid) existingIds.add(m.messageid)
      const key = `${m.fromMe ? 'agent' : 'customer'}|${body}`
      if (body) {
        const list = bySenderText.get(key) ?? []
        list.push(createdAtMs)
        bySenderText.set(key, list)
      }
      imported++
    }

    if (messages.length < pageSize) break
    offset += pageSize
  }

  return { imported, warnings }
}
