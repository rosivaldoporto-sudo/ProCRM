import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; message?: string; hint?: string };
  // Postgres undefined_column + PostgREST schema-cache misses all surface
  // when the 038 migration (capi_trigger_stage_ids) hasn't been applied.
  if (e.code === '42703' || e.code === 'PGRST204') return true;
  const msg = `${e.message ?? ''} ${e.hint ?? ''}`.toLowerCase();
  return (
    msg.includes('capi_trigger_stage_ids') ||
    (msg.includes('column') && msg.includes('does not exist'))
  );
}

export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    const admin = supabaseAdmin();
    let data: {
      id: string;
      pixel_id: string | null;
      test_event_code: string | null;
      capi_trigger_stage_ids?: string[] | null;
      access_token: string | null;
    } | null = null;

    const full = await admin
      .from('meta_ads_config')
      .select(
        'id, pixel_id, test_event_code, capi_trigger_stage_ids, access_token'
      )
      .eq('account_id', accountId)
      .maybeSingle();
    if (full.error) {
      if (!isMissingColumnError(full.error)) throw full.error;
      // Fallback for DBs where migration 038 hasn't been applied yet.
      console.error(
        '[meta-ads/config] capi_trigger_stage_ids missing, falling back (apply migration 038):',
        full.error.message
      );
      const legacy = await admin
        .from('meta_ads_config')
        .select('id, pixel_id, test_event_code, access_token')
        .eq('account_id', accountId)
        .maybeSingle();
      if (legacy.error) throw legacy.error;
      data = legacy.data;
    } else {
      data = full.data;
    }
    if (!data) return NextResponse.json({ configured: false });
    if (data.access_token && !data.access_token.includes(':')) {
      try {
        const { error: upgradeError } = await admin
          .from('meta_ads_config')
          .update({ access_token: encrypt(data.access_token) })
          .eq('id', data.id);
        if (upgradeError) throw upgradeError;
      } catch (upgradeErr) {
        // Never break a read because the legacy-token upgrade failed
        // (e.g. missing ENCRYPTION_KEY) — the raw token still works.
        console.error('[meta-ads/config] token upgrade failed:', upgradeErr);
      }
    }
    return NextResponse.json({
      configured: true,
      id: data.id,
      pixel_id: data.pixel_id,
      test_event_code: data.test_event_code,
      capi_trigger_stage_ids: data.capi_trigger_stage_ids ?? [],
      has_access_token: !!data.access_token,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `meta-ads-config:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const pixelId =
      typeof body.pixel_id === 'string' ? body.pixel_id.trim() : '';
    const rawToken =
      typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const testEventCode =
      typeof body.test_event_code === 'string'
        ? body.test_event_code.trim()
        : '';
    const stageIds = Array.isArray(body.capi_trigger_stage_ids)
      ? [
          ...new Set(
            body.capi_trigger_stage_ids.filter(
              (id: unknown): id is string => typeof id === 'string'
            )
          ),
        ]
      : [];

    if (pixelId && !/^\d{5,30}$/.test(pixelId)) return bad('Invalid pixel_id');
    if (
      rawToken.length > 4096 ||
      testEventCode.length > 200 ||
      stageIds.length > 100
    ) {
      return bad('Configuration value exceeds its allowed size');
    }

    if (stageIds.length) {
      const { data: stages, error: stagesError } = await supabaseAdmin()
        .from('pipeline_stages')
        .select('id, pipelines!inner(account_id)')
        .in('id', stageIds)
        .eq('pipelines.account_id', accountId);
      if (stagesError) throw stagesError;
      if (!stages || stages.length !== stageIds.length) {
        return bad('Every trigger stage must belong to this account');
      }
    }

    const admin = supabaseAdmin();
    const { data: existing, error: existingError } = await admin
      .from('meta_ads_config')
      .select('id, access_token')
      .eq('account_id', accountId)
      .maybeSingle();
    if (existingError) throw existingError;

    if (!rawToken && !existing?.access_token && pixelId) {
      return bad('access_token is required');
    }

    const values: Record<string, unknown> = {
      account_id: accountId,
      pixel_id: pixelId || null,
      test_event_code: testEventCode || null,
      capi_trigger_stage_ids: stageIds,
      updated_at: new Date().toISOString(),
    };
    if (rawToken) {
      values.access_token = encrypt(rawToken);
    } else if (existing?.access_token && !existing.access_token.includes(':')) {
      // Transparently upgrade rows written by the old browser-side form,
      // which stored the Meta token as plaintext.
      values.access_token = encrypt(existing.access_token);
    }

    const query = existing
      ? admin.from('meta_ads_config').update(values).eq('id', existing.id)
      : admin.from('meta_ads_config').insert(values);
    const { error } = await query;
    if (error) {
      // DBs behind migration 038 have no capi_trigger_stage_ids column —
      // retry without it instead of failing the whole save.
      if (stageIds.length >= 0 && isMissingColumnError(error)) {
        console.error(
          '[meta-ads/config] save fallback without capi_trigger_stage_ids (apply migration 038):',
          error.message
        );
        const { capi_trigger_stage_ids: _dropped, ...legacyValues } = values;
        void _dropped;
        const retry = existing
          ? await admin
              .from('meta_ads_config')
              .update(legacyValues)
              .eq('id', existing.id)
          : await admin.from('meta_ads_config').insert(legacyValues);
        if (retry.error) throw retry.error;
        return NextResponse.json({
          success: true,
          warning: 'capi_trigger_stage_ids_unsupported',
        });
      }
      throw error;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
