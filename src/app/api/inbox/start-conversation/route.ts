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
      template_name,
      template_language,
      template_params,
    } = body

    if (!phone || !template_name) {
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
