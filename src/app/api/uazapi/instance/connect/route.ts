import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  instanceConnect,
  setInstanceWebhook,
  normalizeQrCode,
} from '@/lib/uazapi/uazapi-client'
import {
  uazapiEnvConfig,
  resolveUazapiInstance,
} from '@/lib/uazapi/runtime-config'

/**
 * POST /api/uazapi/instance/connect
 *
 * Bootstraps + connects the Uazapi instance and returns the QR code
 * the user must scan with WhatsApp. Credentials come from the
 * environment (UAZAPI_SERVER_URL / UAZAPI_ADMIN_TOKEN /
 * UAZAPI_INSTANCE_TOKEN); the instance token is created on the server
 * via /instance/init when needed and cached per account:
 *
 *   1. resolveUazapiInstance() — env token → cached token → /instance/init.
 *   2. POST /instance/connect (token header) → QR code (base64) or,
 *      when UAZAPI_PAIRING_PHONE is set, a 6-digit pairing code.
 *   3. Best-effort: configure the per-account webhook via
 *      /webhook/set so inbound messages start flowing.
 *
 * The QR code is normalized to a `data:image/png;base64,` URL (UAZAPI
 * returns raw base64) and persisted so a reload still shows it while
 * it's valid.
 */
export async function POST(request: Request) {
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
    const { serverUrl, instanceToken } = await resolveUazapiInstance(
      supabase,
      accountId,
      user.id,
    )

    let result = await instanceConnect({
      serverUrl,
      apiToken: instanceToken,
      phone: env.pairingPhone || undefined,
    })

    // Some servers fail the first connect right after init; retry once.
    if (result.status === 'disconnected' && !result.qrCode && !result.pairingCode) {
      result = await instanceConnect({
        serverUrl,
        apiToken: instanceToken,
        phone: env.pairingPhone || undefined,
      })
    }

    const qrCode = result.qrCode ? normalizeQrCode(result.qrCode) : null

    // Persist QR + status so a page reload still shows the pending QR.
    const { error: upsertError } = await supabase
      .from('uazapi_config')
      .upsert(
        {
          account_id: accountId,
          user_id: user.id,
          instance_name: env.instanceName,
          server_url: serverUrl,
          status: result.status === 'connected' ? 'connected' : result.status === 'connecting' || result.qrCode ? 'qrcode' : 'disconnected',
          qr_code: qrCode,
          connected_at: result.status === 'connected' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' },
      )
    if (upsertError) {
      console.error('[uazapi-connect] state upsert failed (send will report not-connected):', upsertError.message)
    }

    // Best-effort webhook registration — never fails the connect.
    if (result.status === 'connected' || result.qrCode || result.pairingCode) {
      try {
        const origin =
          process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin
        await setInstanceWebhook({
          serverUrl,
          apiToken: instanceToken,
          url: `${origin}/api/uazapi/webhook/${accountId}`,
          events: ['messages', 'messages_update', 'connection'],
          excludeMessages: ['wasSentByApi'],
        })
      } catch (err) {
        console.warn(
          '[uazapi-connect] webhook setup skipped (configure manually if needed):',
          err instanceof Error ? err.message : err,
        )
      }
    }

    return NextResponse.json({
      success: true,
      qr_code: qrCode,
      pairing_code: result.pairingCode || null,
      status: result.status,
      profile_name: result.profileName || null,
      instance_name: env.instanceName,
    })
  } catch (error) {
    console.error('[uazapi-connect] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to connect'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}