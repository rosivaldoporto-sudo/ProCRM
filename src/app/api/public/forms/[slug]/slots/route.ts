import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { generateSlots } from '@/lib/lead-forms/availability';

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = supabaseAdmin();
  const { data: formRow } = await db.from('lead_forms').select('id, status, scheduling_config').eq('slug', slug).maybeSingle();
  const form = formRow as { id: string; status: string; scheduling_config: Parameters<typeof generateSlots>[0] } | null;
  if (!form || form.status !== 'published' || !form.scheduling_config?.enabled) {
    return NextResponse.json({ error: 'Agendamento indisponível' }, { status: 404 });
  }
  const url = new URL(req.url);
  const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days') ?? 14)));
  const { data: bookings } = await db
    .from('lead_form_bookings')
    .select('starts_at, ends_at, status')
    .eq('form_id', form.id)
    .gte('starts_at', new Date().toISOString())
    .limit(500);
  const slots = generateSlots(form.scheduling_config, (bookings ?? []) as Array<{ starts_at: string; ends_at: string; status: string }>, { daysAhead: days });
  return NextResponse.json({ slots, duration_min: form.scheduling_config.duration_min, timezone: form.scheduling_config.timezone });
}
