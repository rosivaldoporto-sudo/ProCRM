import { handleWebhook } from '@/lib/whatsapp/webhook-handler'

export const maxDuration = 60

/**
 * GET /api/whatsapp/webhook/[accountId]
 *
 * Per-account webhook URL — each CRM account gets its own unique
 * callback URL. Meta webhook verification against this account's
 * verify token.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  return handleWebhook(request, accountId)
}

/**
 * POST /api/whatsapp/webhook/[accountId]
 *
 * Per-account webhook endpoint. The account id in the URL resolves the
 * whatsapp_config row deterministically, so every account configured
 * in the CRM has its own unique webhook callback URL.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  return handleWebhook(request, accountId)
}