import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/** GET público — retorna config publicada do formulário (sem dados sensíveis). */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = supabaseAdmin();
  const { data: form } = await db.from('lead_forms').select('*').eq('slug', slug).maybeSingle();
  const f = form as {
    id: string; name: string; status: string; theme_config: unknown;
    scheduling_config: unknown; meta_config: unknown; qualification_config: unknown;
  } | null;
  if (!f || f.status !== 'published') {
    return NextResponse.json({ error: 'Formulário não encontrado' }, { status: 404 });
  }
  const { data: blocks } = await db
    .from('lead_form_blocks')
    .select('block_key, block_type, config, position')
    .eq('form_id', (form as { id: string }).id)
    .order('position');
  // Conta view (fire-and-forget)
  void db.rpc('increment_lead_form_counter', { p_form_id: (form as { id: string }).id, p_field: 'view' });
  const meta = (f.meta_config ?? {}) as { pixel_id?: string | null };
  return NextResponse.json({
    form: {
      id: f.id,
      name: f.name,
      theme: f.theme_config,
      scheduling: f.scheduling_config,
      pixel_id: meta.pixel_id ?? null,
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
