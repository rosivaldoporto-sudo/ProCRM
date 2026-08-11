import { handleWebhook } from '@/lib/whatsapp/webhook-handler'

export const maxDuration = 60

/**
 * GET /api/whatsapp/webhook
 *
 * Legacy URL (no account id) — Meta webhook verification. Checks the
 * verify token against every whatsapp_config row. New installations
 * should use the per-account URL /api/whatsapp/webhook/[accountId]
 * shown in the settings page.
 */
export async function GET(request: Request) {
  return handleWebhook(request)
}

/**
 * POST /api/whatsapp/webhook
 *
 * Legacy webhook endpoint (backward compatible). Resolves the account
 * config from the payload's phone_number_id. New accounts should
 * configure the per-account URL /api/whatsapp/webhook/[accountId]
 * instead.
 */
export async function POST(request: Request) {
  return handleWebhook(request)
}