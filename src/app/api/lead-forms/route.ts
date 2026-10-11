import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  DEFAULT_META,
  DEFAULT_QUALIFICATION,
  DEFAULT_SCHEDULING,
  DEFAULT_SETTINGS,
  DEFAULT_THEME,
  defaultBlocks,
  slugify,
} from '@/lib/lead-forms/types';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { data, error } = await supabase
    .from('lead_forms')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'Failed to load' }, { status: 500 });
  return NextResponse.json({ forms: data ?? [] });
}

export async function POST(request: Request) {
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const formLimit = checkRateLimit(`leadforms:${user.id}`, RATE_LIMITS.adminAction);
  if (!formLimit.success) return rateLimitResponse(formLimit);
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  const accountId = (profile as { account_id?: string } | null)?.account_id;
  if (!accountId) return NextResponse.json({ error: 'No account' }, { status: 403 });

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    description?: string | null;
  } | null;
  if (!body?.name?.trim()) return NextResponse.json({ error: 'name é obrigatório' }, { status: 400 });
  if (body.name.trim().length > 200) {
    return NextResponse.json({ error: 'name excede 200 caracteres' }, { status: 400 });
  }
  if (typeof body.description === 'string' && body.description.length > 2000) {
    return NextResponse.json({ error: 'description excede 2000 caracteres' }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const baseSlug = slugify(body.name);
  // Garante slug único dentro da conta
  const { data: existing } = await admin
    .from('lead_forms')
    .select('slug')
    .eq('account_id', accountId)
    .like('slug', `${baseSlug}%`);
  const taken = new Set((existing ?? []).map((r) => (r as { slug: string }).slug));
  let slug = baseSlug;
  let i = 2;
  while (taken.has(slug)) {
    slug = `${baseSlug}-${i}`;
    i += 1;
  }

  const { data: form, error } = await admin
    .from('lead_forms')
    .insert({
      account_id: accountId,
      user_id: user.id,
      name: body.name.trim(),
      description: body.description ?? null,
      slug,
      status: 'draft',
      theme_config: DEFAULT_THEME,
      settings: DEFAULT_SETTINGS,
      qualification_config: DEFAULT_QUALIFICATION,
      scheduling_config: DEFAULT_SCHEDULING,
      meta_config: DEFAULT_META,
    })
    .select()
    .single();
  if (error || !form) {
    console.error('[lead-forms:create]', error);
    return NextResponse.json({ error: 'Falha ao criar formulário' }, { status: 500 });
  }

  const blocks = defaultBlocks();
  await admin.from('lead_form_blocks').insert(
    blocks.map((b) => ({
      form_id: (form as { id: string }).id,
      block_key: b.block_key,
      block_type: b.block_type,
      config: b.config,
      position: b.position,
      is_qualifier: b.is_qualifier,
      score_weight: b.score_weight,
    })),
  );

  return NextResponse.json({ form }, { status: 201 });
}
