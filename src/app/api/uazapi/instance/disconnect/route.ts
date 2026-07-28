import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { instanceDisconnect } from '@/lib/uazapi/uazapi-client'

export async function POST() {
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
      .single()

    if (!config) {
      return NextResponse.json({ error: 'Uazapi not configured.' }, { status: 400 })
    }

    let apiToken: string
    try {
      apiToken = decrypt(config.api_token)
    } catch {
      return NextResponse.json({ error: 'Stored API token is corrupted.' }, { status: 500 })
    }

    await instanceDisconnect({
      serverUrl: config.server_url,
      apiToken,
    })

    // Reset status
    await supabase
      .from('uazapi_config')
      .update({
        status: 'disconnected',
        qr_code: null,
        connected_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Uazapi disconnect:', error)
    const message = error instanceof Error ? error.message : 'Failed to disconnect'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
