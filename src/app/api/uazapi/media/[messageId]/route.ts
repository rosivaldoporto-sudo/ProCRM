import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { downloadMessageFile } from '@/lib/uazapi/uazapi-client'

/**
 * GET /api/uazapi/media/[messageId]
 *
 * Authenticated proxy that streams the bytes of a received Uazapi media
 * message. Uazapi file URLs are private (require the instance `token`
 * header) and frequently expire, so the browser can't load them
 * directly — this endpoint resolves the link and downloads the file
 * server-side, exactly like /api/whatsapp/media/:id does for Meta.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ messageId: string }> }
) {
  try {
    const { messageId } = await params

    if (!messageId) {
      return NextResponse.json(
        { error: 'Message ID is required' },
        { status: 400 }
      )
    }

    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account — teammates share the account's
    // Uazapi config, so look it up by account_id like the WhatsApp
    // media proxy does.
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

    // The message must belong to this account's inbox — never proxy
    // arbitrary ids. message_id is intentionally non-unique (036), so
    // cap at one row instead of using maybeSingle.
    const { data: messageRow } = await supabase
      .from('messages')
      .select('message_id, conversations!inner(account_id)')
      .eq('message_id', messageId)
      .eq('conversations.account_id', accountId)
      .limit(1)
      .maybeSingle()

    if (!messageRow) {
      return NextResponse.json(
        { error: 'Message not found in your inbox' },
        { status: 404 },
      )
    }

    const { data: config } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config) {
      return NextResponse.json(
        { error: 'Uazapi not configured' },
        { status: 400 },
      )
    }

    const file = await downloadMessageFile({
      serverUrl: config.server_url,
      apiToken: decrypt(config.api_token),
      messageId,
    })

    if (!file) {
      return NextResponse.json(
        { error: 'Failed to fetch media from Uazapi' },
        { status: 502 },
      )
    }

    return new Response(new Uint8Array(file.buffer), {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    })
  } catch (error) {
    console.error('Error in Uazapi media GET:', error)
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    )
  }
}
