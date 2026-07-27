import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { fireQualifiedLeadEvent } from '@/lib/facebook/qualified-lead'

let _adminClient: ReturnType<typeof createClient> | null = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

interface DealRow {
  account_id: string
  contact_id: string | null
}

/**
 * POST /api/v1/capi/qualified-lead
 *
 * Fire-and-forget endpoint called by the pipelines page when a
 * deal's stage changes. Checks the account's meta_ads_config and
 * dispatches a CAPI "Lead" event if the new stage is in the
 * configured trigger list.
 *
 * Body: { dealId, newStageId, stageName? }
 *
 * Always returns 202 (Accepted) — the caller doesn't wait for
 * the Meta API round-trip.
 */
export async function POST(request: Request) {
  try {
    const body: { dealId?: string; newStageId?: string; stageName?: string } =
      await request.json()
    const { dealId, newStageId, stageName } = body

    if (!dealId || !newStageId) {
      return NextResponse.json(
        { error: 'dealId and newStageId are required' },
        { status: 400 },
      )
    }

    const { data: rawDeal, error: dealError } = await supabaseAdmin()
      .from('deals')
      .select('account_id, contact_id')
      .eq('id', dealId)
      .single()

    const deal = rawDeal as DealRow | null
    if (dealError || !deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 })
    }

    fireQualifiedLeadEvent(
      supabaseAdmin(),
      deal.account_id,
      dealId,
      deal.contact_id,
      newStageId,
      stageName,
    ).catch((err) =>
      console.error('[capi] qualified-lead event failed:', err),
    )

    return NextResponse.json({ status: 'accepted' }, { status: 202 })
  } catch (err) {
    console.error('[capi] qualified-lead endpoint error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}
