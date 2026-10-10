import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const url = new URL(req.url);
  const limit = Math.min(200, Number(url.searchParams.get('limit') ?? 50));
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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { response_id } = ((await req.json().catch(() => null)) ?? {}) as { response_id?: string };
  if (!response_id) return NextResponse.json({ error: 'response_id é obrigatório' }, { status: 400 });
  const { error } = await supabase.from('lead_form_responses').delete().eq('id', response_id).eq('form_id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
