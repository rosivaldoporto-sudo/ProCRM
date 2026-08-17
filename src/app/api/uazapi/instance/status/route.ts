import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { instanceStatus } from '@/lib/uazapi/uazapi-client'
import {
  uazapiEnvConfigured,
  uazapiEnvConfig,
  getCachedInstanceToken,
} from '@/lib/uazapi/runtime-config'

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

    if (!uazapiEnvConfigured()) {
      return NextResponse.json({
        connected: false,
        configured: false,
        status: 'disconnected',
        reason: 'env_missing',
        message: 'UAZAPI_SERVER_URL is not set in the environment.',
      })
    }

    const instanceToken = await getCachedInstanceToken(supabase, accountId)
    if (!instanceToken) {
      return NextResponse.json({
        connected: false,
        configured: true,
        status: 'disconnected',
        reason: 'no_instance',
        message: 'Instance not created yet — click Conectar WhatsApp.',
      })
    }

    const env = uazapiEnvConfig()
    const result = await instanceStatus({
      serverUrl: env.serverUrl,
      apiToken: instanceToken,
    })

    // Sync status to DB. The table's CHECK constraint only allows
    // disconnected/connected/qrcode — collapse `connecting` into
    // `qrcode` (a connect attempt is in flight).
    const dbStatus =
      result.status === 'connected'
        ? 'connected'
        : result.status === 'connecting' || result.qrCode
          ? 'qrcode'
          : 'disconnected'

    const { error: upsertError } = await supabase
      .from('uazapi_config')
      .upsert(
        {
          account_id: accountId,
          user_id: user.id,
          status: dbStatus,
          qr_code: result.qrCode || null,
          connected_at: result.status === 'connected' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (upsertError) {
      console.error('[uazapi-status] state upsert failed (send will report not-connected):', upsertError.message)
    }

    return NextResponse.json({
      connected: result.status === 'connected',
      configured: true,
      status: result.status,
      qr_code: result.qrCode || null,
      pairing_code: result.pairingCode || null,
      profile_name: result.profileName || null,
      instance_name: env.instanceName,
    })
  } catch (error) {
    console.error('Error in Uazapi status:', error)
    const message = error instanceof Error ? error.message : 'Failed to get status'
    return NextResponse.json({ connected: false, configured: true, reason: 'uazapi_error', message })
  }
}