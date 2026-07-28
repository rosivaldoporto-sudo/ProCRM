import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  sendMessageToConversation,
  validateUazapiSendParams,
  UazapiSendError,
} from '@/lib/uazapi/uazapi-send'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`uazapi-send:${user.id}`, RATE_LIMITS.send)
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
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    const body = await request.json()
    const {
      conversation_id: conversationIdInput,
      contact_id,
      message_type,
      content_text,
      media_url,
      filename,
      menu_rows,
      menu_title,
      menu_footer,
      reply_to_message_id,
    } = body

    if ((!conversationIdInput && !contact_id) || !message_type) {
      return NextResponse.json({
        error: 'Either conversation_id or contact_id, plus message_type, are required',
      }, { status: 400 })
    }

    try {
      validateUazapiSendParams({
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        menuRows: menu_rows,
      })
    } catch (err) {
      if (err instanceof UazapiSendError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }

    // Resolve conversation
    let conversationId: string | null = null

    if (conversationIdInput) {
      const { data, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('id', conversationIdInput)
        .eq('account_id', accountId)
        .single()

      if (convError || !data) {
        return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
      }
      conversationId = data.id
    } else {
      const { data: contactRow } = await supabase
        .from('contacts')
        .select('id')
        .eq('id', contact_id)
        .eq('account_id', accountId)
        .maybeSingle()

      if (!contactRow) {
        return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
      }

      const resolved = await findOrCreateConversation(supabase, accountId, user.id, contact_id)
      if (!resolved) {
        return NextResponse.json({ error: 'Failed to open a conversation' }, { status: 500 })
      }
      conversationId = resolved
    }

    if (!conversationId) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    try {
      const result = await sendMessageToConversation(supabase, accountId, {
        conversationId,
        messageType: message_type,
        contentText: content_text,
        mediaUrl: media_url,
        filename,
        menuRows: menu_rows,
        menuTitle: menu_title,
        menuFooter: menu_footer,
        replyToMessageId: reply_to_message_id,
      })

      return NextResponse.json({
        success: true,
        message_id: result.messageId,
        uazapi_message_id: result.uazapiMessageId,
      })
    } catch (err) {
      if (err instanceof UazapiSendError) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      throw err
    }
  } catch (error) {
    console.error('Error in Uazapi send POST:', error)
    return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  }
}

type SendSupabase = Awaited<ReturnType<typeof createClient>>

async function findOrCreateConversation(
  supabase: SendSupabase,
  accountId: string,
  userId: string,
  contactId: string,
): Promise<string | null> {
  const { data: existing } = await supabase
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle()

  if (existing) return existing.id

  const { data: created, error } = await supabase
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      contact_id: contactId,
    })
    .select('id')
    .single()

  if (error) {
    console.error('Error creating conversation:', error.message)
    return null
  }

  return created.id
}
