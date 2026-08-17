import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { instanceInit, instanceStatus } from '@/lib/uazapi/uazapi-client'

// ============================================================
// Uazapi runtime configuration
//
// Source of truth for UAZAPI credentials is the environment, not the
// database and not the settings UI:
//
//   UAZAPI_SERVER_URL       — Uazapi server base URL (required)
//   UAZAPI_ADMIN_TOKEN      — admin token, used to CREATE the instance
//                             automatically via /instance/init when no
//                             instance token exists (required unless
//                             UAZAPI_INSTANCE_TOKEN is set)
//   UAZAPI_INSTANCE_TOKEN   — token of an existing instance (optional;
//                             takes precedence over the DB cache)
//   UAZAPI_INSTANCE_NAME    — instance name to create (default
//                             "crm-whatsapp")
//   UAZAPI_WEBHOOK_SECRET   — optional shared secret for webhook
//                             verification
//   UAZAPI_PAIRING_PHONE    — optional phone (E.164) to pair via a
//                             6-digit code instead of a QR code
//
// The uazapi_config table is kept ONLY as a per-account runtime-state
// cache: the auto-created instance token (encrypted), connection
// status, pending QR code and connected_at. server_url / admin_token
// never touch the database.
// ============================================================

export interface UazapiRuntimeConfig {
  serverUrl: string
  adminToken?: string
  instanceToken?: string
  instanceName: string
  webhookSecret?: string
  pairingPhone?: string
}

export function uazapiEnvConfig(): UazapiRuntimeConfig {
  const serverUrl = (process.env.UAZAPI_SERVER_URL || '').trim().replace(/\/+$/, '')
  return {
    serverUrl,
    adminToken: process.env.UAZAPI_ADMIN_TOKEN?.trim() || undefined,
    instanceToken: process.env.UAZAPI_INSTANCE_TOKEN?.trim() || undefined,
    instanceName: (process.env.UAZAPI_INSTANCE_NAME || 'crm-whatsapp').trim(),
    webhookSecret: process.env.UAZAPI_WEBHOOK_SECRET?.trim() || undefined,
    pairingPhone: process.env.UAZAPI_PAIRING_PHONE?.trim() || undefined,
  }
}

/** True when the UAZAPI server URL is configured in the environment. */
export function uazapiEnvConfigured(): boolean {
  return !!uazapiEnvConfig().serverUrl
}

/**
 * Resolve the instance token for an account: the UAZAPI_INSTANCE_TOKEN
 * env var wins; otherwise the per-account cache row (auto-created
 * token) is decrypted. Returns null when neither exists.
 */
export async function getCachedInstanceToken(
  db: SupabaseClient,
  accountId: string,
): Promise<string | null> {
  const env = uazapiEnvConfig()
  if (env.instanceToken) return env.instanceToken
  const { data } = await db
    .from('uazapi_config')
    .select('api_token')
    .eq('account_id', accountId)
    .maybeSingle()
  if (!data?.api_token) return null
  try {
    return decrypt(data.api_token)
  } catch {
    return null
  }
}

export interface ResolvedUazapiInstance {
  serverUrl: string
  instanceToken: string
}

/**
 * Resolve (or bootstrap) the Uazapi instance for an account:
 *   1. Env instance token → validated live.
 *   2. Cached instance token (DB) → validated live.
 *   3. Create via /instance/init with UAZAPI_ADMIN_TOKEN and cache the
 *      generated instance token in uazapi_config.
 *
 * Throws a clear error when neither an instance token nor an admin
 * token is configured.
 */
export async function resolveUazapiInstance(
  db: SupabaseClient,
  accountId: string,
  userId?: string,
): Promise<ResolvedUazapiInstance> {
  const env = uazapiEnvConfig()
  if (!env.serverUrl) {
    throw new Error('UAZAPI_SERVER_URL is not set in the environment.')
  }

  const cached = await getCachedInstanceToken(db, accountId)
  if (cached) {
    try {
      await instanceStatus({ serverUrl: env.serverUrl, apiToken: cached })
      return { serverUrl: env.serverUrl, instanceToken: cached }
    } catch {
      // Token invalid / instance deleted — recreate below.
    }
  }

  if (!env.adminToken) {
    throw new Error(
      'No Uazapi instance token available. Set UAZAPI_INSTANCE_TOKEN or UAZAPI_ADMIN_TOKEN in the environment.',
    )
  }

  const created = await instanceInit({
    serverUrl: env.serverUrl,
    adminToken: env.adminToken,
    name: env.instanceName,
  })

  const row: Record<string, unknown> = {
    account_id: accountId,
    instance_name: env.instanceName,
    server_url: env.serverUrl,
    api_token: encrypt(created.token),
    status: 'disconnected',
    updated_at: new Date().toISOString(),
  }
  if (userId) row.user_id = userId
  await db.from('uazapi_config').upsert(row, { onConflict: 'account_id' })

  return { serverUrl: env.serverUrl, instanceToken: created.token }
}