import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { instanceDisconnect } from '@/lib/uazapi/uazapi-client'
import { uazapiEnvConfig, getCachedInstanceToken } from '@/lib/uazapi/runtime-config'

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

    const env = uazapiEnvConfig()
    if (!env.serverUrl) {
      return NextResponse.json({ error: 'UAZAPI_SERVER_URL is not set in the environment.' }, { status: 400 })
    }

    const instanceToken = await getCachedInstanceToken(supabase, accountId)
    if (!instanceToken) {
      return NextResponse.json({ error: 'Uazapi instance not created yet.' }, { status: 400 })
    }

    await instanceDisconnect({
      serverUrl: env.serverUrl,
      apiToken: instanceToken,
    })

    // Reset status (the config row is only a state cache now).
    await supabaseAdmin()
      .from('uazapi_config')
      .upsert(
        {
          account_id: accountId,
          user_id: user.id,
          status: 'disconnected',
          qr_code: null,
          connected_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Uazapi disconnect:', error)
    const message = error instanceof Error ? error.message : 'Failed to disconnect'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}