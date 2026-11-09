import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  fetchAdNames,
  getAdsReadToken,
  isValidAdId,
} from '@/lib/facebook/ctwa-ads';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/meta-ads/marketing-token/test  { ad_id }
 *
 * Lê na Meta os nomes de um anúncio com o token salvo, sem cache, para o
 * admin conferir a configuração sem esperar um lead chegar.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `meta-ads-marketing-token-test:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      ad_id?: unknown;
    } | null;
    const adId = typeof body?.ad_id === 'string' ? body.ad_id.trim() : '';
    if (!isValidAdId(adId)) {
      return NextResponse.json(
        { error: 'O ID do anúncio tem só números.' },
        { status: 400 }
      );
    }

    const token = await getAdsReadToken(supabaseAdmin(), accountId);
    if (!token) {
      return NextResponse.json(
        { error: 'Salve um token antes de testar.' },
        { status: 400 }
      );
    }

    const result = await fetchAdNames({ adId, accessToken: token });
    if (!result.ok) {
      return NextResponse.json(
        { error: `A Meta recusou a leitura: ${result.error}` },
        { status: 400 }
      );
    }
    return NextResponse.json({ success: true, names: result.names });
  } catch (err) {
    return toErrorResponse(err);
  }
}
