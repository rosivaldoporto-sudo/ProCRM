import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { instanceDisconnect, instanceStatus } from '@/lib/uazapi/uazapi-client'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

/**
 * GET /api/uazapi/config
 *
 * Returns the saved Uazapi config and connection status.
 */
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ connected: false, reason: 'no_account', message: 'Profile not linked to an account.' }, { status: 200 })
    }

    const { data: config, error: configError } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (configError) {
      return NextResponse.json({ connected: false, reason: 'db_error', message: 'Failed to fetch configuration' }, { status: 200 })
    }

    if (!config) {
      return NextResponse.json({ connected: false, reason: 'no_config', message: 'No Uazapi configuration saved yet.' }, { status: 200 })
    }

    // Verify connection by checking instance status
    let apiToken: string
    try {
      apiToken = decrypt(config.api_token)
    } catch {
      return NextResponse.json({ connected: false, reason: 'token_corrupted', needs_reset: true, message: 'Stored API token cannot be decrypted.' }, { status: 200 })
    }

    try {
      const statusResult = await instanceStatus({
        serverUrl: config.server_url,
        apiToken,
      })
      return NextResponse.json({
        connected: statusResult.status === 'connected',
        status: statusResult.status,
        instance_name: config.instance_name,
        server_url: config.server_url,
        qr_code: statusResult.qrCode || config.qr_code,
      })
    } catch {
      return NextResponse.json({ connected: false, reason: 'uazapi_error', message: 'Could not reach the Uazapi server. Check the server URL and API token.' }, { status: 200 })
    }
  } catch (error) {
    console.error('Error in Uazapi config GET:', error)
    return NextResponse.json({ connected: false, reason: 'unknown', message: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/uazapi/config
 *
 * Saves or updates the Uazapi config and optionally connects the instance.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    const body = await request.json()
    const { instance_name, server_url, webhook_secret } = body
    let { api_token } = body

    if (!instance_name || !server_url) {
      return NextResponse.json({ error: 'instance_name and server_url are required' }, { status: 400 })
    }

    // If no api_token was sent but there's an existing config, decrypt
    // the stored token so the user can update e.g. server_url without
    // having to re-enter the API token.
    if (!api_token) {
      const { data: existingRow } = await supabase
        .from('uazapi_config')
        .select('api_token')
        .eq('account_id', accountId)
        .maybeSingle()

      if (existingRow?.api_token) {
        try {
          api_token = decrypt(existingRow.api_token)
        } catch {
          return NextResponse.json(
            { error: 'Stored API token is corrupted. Please re-enter it manually.' },
            { status: 400 }
          )
        }
      } else {
        return NextResponse.json({ error: 'api_token is required for initial setup' }, { status: 400 })
      }
    }

    // Encrypt sensitive data
    let encryptedApiToken: string
    let encryptedWebhookSecret: string | null = null
    try {
      encryptedApiToken = encrypt(api_token)
      encryptedWebhookSecret = webhook_secret ? encrypt(webhook_secret) : null
    } catch {
      return NextResponse.json({ error: 'Failed to encrypt token. Check ENCRYPTION_KEY.' }, { status: 500 })
    }

    // Check for existing config
    const { data: existing } = await supabase
      .from('uazapi_config')
      .select('id, status')
      .eq('account_id', accountId)
      .maybeSingle()

    const baseRow = {
      instance_name,
      server_url,
      api_token: encryptedApiToken,
      webhook_secret: encryptedWebhookSecret,
      status: existing?.status || 'disconnected',
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      const { error: updateError } = await supabase
        .from('uazapi_config')
        .update(baseRow)
        .eq('account_id', accountId)
      if (updateError) {
        return NextResponse.json({ error: 'Failed to update configuration' }, { status: 500 })
      }
    } else {
      const { error: insertError } = await supabase
        .from('uazapi_config')
        .insert({ account_id: accountId, user_id: user.id, ...baseRow })
      if (insertError) {
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, saved: true })
  } catch (error) {
    console.error('Error in Uazapi config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/uazapi/config
 *
 * Removes the Uazapi config.
 */
export async function DELETE() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json({ error: 'Profile not linked to an account.' }, { status: 403 })
    }

    // Disconnect instance first
    const { data: config } = await supabase
      .from('uazapi_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (config) {
      try {
        const apiToken = decrypt(config.api_token)
        await instanceDisconnect({
          serverUrl: config.server_url,
          apiToken,
        })
      } catch {
        // Best-effort disconnect
      }
    }

    const { error: deleteError } = await supabase
      .from('uazapi_config')
      .delete()
      .eq('account_id', accountId)

    if (deleteError) {
      return NextResponse.json({ error: 'Failed to delete configuration' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in Uazapi config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
