import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { instanceStatus } from '@/lib/uazapi/uazapi-client'

export async function GET() {
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
      return NextResponse.json({ connected: false, reason: 'no_config', message: 'Uazapi not configured.' })
    }

    let apiToken: string
    try {
      apiToken = decrypt(config.api_token)
    } catch {
      return NextResponse.json({ connected: false, reason: 'token_corrupted', message: 'Stored API token is corrupted.' })
    }

    const result = await instanceStatus({
      serverUrl: config.server_url,
      apiToken,
    })

    // Sync status to DB
    await supabase
      .from('uazapi_config')
      .update({
        status: result.status,
        qr_code: result.qrCode || null,
        connected_at: result.status === 'connected' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    return NextResponse.json({
      connected: result.status === 'connected',
      status: result.status,
      qr_code: result.qrCode || null,
      instance_name: config.instance_name,
    })
  } catch (error) {
    console.error('Error in Uazapi status:', error)
    const message = error instanceof Error ? error.message : 'Failed to get status'
    return NextResponse.json({ connected: false, reason: 'uazapi_error', message })
  }
}
