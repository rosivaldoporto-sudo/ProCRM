import { after, NextResponse } from 'next/server';
import { fireQualifiedLeadEvent } from '@/lib/facebook/qualified-lead';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkDistributedRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

interface DealRow {
  account_id: string;
  contact_id: string | null;
  pipeline_id: string;
  stage_id: string;
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
    const ctx = await requireRole('agent');
    const limit = await checkDistributedRateLimit(
      `capi:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body: { dealId?: string; newStageId?: string } = await request.json();
    const { dealId, newStageId } = body;

    if (!dealId || !newStageId) {
      return NextResponse.json(
        { error: 'dealId and newStageId are required' },
        { status: 400 }
      );
    }

    const { data: rawDeal, error: dealError } = await supabaseAdmin()
      .from('deals')
      .select('account_id, contact_id, pipeline_id, stage_id')
      .eq('id', dealId)
      .eq('account_id', ctx.accountId)
      .single();

    const deal = rawDeal as DealRow | null;
    if (dealError || !deal) {
      return NextResponse.json({ error: 'Deal not found' }, { status: 404 });
    }

    if (deal.stage_id !== newStageId) {
      return NextResponse.json(
        { error: 'Deal is not currently in the supplied stage' },
        { status: 409 }
      );
    }
    const { data: stage } = await supabaseAdmin()
      .from('pipeline_stages')
      .select('id, name')
      .eq('id', newStageId)
      .eq('pipeline_id', deal.pipeline_id)
      .maybeSingle();
    if (!stage) {
      return NextResponse.json(
        { error: 'Invalid pipeline stage' },
        { status: 400 }
      );
    }

    after(async () => {
      try {
        await fireQualifiedLeadEvent(
          supabaseAdmin(),
          deal.account_id,
          dealId,
          deal.contact_id,
          newStageId,
          stage.name
        );
      } catch (err) {
        console.error('[capi] qualified-lead event failed:', err);
      }
    });

    return NextResponse.json({ status: 'accepted' }, { status: 202 });
  } catch (err) {
    const authResponse = toErrorResponse(err);
    if (authResponse.status !== 500) return authResponse;
    console.error('[capi] qualified-lead endpoint error:', err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
