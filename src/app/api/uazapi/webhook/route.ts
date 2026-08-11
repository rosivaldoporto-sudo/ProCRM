import { handleWebhook } from '@/lib/uazapi/webhook-handler'

export const maxDuration = 60

/**
 * GET /api/uazapi/webhook
 *
 * Legacy URL (no account id) — some Uazapi implementations use GET for
 * webhook verification. New installations should use the per-account URL
 * /api/uazapi/webhook/[accountId] shown in the settings page.
 */
export async function GET(request: Request) {
  return handleWebhook(request)
}

/**
 * POST /api/uazapi/webhook
 *
 * Legacy webhook endpoint (backward compatible). Resolves the Uazapi
 * config from the payload (owner/token) or from the single-config
 * fallback. New accounts should configure the per-account URL
 * /api/uazapi/webhook/[accountId] instead.
 */
export async function POST(request: Request) {
  return handleWebhook(request)
}
