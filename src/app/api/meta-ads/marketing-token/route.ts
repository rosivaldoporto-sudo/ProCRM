import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { checkMarketingToken } from '@/lib/facebook/ctwa-ads';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

// Token com ads_read para ler os nomes de campanha, conjunto e anúncio
// dos leads que chegam por anúncio (src/lib/facebook/ctwa-ads.ts).
// Fica criptografado em meta_ads_config.marketing_access_token
// (migration 065) e nunca volta para o navegador.

const MIGRATION_MISSING =
  'Aplique a migration 065_ad_names_lookup.sql no Supabase para salvar o token.';

function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'PGRST204' || code === '42703';
}

export async function GET() {
  try {
    const { accountId } = await requireRole('admin');
    const { data, error } = await supabaseAdmin()
      .from('meta_ads_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    const row = (data ?? null) as Record<string, unknown> | null;
    return NextResponse.json({
      has_token: !!row?.marketing_access_token,
      has_capi_token: !!row?.access_token,
      // Linha existe mas sem a coluna: migration 065 não aplicada.
      migration_missing: !!row && !('marketing_access_token' in row),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `meta-ads-marketing-token:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      access_token?: unknown;
    } | null;
    const token =
      typeof body?.access_token === 'string' ? body.access_token.trim() : '';
    if (!token) {
      return NextResponse.json({ error: 'Informe o token.' }, { status: 400 });
    }
    if (token.length > 4096 || /\s/.test(token)) {
      return NextResponse.json({ error: 'Token inválido.' }, { status: 400 });
    }

    // Só salva token que a Meta aceita.
    const check = await checkMarketingToken({ accessToken: token });
    if (!check.ok) {
      return NextResponse.json(
        { error: `A Meta recusou o token: ${check.error}` },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data: existing, error: existingError } = await admin
      .from('meta_ads_config')
      .select('id')
      .eq('account_id', accountId)
      .maybeSingle();
    if (existingError) throw existingError;

    const values = {
      marketing_access_token: encrypt(token),
      updated_at: new Date().toISOString(),
    };
    const { error: saveError } = existing
      ? await admin
          .from('meta_ads_config')
          .update(values)
          .eq('id', existing.id)
          .eq('account_id', accountId)
      : await admin
          .from('meta_ads_config')
          .insert({ account_id: accountId, ...values });
    if (saveError) {
      if (isMissingColumn(saveError)) {
        return NextResponse.json({ error: MIGRATION_MISSING }, { status: 409 });
      }
      throw saveError;
    }

    // Falhas guardadas com o token antigo não devem segurar a nova busca.
    const { error: purgeError } = await admin
      .from('meta_ad_lookups')
      .delete()
      .eq('account_id', accountId)
      .not('error', 'is', null);
    if (purgeError) {
      console.warn(
        '[meta-ads/marketing-token] cache de falhas não limpo:',
        purgeError.message
      );
    }

    return NextResponse.json({
      success: true,
      ad_accounts: check.adAccounts,
      ...(check.adAccountsError
        ? { ad_accounts_error: check.adAccountsError }
        : {}),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE() {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `meta-ads-marketing-token:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { error } = await supabaseAdmin()
      .from('meta_ads_config')
      .update({
        marketing_access_token: null,
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', accountId);
    if (error) {
      if (isMissingColumn(error)) {
        return NextResponse.json({ error: MIGRATION_MISSING }, { status: 409 });
      }
      throw error;
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
