import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { normalizeScheduling } from '@/lib/lead-forms/availability';
import { bumpFormCounter } from '@/lib/lead-forms/counters';
import { findPublishedFormBySlug } from '@/lib/lead-forms/public-form';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request-ip';

/** GET público — retorna config publicada do formulário (sem dados sensíveis). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  // Rate limit por IP: sem ele, qualquer um infla `view_count` com refresh
  // e enumera slugs sem custo.
  const ip = getClientIp(req);
  const limit = checkRateLimit(`leadform-view:${ip}`, RATE_LIMITS.invitationPeek);
  if (!limit.success) return rateLimitResponse(limit);
  const db = supabaseAdmin();
  const form = await findPublishedFormBySlug(db, slug);
  const f = form as unknown as {
    id: string; account_id: string; name: string; status: string; theme_config: unknown;
    scheduling_config: unknown; meta_config: unknown; qualification_config: unknown;
  } | null;
  if (!f) {
    return NextResponse.json({ error: 'Formulário não encontrado' }, { status: 404 });
  }
  const { data: blocks } = await db
    .from('lead_form_blocks')
    .select('block_key, block_type, config, position')
    .eq('form_id', f.id)
    .order('position');
  // Conta view (fire-and-forget, com log em caso de falha)
  void bumpFormCounter(db, f.id, 'view');
  const meta = (f.meta_config ?? {}) as {
    pixel_id?: string | null;
    fire_view_content?: boolean; fire_lead?: boolean;
    fire_complete_registration?: boolean; fire_schedule?: boolean;
  };
  // Sem pixel próprio, usa o global da conta: é o mesmo fallback do CAPI, e
  // sem ele o formulário no ar não carregava o pixel do navegador.
  let pixelId = meta.pixel_id?.trim() || null;
  if (!pixelId) {
    const { data: cfg } = await db
      .from('meta_ads_config')
      .select('pixel_id')
      .eq('account_id', f.account_id)
      .maybeSingle();
    pixelId = (cfg as { pixel_id: string | null } | null)?.pixel_id?.trim() || null;
  }
  const scheduling = normalizeScheduling(f.scheduling_config);
  return NextResponse.json({
    form: {
      id: f.id,
      name: f.name,
      theme: f.theme_config,
      // Só o necessário para montar a tela. A grade de horários fica no
      // endpoint /slots, que aplica as regras no servidor. O link da reunião
      // só sai na resposta do /book: aqui ele vazaria para qualquer visitante.
      scheduling: {
        enabled: scheduling.enabled,
        duration_min: scheduling.duration_min,
        timezone: scheduling.timezone,
        meeting_title: scheduling.meeting_title,
        owner_name: scheduling.owner_name,
        max_days_ahead: scheduling.max_days_ahead,
        min_notice_min: scheduling.min_notice_min,
      },
      pixel_id: pixelId,
      pixel_events: {
        view_content: meta.fire_view_content !== false,
        lead: meta.fire_lead !== false,
        complete_registration: meta.fire_complete_registration !== false,
        schedule: meta.fire_schedule !== false,
      },
    },
    blocks: (blocks ?? []).map((b) => {
      const row = b as { block_key: string; block_type: string; config: Record<string, unknown>; position: number };
      // Remove score interno do payload público
      const { ...safeConfig } = row.config ?? {};
      if (Array.isArray((safeConfig as { options?: unknown[] }).options)) {
        (safeConfig as { options: Array<Record<string, unknown>> }).options = (
          (safeConfig as { options: Array<Record<string, unknown>> }).options
        ).map((o) => ({ value: o.value, label: o.label }));
      }
      delete (safeConfig as Record<string, unknown>).qualifying_values;
      delete (safeConfig as Record<string, unknown>).qualifying_number;
      delete (safeConfig as Record<string, unknown>).qualifying_operator;
      return { key: row.block_key, type: row.block_type, config: safeConfig, position: row.position };
    }),
  });
}
