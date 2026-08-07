import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { downloadMessageUrl } from '@/lib/uazapi/uazapi-client'
import {
  mapUazapiContentType,
  uazapiTimestampToIso,
} from '@/lib/uazapi/message-mapping'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * Uazapi v2 webhook payload (flat shape). Reference:
 * https://github.com/eziocm/uazapi/blob/main/src/types.ts
 *
 * Older/alternative shapes (Baileys-style `data.msg`, `data.from`,
 * `messages[]`) are still accepted for backward compatibility.
 */
interface UazapiWebhookPayload {
  EventType?: string
  instance?: string
  owner?: string
  token?: string
  message?: UazapiWebhookMessage
  data?: {
    msg?: UazapiWebhookMessage & {
      key?: { id?: string; remoteJid?: string; fromMe?: boolean }
      message?: {
        conversation?: string
        extendedTextMessage?: { text: string }
      }
      pushName?: string
    }
    message?: UazapiWebhookMessage
    from?: string
    to?: string
    text?: string
    id?: string
  }
  messages?: Array<{
    id: string
    from: string
    to: string
    text?: string
    type?: string
    media?: string
    caption?: string
    timestamp?: string
  }>
}

interface UazapiWebhookMessage {
  id?: string
  messageid?: string
  chatid?: string
  sender?: string
  senderName?: string
  sender_pn?: string
  text?: string
  content?: unknown
  messageType?: string
  mediaType?: string
  type?: string
  fromMe?: boolean
  wasSentByApi?: boolean
  isGroup?: boolean
  groupName?: string
  messageTimestamp?: number | string
  owner?: string
}

/**
 * GET /api/uazapi/webhook
 *
 * Some Uazapi implementations use GET for webhook verification.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const challenge = searchParams.get('challenge')

  if (challenge) {
    return new NextResponse(challenge, { status: 200 })
  }

  return NextResponse.json({ status: 'ok' })
}

/**
 * POST /api/uazapi/webhook
 *
 * Handles incoming messages and status updates from Uazapi.
 */
export async function POST(request: Request) {
  const debug = new URL(request.url).searchParams.get('debug') === '1'
  try {
    const payload = (await request.json()) as UazapiWebhookPayload
    console.log('[uazapi-webhook] POST received:', JSON.stringify(payload).slice(0, 1500))
    const db = supabaseAdmin()

    // Resolve the uazapi_config row. Uazapi v2 identifies the instance
    // via `owner` / `token` (not `instance`), so try those before
    // falling back to a single-config lookup.
    const config = await resolveConfig(db, payload)
    if (!config) {
      console.error('[uazapi-webhook] no matching Uazapi config found')
      return NextResponse.json(
        debug
          ? { status: 'ok', debug: { config: 'none' } }
          : { error: 'No matching Uazapi config found' },
        debug ? { status: 200 } : { status: 404 },
      )
    }

    // Handle different payload shapes from Uazapi
    const messages = extractMessages(payload)
    console.log(`[uazapi-webhook] extracted ${messages.length} message(s) from payload`)

    if (messages.length === 0) {
      return NextResponse.json(
        debug
          ? {
              status: 'ok',
              debug: {
                config: 'matched',
                extracted: 0,
                // Payload keys help identify the shape your Uazapi sends.
                payloadKeys: Object.keys(payload),
                messageKeys: payload.message ? Object.keys(payload.message) : undefined,
              },
            }
          : { status: 'ok' },
      )
    }

    const apiToken = decrypt(config.api_token)

    for (const msg of messages) {
      // Skip outbound messages (sent by us)
      if (msg.fromMe) continue

      const phone = normalizePhone(msg.from)
      if (!phone) continue

      // Find or create contact (reuses shared dedupe logic from WhatsApp webhook)
      const contact = await findOrCreateContact(db, config.account_id, config.user_id, phone, msg.pushName)
      if (!contact) {
        console.error('[uazapi-webhook] failed to resolve contact for phone:', phone)
        continue
      }

      // Find or create conversation
      const convResult = await findOrCreateConversation(db, config.account_id, config.user_id, contact.id)
      if (!convResult) {
        console.error('[uazapi-webhook] failed to resolve conversation for contact:', contact.id)
        continue
      }
      const conversation = convResult.conversation

      // Determine content type and text
      const { contentType, contentText, mediaUrl } = extractMessageContent(msg)
      if (!contentType) {
        console.warn('[uazapi-webhook] dropped message — no text and unmapped type:', {
          messageId: msg.id,
          messageType: msg.messageType,
          mediaType: msg.mediaType,
        })
        continue
      }

      // Dedupe — Uazapi can redeliver webhooks (reconnect/retry); the
      // messages.message_id column is intentionally non-unique (036),
      // so dedupe explicitly by the Uazapi message id.
      if (msg.id) {
        const { data: existingMsg } = await db
          .from('messages')
          .select('id')
          .eq('conversation_id', conversation.id)
          .eq('message_id', msg.id)
          .maybeSingle()
        if (existingMsg) continue
      }

      // Persist the message
      const { data: inserted, error: insertError } = await db
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          sender_type: 'customer',
          content_type: contentType,
          content_text: contentText,
          media_url: mediaUrl,
          message_id: msg.id || null,
          status: 'delivered',
          source: 'uazapi',
          created_at: msg.createdAt ?? new Date().toISOString(),
        })
        .select('id')
        .single()

      if (insertError) {
        console.error('[uazapi-webhook] error inserting message:', insertError.message)
        continue
      }

      // Best-effort: resolve the real file URL for media messages
      // (Uazapi webhooks carry only the message id for media; the file
      // must be fetched via /message/download). Done async so it never
      // blocks the webhook response.
      if (inserted && mediaUrl === null && contentType !== 'text') {
        after(async () => {
          try {
            const file = await downloadMessageUrl({
              serverUrl: config.server_url,
              apiToken,
              messageId: msg.id,
            })
            if (file?.url) {
              await db
                .from('messages')
                .update({ media_url: file.url })
                .eq('id', inserted.id)
            }
          } catch (err) {
            console.error('[uazapi-webhook] media download failed:', err)
          }
        })
      }

      // Update conversation metadata + increment unread_count
      // If the existing source differs from uazapi, set to null (mixed)
      const convUpdate: Record<string, unknown> = {
        last_message_text: contentText || `[${contentType}]`,
        last_message_at: msg.createdAt ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'open',
        unread_count: (conversation.unread_count || 0) + 1,
      }
      if (!convResult.created && conversation.source && conversation.source !== 'uazapi') {
        convUpdate.source = null
      }
      await db.from('conversations').update(convUpdate).eq('id', conversation.id)

      // Dispatch to automations, flows, AI (async, best-effort)
      after(async () => {
        try {
          await Promise.allSettled([
            runAutomationsForTrigger({
              accountId: config.account_id,
              triggerType: 'new_message_received',
              contactId: contact.id,
              context: { conversation_id: conversation.id, message_text: contentText || '' },
            }),
            dispatchInboundToFlows({
              accountId: config.account_id,
              userId: config.user_id,
              contactId: contact.id,
              conversationId: conversation.id,
              message: {
                kind: 'text',
                text: contentText || '',
                meta_message_id: msg.id,
              },
              isFirstInboundMessage: false,
            }),
            dispatchInboundToAiReply({
              accountId: config.account_id,
              conversationId: conversation.id,
              contactId: contact.id,
              configOwnerUserId: config.user_id,
            }),
          ])
        } catch (err) {
          console.error('[uazapi-webhook] async dispatch error:', err)
        }
      })
    }

    return NextResponse.json(
      debug
        ? {
            status: 'ok',
            debug: { config: 'matched', extracted: messages.length },
          }
        : { status: 'ok' },
    )
  } catch (error) {
    console.error('Error in Uazapi webhook POST:', error)
    return NextResponse.json({ status: 'ok' }) // Always return 200 to acknowledge receipt
  }
}

/**
 * Locate the uazapi_config row this webhook belongs to. Uazapi v2
 * payloads carry the instance `owner` (name) and the instance `token` —
 * match on those when present. Falls back to the single config row
 * when there's exactly one.
 */
async function resolveConfig(
  db: ReturnType<typeof supabaseAdmin>,
  payload: UazapiWebhookPayload,
): Promise<{ account_id: string; user_id: string; server_url: string; api_token: string } | null> {
  const ownerCandidates = [
    payload.owner,
    payload.instance,
    payload.message?.owner,
    payload.data?.msg?.owner,
  ].filter(Boolean) as string[]

  const { data: allConfigs, error } = await db.from('uazapi_config').select('*')
  if (error || !allConfigs || allConfigs.length === 0) return null

  if (allConfigs.length === 1) return allConfigs[0]

  // Multiple configs — match by instance name first, then by token.
  for (const name of ownerCandidates) {
    const byName = allConfigs.find((c: { instance_name: string }) => c.instance_name === name)
    if (byName) return byName
  }

  if (payload.token) {
    for (const config of allConfigs) {
      try {
        if (decrypt(config.api_token) === payload.token) return config
      } catch {
        // skip unreadable configs
      }
    }
  }

  return null
}

// ============================================================
// Helper functions
// ============================================================

interface ExtractedMessage {
  id: string
  from: string
  fromMe: boolean
  pushName?: string
  contentType: string | null
  contentText: string | null
  mediaUrl: string | null
  createdAt?: string
  /** Raw Uazapi fields, kept for diagnostics/logging. */
  messageType?: string
  mediaType?: string
}

function extractMessages(payload: UazapiWebhookPayload): ExtractedMessage[] {
  const result: ExtractedMessage[] = []
  const seenIds = new Set<string>()
  const push = (msg: ExtractedMessage) => {
    if (!msg.from) return
    if (msg.id && seenIds.has(msg.id)) return
    if (msg.id) seenIds.add(msg.id)
    result.push(msg)
  }

  // Shape 0: Uazapi v2 flat payload (primary).
  //   { EventType: 'messages', message: { messageid, chatid, sender, text,
  //     fromMe, wasSentByApi, senderName, messageType, mediaType, type,
  //     isGroup, messageTimestamp }, chat: {...}, owner, token }
  // Also accepted nested under payload.data.message.
  const flatMessage = payload.message ?? payload.data?.message
  if (flatMessage) {
    // Outbound / API-sent messages loop back through the webhook — skip.
    if (!flatMessage.fromMe && !flatMessage.wasSentByApi) {
      const isGroup = flatMessage.isGroup === true ||
        /@g\.us$/.test(flatMessage.chatid || '')
      if (!isGroup) {
        const text = typeof flatMessage.text === 'string' ? flatMessage.text : ''
        const content = flatMessage.content
        const contentString =
          typeof content === 'string' ? content : (content as { text?: string })?.text
        const body = text || contentString || ''
        const contentType = mapUazapiContentType(flatMessage.messageType || '', flatMessage.mediaType || '')
        // Unknown message types still get persisted as text when a body
        // is present — better to keep the message than to drop it.
        const resolvedType = contentType || (body ? 'text' : null)
        if (resolvedType) {
          const createdAt = uazapiTimestampToIso(flatMessage.messageTimestamp)
          push({
            id: flatMessage.messageid || flatMessage.id || '',
            from: flatMessage.chatid || flatMessage.sender || '',
            fromMe: false,
            pushName: flatMessage.senderName || flatMessage.sender_pn || '',
            contentType: resolvedType,
            contentText: body || null,
            mediaUrl: null,
            createdAt,
            messageType: flatMessage.messageType || flatMessage.type || '',
            mediaType: flatMessage.mediaType || '',
          })
        }
      }
    }
  }

  // Shape 1: payload.data.msg (Baileys-style)
  if (payload.data?.msg) {
    const msg = payload.data.msg
    const key = msg.key || {}
    if (key.fromMe) return result // Skip outbound

    const message = msg.message || {}
    const conversation = message.conversation || ''
    const extendedText = message.extendedTextMessage?.text || ''
    const text = conversation || extendedText

    push({
      id: key.id || '',
      from: key.remoteJid?.replace(/@.*$/, '') || payload.data.from || '',
      fromMe: false,
      pushName: msg.pushName,
      contentType: text ? 'text' : null,
      contentText: text || null,
      mediaUrl: null,
    })
  }

  // Shape 2: payload.data with text/from fields
  if (payload.data?.from && payload.data?.text) {
    const existing = result.find((r) => r.from === payload.data!.from)
    if (!existing) {
      push({
        id: payload.data.id || '',
        from: payload.data.from,
        fromMe: false,
        pushName: '',
        contentType: 'text',
        contentText: payload.data.text,
        mediaUrl: null,
      })
    }
  }

  // Shape 3: payload.messages array
  if (payload.messages) {
    for (const m of payload.messages) {
      push({
        id: m.id,
        from: m.from,
        fromMe: false,
        pushName: '',
        contentType: m.media ? (m.type === 'image' ? 'image' : 'document') : 'text',
        contentText: m.caption || m.text || null,
        mediaUrl: m.media || null,
      })
    }
  }

  return result
}

function extractMessageContent(msg: ExtractedMessage): {
  contentType: string | null
  contentText: string | null
  mediaUrl: string | null
} {
  return {
    contentType: msg.contentType,
    contentText: msg.contentText,
    mediaUrl: msg.mediaUrl,
  }
}

async function findOrCreateContact(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
  phone: string,
  pushName?: string,
) {
  // Reuse shared dedupe logic (same as WhatsApp webhook)
  const existing = await findExistingContact(db, accountId, phone)
  if (existing) {
    // Update name if pushName is provided and differs
    if (pushName && pushName !== existing.name) {
      await db
        .from('contacts')
        .update({ name: pushName, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
    return existing
  }

  // Create new contact — use the config owner as the audit user_id
  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: userId,
      phone,
      name: pushName || phone,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      // Race: another webhook call created the contact between our
      // lookup and insert. Re-resolve and return the winning row.
      const raced = await findExistingContact(db, accountId, phone)
      if (raced) return raced
    }
    console.error('[uazapi-webhook] error creating contact:', error.message)
    return null
  }

  return created
}

interface ConversationResult {
  conversation: { id: string; unread_count?: number; source?: string | null }
  created: boolean
}

async function findOrCreateConversation(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<ConversationResult | null> {
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (existing && existing.length > 0) {
    return { conversation: existing[0], created: false }
  }

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
      source: 'uazapi',
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[uazapi-webhook] error creating conversation:', error.message)
    return null
  }

  return { conversation: created, created: true }
}
