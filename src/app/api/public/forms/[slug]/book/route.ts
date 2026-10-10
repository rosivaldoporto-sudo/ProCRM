import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { generateSlots } from '@/lib/lead-forms/availability';
import { fireFormCapiEvent } from '@/lib/lead-forms/meta-events';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/** POST público — agenda reunião para resposta qualificada. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const limit = checkRateLimit(`leadform-book:${slug}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await req.json().catch(() => null)) as {
    response_id?: string; starts_at?: string; name?: string; email?: string; phone?: string; notes?: string;
  } | null;
  if (!body?.response_id || !body?.starts_at || !body?.name) {
    return NextResponse.json({ error: 'response_id, starts_at e name são obrigatórios' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const { data: formRow } = await db.from('lead_forms').select('*').eq('slug', slug).maybeSingle();
  const form = formRow as {
    id: string; account_id: string; status: string; name: string;
    scheduling_config: { enabled: boolean; duration_min: number; timezone: string; meeting_title: string };
    meta_config: { fire_schedule?: boolean };
  } | null;
  if (!form || form.status !== 'published' || !form.scheduling_config?.enabled) {
    return NextResponse.json({ error: 'Agendamento indisponível' }, { status: 404 });
  }
  const { data: respRow } = await db.from('lead_form_responses').select('*').eq('id', body.response_id).eq('form_id', form.id).maybeSingle();
  const resp = respRow as { id: string; is_qualified: boolean; respondent_email: string | null; respondent_phone: string | null } | null;
  if (!resp) return NextResponse.json({ error: 'Resposta não encontrada' }, { status: 404 });
  if (!resp.is_qualified) return NextResponse.json({ error: 'Apenas leads qualificados podem agendar' }, { status: 403 });

  // Valida slot ainda livre
  const { data: bookings } = await db
    .from('lead_form_bookings')
    .select('starts_at, ends_at, status')
    .eq('form_id', form.id)
    .gte('starts_at', new Date().toISOString())
    .limit(500);
  const slots = generateSlots(
    form.scheduling_config as never,
    (bookings ?? []) as Array<{ starts_at: string; ends_at: string; status: string }>,
    { daysAhead: 30 },
  );
  const wanted = new Date(body.starts_at).getTime();
  const match = slots.find((s) => new Date(s.start).getTime() === wanted);
  if (!match) return NextResponse.json({ error: 'Horário indisponível. Escolha outro.' }, { status: 409 });

  const { data: booking, error } = await db.from('lead_form_bookings').insert({
    form_id: form.id,
    response_id: resp.id,
    account_id: form.account_id,
    attendee_name: body.name.trim(),
    attendee_email: body.email?.trim() || resp.respondent_email,
    attendee_phone: body.phone?.trim() || resp.respondent_phone,
    starts_at: match.start,
    ends_at: match.end,
    timezone: form.scheduling_config.timezone,
    meeting_title: form.scheduling_config.meeting_title,
    notes: body.notes?.slice(0, 2000) ?? null,
  }).select().single();
  if (error || !booking) return NextResponse.json({ error: 'Falha ao agendar' }, { status: 500 });

  await db.from('lead_form_responses').update({ status: 'booked' }).eq('id', resp.id);
  void db.rpc('increment_lead_form_counter', { p_form_id: form.id, p_field: 'booked' });

  if (form.meta_config?.fire_schedule !== false) {
    const b = booking as { id: string };
    void fireFormCapiEvent({
      accountId: form.account_id, formId: form.id, responseId: resp.id,
      event: 'Schedule',
      email: body.email ?? resp.respondent_email ?? undefined,
      phone: body.phone ?? resp.respondent_phone ?? undefined,
      firstName: body.name,
      custom: { form_name: form.name, booking_id: b.id, starts_at: match.start },
    });
  }

  return NextResponse.json({ booking }, { status: 201 });
}
