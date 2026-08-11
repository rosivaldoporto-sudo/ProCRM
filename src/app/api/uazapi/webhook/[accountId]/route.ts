import { handleWebhook } from '@/lib/uazapi/webhook-handler'

export const maxDuration = 60

/**
 * GET /api/uazapi/webhook/[accountId]
 *
 * Per-account webhook URL — each CRM account gets its own unique
 * callback URL. Some Uazapi implementations use GET for webhook
 * verification.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  return handleWebhook(request, accountId)
}

/**
 * POST /api/uazapi/webhook/[accountId]
 *
 * Per-account webhook endpoint. The account id in the URL resolves the
 * uazapi_config row deterministically, so every account configured in
 * the CRM has its own unique webhook callback URL.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
) {
  const { accountId } = await params
  return handleWebhook(request, accountId)
}