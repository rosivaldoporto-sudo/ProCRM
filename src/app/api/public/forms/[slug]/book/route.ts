import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { generateSlots } from '@/lib/lead-forms/availability';
import { fireFormCapiEvent } from '@/lib/lead-forms/meta-events';
import { bumpFormCounter } from '@/lib/lead-forms/counters';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/** POST público — agenda reunião para resposta qualificada. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // Chave por slug+IP: por slug puro, um atacante esgotaria o bucket e
  // faria DoS do agendamento para todos os visitantes do formulário.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown';
  const limit = checkRateLimit(`leadform-book:${slug}:${ip}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const body = (await req.json().catch(() => null)) as {
    response_id?: string; starts_at?: string; name?: string; email?: string; phone?: string; notes?: string;
  } | null;
  if (!body?.response_id || !body?.starts_at || !body?.name) {
    return NextResponse.json({ error: 'response_id, starts_at e name são obrigatórios' }, { status: 400 });
  }
  // Tetos: campos de texto livres sem limite viram vetor de DoS de armazenamento.
  const name = body.name.trim().slice(0, 200);
  const email = typeof body.email === 'string' ? body.email.trim().slice(0, 320) : undefined;
  const phone = typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : undefined;
  const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : undefined;
  if (!name) {
    return NextResponse.json({ error: 'response_id, starts_at e name são obrigatórios' }, { status: 400 });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: 'E-mail inválido' }, { status: 400 });
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
  const resp = respRow as {
    id: string; is_qualified: boolean; respondent_email: string | null; respondent_phone: string | null;
    tracking: Record<string, string | undefined> | null; ip: string | null; user_agent: string | null;
  } | null;
  if (!resp) return NextResponse.json({ error: 'Resposta não encontrada' }, { status: 404 });
  if (!resp.is_qualified) return NextResponse.json({ error: 'Apenas leads qualificados podem agendar' }, { status: 403 });

  // Idempotência: uma resposta agenda uma vez. Sem isso, replay do POST
  // cria N agendamentos e infla contadores (slot repetido já cai no 409
  // abaixo, mas slots diferentes passariam).
  const { data: existingBooking } = await db
    .from('lead_form_bookings')
    .select('id')
    .eq('response_id', resp.id)
    .eq('status', 'scheduled')
    .limit(1)
    .maybeSingle();
  if (existingBooking) {
    return NextResponse.json({ error: 'Esta resposta já possui um agendamento ativo' }, { status: 409 });
  }

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
    attendee_name: name,
    attendee_email: email || resp.respondent_email,
    attendee_phone: phone || resp.respondent_phone,
    starts_at: match.start,
    ends_at: match.end,
    timezone: form.scheduling_config.timezone,
    meeting_title: form.scheduling_config.meeting_title,
    notes: notes ?? null,
  }).select().single();
  if (error || !booking) return NextResponse.json({ error: 'Falha ao agendar' }, { status: 500 });

  await db.from('lead_form_responses').update({ status: 'booked' }).eq('id', resp.id);
  void bumpFormCounter(db, form.id, 'booked');

  if (form.meta_config?.fire_schedule !== false) {
    const b = booking as { id: string };
    // event_id `booking_<id>` = mesmo do browser (dedup pixel ↔ CAPI).
    void fireFormCapiEvent({
      accountId: form.account_id, formId: form.id, responseId: resp.id,
      event: 'Schedule',
      eventId: `booking_${b.id}`,
      email: email ?? resp.respondent_email ?? undefined,
      phone: phone ?? resp.respondent_phone ?? undefined,
      fullName: name,
      eventSourceUrl: resp.tracking?.source_url,
      fbp: resp.tracking?.fbp, fbc: resp.tracking?.fbc, fbclid: resp.tracking?.fbclid,
      clientIp: resp.ip ?? undefined, clientUa: resp.user_agent ?? undefined,
      custom: { form_name: form.name, booking_id: b.id, starts_at: match.start },
    });
  }

  return NextResponse.json({ booking }, { status: 201 });
}
