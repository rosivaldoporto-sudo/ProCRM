import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { recountFormCounters } from '@/lib/lead-forms/counters';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * POST /api/lead-forms/[id]/recount — recalcula response/qualified/
 * booked_count a partir das tabelas reais e grava em lead_forms.
 *
 * Repara formulários cujo contador travou (ex.: RPC ausente na época
 * das respostas). view_count é preservado (não tem fonte de verdade).
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let userId: string;
  try {
    ({ userId } = await requireRole('agent'));
  } catch (err) {
    return toErrorResponse(err);
  }
  // Recount agrega 3 tabelas: sem teto, um agente (ou sessão roubada)
  // poderia martelar o banco. 30/min por usuário é folga ampla.
  const limit = checkRateLimit(`leadform-recount:${userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // Ownership via RLS: só retorna se o form for da conta do chamador.
  const { data: form } = await supabase
    .from('lead_forms')
    .select('id, account_id')
    .eq('id', id)
    .maybeSingle();
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  try {
    const counts = await recountFormCounters(supabaseAdmin(), id);
    const { data: updated } = await supabaseAdmin()
      .from('lead_forms')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    return NextResponse.json({ counts, form: updated });
  } catch (err) {
    console.error('[lead-forms:recount]', err);
    return NextResponse.json({ error: 'Falha ao recalcular' }, { status: 500 });
  }
}
