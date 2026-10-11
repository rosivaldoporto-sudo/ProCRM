import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

const VALID_STATUS = new Set(['scheduled', 'cancelled', 'completed', 'no_show']);

/**
 * GET — agenda global: agendamentos de TODOS os formulários da conta.
 *
 * Filtros via query string (todos opcionais):
 *  - form_id: UUID do formulário
 *  - status: scheduled | cancelled | completed | no_show
 *  - from / to: ISO datetime (janela de starts_at)
 *
 * Usa o client do usuário (RLS `lead_form_bookings` já escopa por conta)
 * e inclui o nome do formulário via join para os filtros da UI.
 */
export async function GET(req: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const formId = url.searchParams.get('form_id')?.trim() || null;
  const status = url.searchParams.get('status')?.trim() || null;
  const from = url.searchParams.get('from')?.trim() || null;
  const to = url.searchParams.get('to')?.trim() || null;

  if (status && !VALID_STATUS.has(status)) {
    return NextResponse.json({ error: 'status inválido' }, { status: 400 });
  }
  if (formId && !/^[0-9a-f-]{36}$/i.test(formId)) {
    return NextResponse.json({ error: 'form_id inválido' }, { status: 400 });
  }

  let query = supabase
    .from('lead_form_bookings')
    .select('*, lead_forms!inner(id, name, slug)')
    .order('starts_at', { ascending: true })
    .limit(1000);

  if (formId) query = query.eq('form_id', formId);
  if (status) query = query.eq('status', status);
  if (from && !Number.isNaN(Date.parse(from))) query = query.gte('starts_at', from);
  if (to && !Number.isNaN(Date.parse(to))) query = query.lte('starts_at', to);

  const { data, error } = await query;
  if (error) {
    console.error('[lead-forms/bookings]', error);
    return NextResponse.json({ error: 'Falha ao carregar agendamentos' }, { status: 500 });
  }
  return NextResponse.json({ bookings: data ?? [] });
}
