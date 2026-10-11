import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requireOwnership } from '@/lib/lead-forms/ownership';
import { bad, fail, isUuid } from '@/lib/api-validate';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return bad('Invalid id');
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: guard.status });
  const supabase = guard.supabase;
  const url = new URL(req.url);
  const rawLimit = Number(url.searchParams.get('limit') ?? 50);
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  const { data: form } = await supabase.from('lead_forms').select('id').eq('id', id).maybeSingle();
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: responses } = await supabase
    .from('lead_form_responses')
    .select('*')
    .eq('form_id', id)
    .order('created_at', { ascending: false })
    .limit(limit);
  const { data: bookings } = await supabase
    .from('lead_form_bookings')
    .select('*')
    .eq('form_id', id)
    .order('starts_at', { ascending: true })
    .limit(200);
  return NextResponse.json({ responses: responses ?? [], bookings: bookings ?? [] });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isUuid(id)) return bad('Invalid id');
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: guard.status });
  const supabase = guard.supabase;
  const { response_id } = ((await req.json().catch(() => null)) ?? {}) as { response_id?: string };
  if (!response_id || !isUuid(response_id)) return bad('response_id é obrigatório');
  const { error } = await supabase.from('lead_form_responses').delete().eq('id', response_id).eq('form_id', id);
  if (error) return fail('responses-delete', error);
  return NextResponse.json({ ok: true });
}
