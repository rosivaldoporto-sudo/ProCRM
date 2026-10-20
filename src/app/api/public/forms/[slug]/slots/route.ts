import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { generateSlots, normalizeScheduling, type BookingInterval } from '@/lib/lead-forms/availability';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request-ip';

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // Sem rate limit, bots varrem disponibilidade à vontade (enumeração +
  // custo de CPU no generateSlots). 30/min por IP é folga ampla.
  const ip = getClientIp(req);
  const limit = checkRateLimit(`leadform-slots:${slug}:${ip}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);

  const db = supabaseAdmin();
  const { data: formRow } = await db
    .from('lead_forms')
    .select('id, status, scheduling_config')
    .eq('slug', slug)
    .maybeSingle();
  const form = formRow as { id: string; status: string; scheduling_config: unknown } | null;
  if (!form || form.status !== 'published') {
    return NextResponse.json({ error: 'Agendamento indisponível' }, { status: 404 });
  }

  const config = normalizeScheduling(form.scheduling_config);
  if (!config.enabled) {
    return NextResponse.json({ error: 'Agendamento indisponível' }, { status: 404 });
  }

  const url = new URL(req.url);
  const requestedDays = Number(url.searchParams.get('days'));
  const days = Number.isFinite(requestedDays) && requestedDays > 0
    ? Math.max(1, Math.min(config.max_days_ahead, Math.floor(requestedDays)))
    : config.max_days_ahead;

  // Inclui os dias anteriores para contar reuniões já realizadas no
  // limite diário e para bloquear buffers de reuniões em andamento.
  const now = new Date();
  const rangeStart = new Date(now.getTime() - 48 * 60 * 60_000);
  const rangeEnd = new Date(now.getTime() + (days + 2) * 24 * 60 * 60_000);
  const { data: bookings } = await db
    .from('lead_form_bookings')
    .select('starts_at, ends_at, status')
    .eq('form_id', form.id)
    .gte('starts_at', rangeStart.toISOString())
    .lt('starts_at', rangeEnd.toISOString())
    .limit(5_000);

  const slots = generateSlots(
    config,
    (bookings ?? []) as BookingInterval[],
    { daysAhead: days, now },
  );

  return NextResponse.json(
    {
      slots,
      duration_min: config.duration_min,
      timezone: config.timezone,
      min_notice_min: config.min_notice_min,
      max_days_ahead: config.max_days_ahead,
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
