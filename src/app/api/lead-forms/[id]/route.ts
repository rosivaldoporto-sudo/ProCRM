import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { slugify } from '@/lib/lead-forms/types';

async function requireOwnership(formId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, status: 401 as const };
  const { data: form } = await supabase
    .from('lead_forms')
    .select('id, account_id')
    .eq('id', formId)
    .maybeSingle();
  if (!form) return { ok: false as const, status: 404 as const };
  return { ok: true as const, userId: user.id, accountId: (form as { account_id: string }).account_id, supabase };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: guard.status });
  const [{ data: form }, { data: blocks }] = await Promise.all([
    guard.supabase.from('lead_forms').select('*').eq('id', id).maybeSingle(),
    guard.supabase.from('lead_form_blocks').select('*').eq('form_id', id).order('position'),
  ]);
  if (!form) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ form, blocks: blocks ?? [] });
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: guard.status });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ['name', 'description', 'status', 'theme_config', 'settings', 'qualification_config', 'scheduling_config', 'meta_config'] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (typeof patch.name === 'string' && !patch.name.trim()) {
    return NextResponse.json({ error: 'name não pode ser vazio' }, { status: 400 });
  }
  if (body.slug !== undefined) {
    const s = slugify(String(body.slug || patch.name || 'form'));
    patch.slug = s;
  }
  if (patch.status && !['draft', 'published', 'archived'].includes(patch.status as string)) {
    return NextResponse.json({ error: 'status inválido' }, { status: 400 });
  }

  const { error: updErr } = await admin.from('lead_forms').update(patch).eq('id', id).eq('account_id', guard.accountId);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  const blocks = body.blocks as Array<{
    block_key: string; block_type: string; config: Record<string, unknown>;
    position: number; is_qualifier?: boolean; score_weight?: number;
  }> | undefined;
  if (blocks !== undefined) {
    const { error: delErr } = await admin.from('lead_form_blocks').delete().eq('form_id', id);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    if (blocks.length > 0) {
      const { error: insErr } = await admin.from('lead_form_blocks').insert(
        blocks.map((b, idx) => ({
          form_id: id,
          block_key: b.block_key?.trim() || `bloco_${idx + 1}`,
          block_type: b.block_type,
          config: b.config ?? {},
          position: b.position ?? idx,
          is_qualifier: !!b.is_qualifier,
          score_weight: Number(b.score_weight ?? 0),
        })),
      );
      if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  const [{ data: form }, { data: freshBlocks }] = await Promise.all([
    admin.from('lead_forms').select('*').eq('id', id).maybeSingle(),
    admin.from('lead_form_blocks').select('*').eq('form_id', id).order('position'),
  ]);
  return NextResponse.json({ form, blocks: freshBlocks ?? [] });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }
  const guard = await requireOwnership(id);
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: guard.status });
  const { error } = await supabaseAdmin().from('lead_forms').delete().eq('id', id).eq('account_id', guard.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
