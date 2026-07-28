import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError,
} from '@/lib/whatsapp/send-message'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { resolveAuditUserId } from '@/lib/api/v1/contacts'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      phone,
      name,
      source: channelSource,
      template_name,
      template_language,
      template_params,
    } = body

    if (!phone) {
      return NextResponse.json(
        { error: 'Phone is required' },
        { status: 400 }
      )
    }

    // When source is 'uazapi', just create conversation (no template send)
    if (channelSource === 'uazapi') {
      const sanitized = sanitizePhoneForMeta(phone)
      if (!isValidE164(sanitized)) {
        return NextResponse.json(
          { error: 'Phone must be in E.164 format (e.g. +5511999999999)' },
          { status: 400 }
        )
      }

      const ownerUserId = await resolveAuditUserId(supabase, accountId)

      // Find or create contact
      let contactId: string
      let contactCreated = false
      const existing = await findExistingContact(supabase, accountId, sanitized)
      if (existing) {
        contactId = existing.id
        if (name && name !== existing.name) {
          await supabase
            .from('contacts')
            .update({ name, updated_at: new Date().toISOString() })
            .eq('id', existing.id)
        }
      } else {
        const { data: created, error: createErr } = await supabase
          .from('contacts')
          .insert({
            account_id: accountId,
            user_id: ownerUserId,
            phone: sanitized,
            name: name || sanitized,
          })
          .select('id')
          .single()
        if (createErr || !created) {
          if (isUniqueViolation(createErr)) {
            const raced = await findExistingContact(supabase, accountId, sanitized)
            if (raced) { contactId = raced.id } else { throw new Error('Failed to create contact') }
          } else {
            throw createErr
          }
        } else {
          contactId = created.id
          contactCreated = true
        }
      }

      // Find or create conversation with source='uazapi'
      const convId = await findOrCreateConversationUazapi(supabase, accountId, contactId, ownerUserId)

      return NextResponse.json({
        success: true,
        conversation_id: convId,
        contact_id: contactId,
        contact_created: contactCreated,
      })
    }

    // Default (whatsapp): existing behavior — validate template, resolve, send
    if (!template_name) {
      return NextResponse.json(
        { error: 'Phone and template_name are required' },
        { status: 400 }
      )
    }

    try {
      validateSendMessageParams({
        messageType: 'template',
        templateName: template_name,
      })
    } catch (err) {
      if (err instanceof SendMessageError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    const resolved = await resolveConversationByPhone(
      supabase,
      accountId,
      phone,
      name || null
    )

    const result = await sendMessageToConversation(supabase, accountId, {
      conversationId: resolved.conversationId,
      messageType: 'template',
      templateName: template_name,
      templateLanguage: template_language,
      templateParams: template_params || [],
    })

    return NextResponse.json({
      success: true,
      conversation_id: resolved.conversationId,
      contact_id: resolved.contactId,
      contact_created: resolved.contactCreated,
      message_id: result.messageId,
      whatsapp_message_id: result.whatsappMessageId,
    })
  } catch (err) {
    if (err instanceof SendMessageError) {
      return NextResponse.json(
        { error: err.message },
        { status: err.status }
      )
    }
    console.error('Error in start-conversation POST:', err)
    return NextResponse.json(
      { error: 'Failed to start conversation' },
      { status: 500 }
    )
  }
}

async function findOrCreateConversationUazapi(
  db: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  contactId: string,
  ownerUserId: string,
): Promise<string> {
  const { data: existing } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (existing && existing.length > 0) {
    return existing[0].id
  }

  const { data: newConv, error: convErr } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      source: 'uazapi',
    })
    .select('id')
    .single()

  if (convErr || !newConv) {
    if (isUniqueViolation(convErr)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) return raced[0].id
    }
    console.error('[start-conversation] uazapi conversation create error:', convErr)
    throw new Error('Failed to create conversation')
  }

  return newConv.id
}
