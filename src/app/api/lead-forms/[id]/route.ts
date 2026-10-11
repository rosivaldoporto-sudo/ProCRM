import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { slugify, BLOCK_TYPE_LABELS } from '@/lib/lead-forms/types';

const VALID_BLOCK_TYPES = new Set(Object.keys(BLOCK_TYPE_LABELS));
const MAX_BLOCKS = 60;
const MAX_JSON_BYTES = 200_000;

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** Erro interno genérico — detalhes vão só para o log do servidor. */
function fail(op: string, err: unknown) {
  console.error(`[lead-forms:${op}]`, err);
  return NextResponse.json({ error: 'Falha ao salvar formulário' }, { status: 500 });
}

/**
 * Ownership com checagem explícita de tenancy.
 *
 * Por que não basta o RLS aqui: as mutações usam `supabaseAdmin` (bypassa
 * RLS), então a guarda precisa comparar o `account_id` do formulário com
 * a conta do chamador. Sem isso, qualquer usuário autenticado de QUALQUER
 * conta poderia ler/alterar/excluir formulários alheios (IDOR) — inclusive
 * trocar o `webhook_url` e exfiltrar PII de leads futuros. Retorna 404
 * genérico em mismatch para não revelar a existência do recurso.
 */
async function requireOwnership(formId: string) {
  let accountId: string;
  let userId: string;
  try {
    const ctx = await getCurrentAccount();
    accountId = ctx.accountId;
    userId = ctx.userId;
  } catch {
    return { ok: false as const, status: 401 as const };
  }
  const supabase = await createClient();
  const { data: form } = await supabase
    .from('lead_forms')
    .select('id, account_id')
    .eq('id', formId)
    .maybeSingle();
  const ownerAccount = (form as { account_id: string } | null)?.account_id;
  if (!ownerAccount || ownerAccount !== accountId) {
    return { ok: false as const, status: 404 as const };
  }
  return { ok: true as const, userId, accountId, supabase };
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

  // Teto anti-DoS: configs gigantes (ou milhares de blocos) estourariam
  // armazenamento e lentidão no form público. 200KB é folga ampla.
  const rawSize = JSON.stringify(body).length;
  if (rawSize > MAX_JSON_BYTES) return bad('Payload excede o tamanho máximo');

  const admin = supabaseAdmin();
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const k of ['name', 'description', 'status', 'theme_config', 'settings', 'qualification_config', 'scheduling_config', 'meta_config'] as const) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (typeof patch.name === 'string') {
    if (!patch.name.trim()) return NextResponse.json({ error: 'name não pode ser vazio' }, { status: 400 });
    if (patch.name.length > 200) return bad('name excede 200 caracteres');
  }
  if (typeof patch.description === 'string' && patch.description.length > 2000) {
    return bad('description excede 2000 caracteres');
  }
  if (body.slug !== undefined) {
    const s = slugify(String(body.slug || patch.name || 'form'));
    patch.slug = s;
  }
  if (patch.status && !['draft', 'published', 'archived'].includes(patch.status as string)) {
    return NextResponse.json({ error: 'status inválido' }, { status: 400 });
  }

  const { error: updErr } = await admin.from('lead_forms').update(patch).eq('id', id).eq('account_id', guard.accountId);
  if (updErr) return fail('update', updErr);

  const blocks = body.blocks as Array<{
    block_key: string; block_type: string; config: Record<string, unknown>;
    position: number; is_qualifier?: boolean; score_weight?: number;
  }> | undefined;
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS) {
      return bad(`blocks deve ser uma lista de no máximo ${MAX_BLOCKS} itens`);
    }
    for (const [idx, b] of blocks.entries()) {
      if (!b || typeof b !== 'object') return bad(`blocks[${idx}] inválido`);
      if (typeof b.block_key !== 'string' || b.block_key.length > 80) {
        return bad(`blocks[${idx}].block_key inválido`);
      }
      // Allow-list: sem isso, tipos desconhecidos quebram o form público
      // (e o CHECK do banco estouraria 500 com detalhe interno).
      if (!VALID_BLOCK_TYPES.has(b.block_type)) {
        return bad(`blocks[${idx}].block_type inválido`);
      }
      if (b.config !== undefined && (typeof b.config !== 'object' || JSON.stringify(b.config).length > 20_000)) {
        return bad(`blocks[${idx}].config excede o tamanho máximo`);
      }
      if (b.score_weight !== undefined && !Number.isFinite(Number(b.score_weight))) {
        return bad(`blocks[${idx}].score_weight inválido`);
      }
    }
    const { error: delErr } = await admin.from('lead_form_blocks').delete().eq('form_id', id);
    if (delErr) return fail('blocks-delete', delErr);
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
      if (insErr) return fail('blocks-insert', insErr);
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
  if (error) {
    console.error('[lead-forms:delete]', error);
    return NextResponse.json({ error: 'Falha ao excluir formulário' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
