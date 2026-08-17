import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import {
  instanceConnect,
  instanceInit,
  instanceStatus,
  setInstanceWebhook,
  normalizeQrCode,
} from '@/lib/uazapi/uazapi-client'

/**
 * POST /api/uazapi/instance/connect
 *
 * Bootstraps + connects the Uazapi instance and returns the QR code
 * the user must scan with WhatsApp:
 *
 *   1. Instance token (api_token) — used for connect/status/send.
 *      If missing, it is created on the server via /instance/init
 *      using the stored ADMIN token (admintoken header), then saved.
 *   2. POST /instance/connect (token header) → QR code (base64) or,
 *      when a pairing phone is configured, a 6-digit pairing code.
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

    const { data: config } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (!config) {
      return NextResponse.json({ error: 'Uazapi not configured.' }, { status: 400 })
    }

    let instanceToken: string
    try {
      instanceToken = decrypt(config.api_token)
    } catch {
      instanceToken = ''
    }

    let adminToken: string | undefined
    try {
      adminToken = config.admin_token ? decrypt(config.admin_token) : undefined
    } catch {
      adminToken = undefined
    }

    // The instance may need (re)creating: no usable instance token,
    // or the stored one was rejected by the server.
    async function ensureInstanceToken(): Promise<string> {
      if (instanceToken) {
        // Probe the token first — if the instance exists and the token
        // works, keep it. A failed probe with an admin token falls
        // through to a fresh /instance/init below.
        try {
          await instanceStatus({ serverUrl: config.server_url, apiToken: instanceToken })
          return instanceToken
        } catch {
          // token invalid / instance deleted — recreate if possible
        }
      }
      if (!adminToken) {
        throw new Error(
          'No valid instance token. Paste the instance token (or the admin token) in the Uazapi settings first.',
        )
      }
      const created = await instanceInit({
        serverUrl: config.server_url,
        adminToken,
        name: config.instance_name,
      })
      await supabase
        .from('uazapi_config')
        .update({
          api_token: encrypt(created.token),
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
      return created.token
    }

    const token = await ensureInstanceToken()

    let result = await instanceConnect({
      serverUrl: config.server_url,
      apiToken: token,
      phone: config.pairing_phone || undefined,
    })

    // Some servers fail the first connect right after init; retry once.
    if (result.status === 'disconnected' && !result.qrCode && !result.pairingCode) {
      result = await instanceConnect({
        serverUrl: config.server_url,
        apiToken: token,
        phone: config.pairing_phone || undefined,
      })
    }

    const qrCode = result.qrCode ? normalizeQrCode(result.qrCode) : null

    // Persist QR + status so a page reload still shows the pending QR.
    await supabase
      .from('uazapi_config')
      .update({
        status: result.status === 'connected' ? 'connected' : result.status === 'connecting' || result.qrCode ? 'qrcode' : 'disconnected',
        qr_code: qrCode,
        connected_at: result.status === 'connected' ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId)

    // Best-effort webhook registration — never fails the connect.
    if (result.status === 'connected' || result.qrCode || result.pairingCode) {
      try {
        const origin =
          process.env.NEXT_PUBLIC_SITE_URL?.trim() || new URL(request.url).origin
        await setInstanceWebhook({
          serverUrl: config.server_url,
          apiToken: token,
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
      instance_name: config.instance_name,
    })
  } catch (error) {
    console.error('[uazapi-connect] Error:', error)
    const message = error instanceof Error ? error.message : 'Failed to connect'
    return NextResponse.json({ error: message }, { status: 502 })
  }
}