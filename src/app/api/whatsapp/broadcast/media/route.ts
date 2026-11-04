// ============================================================
// POST /api/whatsapp/broadcast/media
//
// Prepares a campaign's header media before anything is sent: uploads
// the file to Meta once (or reuses the cached id) and returns the media
// id every batch of the campaign will reference. If this fails the
// caller stops, so a failure costs one download instead of one per
// recipient.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  MEDIA_UNAVAILABLE_ERROR,
  resolveMetaMediaId,
} from '@/lib/whatsapp/media-id-resolver'

// A cache miss downloads the file and uploads it to Meta in this request.
export const maxDuration = 120

const MAX_URL_LENGTH = 2048
const HEADER_MEDIA_KINDS = ['image', 'video', 'document'] as const
type HeaderMediaKind = (typeof HEADER_MEDIA_KINDS)[number]

function isHeaderMediaKind(value: unknown): value is HeaderMediaKind {
  return HEADER_MEDIA_KINDS.includes(value as HeaderMediaKind)
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')

    const limit = checkRateLimit(
      `broadcast-media:${ctx.userId}`,
      RATE_LIMITS.broadcast
    )
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const url = typeof body?.url === 'string' ? body.url.trim() : ''
    const kind = body?.kind
    if (!url || url.length > MAX_URL_LENGTH || !isHeaderMediaKind(kind)) {
      return NextResponse.json(
        { error: 'Informe a URL e o tipo da mídia do cabeçalho' },
        { status: 400 }
      )
    }

    const admin = supabaseAdmin()
    const { data: config, error: configError } = await admin
      .from('whatsapp_config')
      .select('phone_number_id, access_token')
      .eq('account_id', ctx.accountId)
      .single()
    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp não configurado. Configure sua integração com o WhatsApp primeiro.',
        },
        { status: 400 }
      )
    }

    const mediaId = await resolveMetaMediaId({
      db: admin,
      accountId: ctx.accountId,
      phoneNumberId: config.phone_number_id,
      accessToken: decrypt(config.access_token),
      sourceUrl: url,
      kind,
    })
    if (!mediaId) {
      return NextResponse.json({ error: MEDIA_UNAVAILABLE_ERROR }, { status: 502 })
    }

    return NextResponse.json({ media_id: mediaId })
  } catch (err) {
    return toErrorResponse(err)
  }
}
