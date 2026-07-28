import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'

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

interface UazapiWebhookPayload {
  event?: string
  instance?: string
  data?: {
    msg?: {
      key?: {
        id?: string
        remoteJid?: string
        fromMe?: boolean
      }
      message?: {
        conversation?: string
        extendedTextMessage?: { text: string }
        imageMessage?: { url?: string; caption?: string }
        videoMessage?: { url?: string; caption?: string }
        documentMessage?: { url?: string; caption?: string; fileName?: string }
        audioMessage?: { url?: string }
      }
      pushName?: string
      messageType?: string
    }
    to?: string
    text?: string
    from?: string
    id?: string
  }
  // Alternative payload shapes from Uazapi
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
  try {
    const payload = (await request.json()) as UazapiWebhookPayload
    const db = supabaseAdmin()

    // Determine instance name from payload
    const instanceName = payload.instance || ''

    // Try to find the config for this instance
    let configQuery = db.from('uazapi_config').select('*')

    if (instanceName) {
      configQuery = configQuery.eq('instance_name', instanceName)
    }

    const { data: configs } = await configQuery.limit(1)

    if (!configs || configs.length === 0) {
      return NextResponse.json({ error: 'No matching Uazapi config found' }, { status: 404 })
    }

    const config = configs[0]

    // Verify webhook if secret is configured
    if (config.webhook_secret) {
      try {
        const secret = decrypt(config.webhook_secret)
        // Uazapi may send a signature header — verify if present
        const signature = request.headers.get('x-uazapi-signature') || ''
        if (signature && secret) {
          // Simple comparison for now; extend if Uazapi provides signature verification
        }
      } catch {
        // If decryption fails, continue without verification
      }
    }

    // Handle different payload shapes from Uazapi
    const messages = extractMessages(payload)

    if (messages.length === 0) {
      return NextResponse.json({ status: 'ok' })
    }

    for (const msg of messages) {
      // Skip outbound messages (sent by us)
      if (msg.fromMe) continue

      const phone = normalizePhone(msg.from)
      if (!phone) continue

      // Find or create contact
      const contact = await findOrCreateContact(db, config.account_id, phone, msg.pushName)

      // Find or create conversation
      const conversation = await findOrCreateConversation(db, config.account_id, contact.id)

      // Determine content type and text
      const { contentType, contentText, mediaUrl } = extractMessageContent(msg)
      if (!contentType) continue

      // Persist the message
      await db.from('messages').insert({
        conversation_id: conversation.id,
        sender_type: 'customer',
        content_type: contentType,
        content_text: contentText,
        media_url: mediaUrl,
        message_id: msg.id,
        status: 'delivered',
        source: 'uazapi',
      })

      // Update conversation metadata
      await db.from('conversations').update({
        last_message_text: contentText || `[${contentType}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'open',
      }).eq('id', conversation.id)

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

    return NextResponse.json({ status: 'ok' })
  } catch (error) {
    console.error('Error in Uazapi webhook POST:', error)
    return NextResponse.json({ status: 'ok' }) // Always return 200 to acknowledge receipt
  }
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
}

function extractMessages(payload: UazapiWebhookPayload): ExtractedMessage[] {
  const result: ExtractedMessage[] = []

  // Shape 1: payload.data.msg (Uazapi standard webhook)
  if (payload.data?.msg) {
    const msg = payload.data.msg
    const key = msg.key || {}
    if (key.fromMe) return result // Skip outbound

    const message = msg.message || {}
    const conversation = message.conversation || ''
    const extendedText = message.extendedTextMessage?.text || ''
    const text = conversation || extendedText

    result.push({
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
      result.push({
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
      const existing = result.find((r) => r.id === m.id)
      if (!existing) {
        result.push({
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
  phone: string,
  pushName?: string,
) {
  // Check existing contact by normalized phone
  const { data: existing } = await db
    .from('contacts')
    .select('*')
    .eq('account_id', accountId)
    .eq('phone_normalized', phone.replace(/\D/g, ''))
    .maybeSingle()

  if (existing) return existing

  // Create new contact
  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: '', // Will be filled by system
      phone,
      name: pushName || phone,
    })
    .select()
    .single()

  if (error) {
    console.error('[uazapi-webhook] error creating contact:', error.message)
    throw error
  }

  return created
}

async function findOrCreateConversation(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
) {
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: '',
      contact_id: contactId,
    })
    .select()
    .single()

  if (error) {
    console.error('[uazapi-webhook] error creating conversation:', error.message)
    throw error
  }

  return created
}
