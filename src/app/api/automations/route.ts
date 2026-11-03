import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { getTemplate } from '@/lib/automations/templates';
import {
  insertSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { TRIGGER_META } from '@/lib/automations/trigger-meta';
import { reqStr, isValidEnum, jsonSizeOk } from '@/lib/api-validate';

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const { data, error } = await supabase
    .from('automations')
    .select('*')
    .order('created_at', { ascending: false });
  if (error)
    return NextResponse.json(
      { error: 'Falha ao carregar as automações' },
      { status: 500 }
    );
  return NextResponse.json({ automations: data ?? [] });
}

export async function POST(request: Request) {
  // Creating an automation is a write — the RLS automations_insert policy
  // requires `agent`, but this route inserts via the service-role client
  // which bypasses RLS, so the role must be enforced here.
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user)
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });

  const limit = checkRateLimit(`automations:${user.id}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);

  // Resolve the caller's account_id — `automations.account_id` is NOT
  // NULL post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Seu perfil não está vinculado a uma conta.' },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'JSON inválido' }, { status: 400 });

  const {
    name,
    description,
    trigger_type,
    trigger_config,
    is_active,
    steps,
    template,
  } = body;

  let effectiveSteps: BuilderStepInput[] | undefined = steps;
  let effectiveName = name;
  let effectiveDescription = description;
  let effectiveTriggerType = trigger_type;
  let effectiveTriggerConfig = trigger_config;

  if (template && (!steps || steps.length === 0)) {
    const t = getTemplate(template);
    if (t) {
      effectiveName = effectiveName ?? t.name;
      effectiveDescription = effectiveDescription ?? t.description;
      effectiveTriggerType = effectiveTriggerType ?? t.trigger_type;
      effectiveTriggerConfig = effectiveTriggerConfig ?? t.trigger_config;
      effectiveSteps = t.steps as unknown as BuilderStepInput[];
    }
  }

  const cleanName = reqStr(effectiveName, 200);
  if (!cleanName || !effectiveTriggerType) {
    return NextResponse.json(
      { error: 'Nome e tipo de gatilho são obrigatórios' },
      { status: 400 }
    );
  }
  if (!isValidEnum(effectiveTriggerType, Object.keys(TRIGGER_META))) {
    return NextResponse.json(
      { error: 'Tipo de gatilho inválido' },
      { status: 400 }
    );
  }
  if (
    effectiveDescription !== undefined &&
    effectiveDescription !== null
  ) {
    if (typeof effectiveDescription !== 'string') {
      return NextResponse.json(
        { error: 'Descrição inválida' },
        { status: 400 }
      );
    }
    if (effectiveDescription.length > 2000) {
      return NextResponse.json(
        { error: 'A descrição é longa demais' },
        { status: 400 }
      );
    }
  }
  if (effectiveSteps !== undefined) {
    if (!Array.isArray(effectiveSteps)) {
      return NextResponse.json(
        { error: 'Etapas inválidas' },
        { status: 400 }
      );
    }
    if (effectiveSteps.length > 200) {
      return NextResponse.json(
        { error: 'Etapas demais' },
        { status: 400 }
      );
    }
  }
  if (
    effectiveTriggerConfig !== undefined &&
    !jsonSizeOk(effectiveTriggerConfig, 20000)
  ) {
    return NextResponse.json(
      { error: 'A configuração do gatilho é grande demais' },
      { status: 400 }
    );
  }

  // Block activation of a clearly broken automation up-front instead of
  // letting every trigger silently produce a failed log row. Drafts
  // (is_active=false) are allowed to be incomplete so users can save
  // progress mid-build.
  if (is_active) {
    const issues = [
      ...validateTriggerForActivation(
        effectiveTriggerType,
        effectiveTriggerConfig ?? {}
      ),
      ...validateStepsForActivation(
        (effectiveSteps ?? []) as unknown as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[]
      ),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Não é possível ativar a automação com configuração inválida',
          issues,
        },
        { status: 400 }
      );
    }
  }

  const admin = supabaseAdmin();
  const { data: automation, error: insertErr } = await admin
    .from('automations')
    .insert({
      user_id: user.id,
      account_id: accountId,
      name: cleanName,
      description: effectiveDescription ?? null,
      trigger_type: effectiveTriggerType,
      trigger_config: effectiveTriggerConfig ?? {},
      is_active: !!is_active,
    })
    .select()
    .single();

  if (insertErr || !automation) {
    console.error('[api:automations] insert failed:', insertErr);
    return NextResponse.json(
      { error: 'Falha ao criar a automação' },
      { status: 500 }
    );
  }

  if (effectiveSteps && effectiveSteps.length > 0) {
    const err = await insertSteps(automation.id, effectiveSteps);
    if (err) {
      console.error('[api:automations] insert steps failed:', err);
      return NextResponse.json({ error: 'Falha ao criar a automação' }, { status: 500 });
    }
  }

  return NextResponse.json({ automation }, { status: 201 });
}
