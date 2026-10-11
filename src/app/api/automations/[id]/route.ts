import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import {
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from '@/lib/automations/validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { TRIGGER_META } from '@/lib/automations/trigger-meta';
import { reqStr, isValidEnum, jsonSizeOk } from '@/lib/api-validate';

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const admin = supabaseAdmin();
  const { data: automation, error } = await admin
    .from('automations')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error)
    return NextResponse.json(
      { error: 'Failed to load automation' },
      { status: 500 }
    );
  if (!automation)
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const steps = await loadStepsTree(id);
  return NextResponse.json({ automation, steps });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Editing an automation is a write — the RLS automations_update policy
  // requires `agent`, but this route mutates via the service-role client
  // which bypasses RLS, so enforce the role here.
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const user = await requireUser();
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const patchLimit = checkRateLimit(`automations:${user.id}`, RATE_LIMITS.adminAction);
  if (!patchLimit.success) return rateLimitResponse(patchLimit);

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const admin = supabaseAdmin();

  // Ownership check before we touch anything. Load the fields we need
  // to compute the post-patch "effective" state for validation.
  const { data: existing } = await admin
    .from('automations')
    .select('id, user_id, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .maybeSingle();
  if (!existing || existing.user_id !== user.id) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const update: Record<string, unknown> = {};
  if ('name' in body) {
    const cleanName = reqStr(body.name, 200);
    if (!cleanName) {
      return NextResponse.json({ error: 'Invalid name' }, { status: 400 });
    }
    update.name = cleanName;
  }
  if ('description' in body) {
    if (body.description !== null) {
      if (typeof body.description !== 'string') {
        return NextResponse.json({ error: 'Invalid description' }, { status: 400 });
      }
      if (body.description.length > 2000) {
        return NextResponse.json({ error: 'description is too long' }, { status: 400 });
      }
    }
    update.description = body.description;
  }
  if ('trigger_type' in body) {
    if (!isValidEnum(body.trigger_type, Object.keys(TRIGGER_META))) {
      return NextResponse.json({ error: 'Invalid trigger_type' }, { status: 400 });
    }
    update.trigger_type = body.trigger_type;
  }
  if ('trigger_config' in body) {
    if (!jsonSizeOk(body.trigger_config, 20000)) {
      return NextResponse.json({ error: 'trigger_config is too large' }, { status: 400 });
    }
    update.trigger_config = body.trigger_config;
  }
  if ('is_active' in body) {
    update.is_active = body.is_active;
  }
  if ('steps' in body && body.steps !== undefined) {
    if (!Array.isArray(body.steps)) {
      return NextResponse.json({ error: 'steps must be an array' }, { status: 400 });
    }
    if (body.steps.length > 200) {
      return NextResponse.json({ error: 'Too many steps' }, { status: 400 });
    }
  }

  // If this PATCH leaves the automation active (either explicitly
  // activating it OR editing an already-active one), validate the
  // merged configuration first. Activation is the natural gate — drafts
  // are still allowed to be incomplete.
  const willBeActive =
    typeof update.is_active === 'boolean'
      ? update.is_active
      : existing.is_active;
  if (willBeActive) {
    const mergedTriggerType = (update.trigger_type ??
      existing.trigger_type) as string;
    const mergedTriggerConfig =
      update.trigger_config ?? existing.trigger_config;
    const mergedSteps = Array.isArray(body.steps)
      ? (body.steps as {
          step_type: string;
          step_config: Record<string, unknown>;
        }[])
      : await loadStepsTree(id);
    const issues = [
      ...validateTriggerForActivation(mergedTriggerType, mergedTriggerConfig),
      ...validateStepsForActivation(mergedSteps),
    ];
    if (issues.length > 0) {
      return NextResponse.json(
        {
          error: 'Cannot keep automation active with invalid configuration',
          issues,
        },
        { status: 400 }
      );
    }
  }

  if (Object.keys(update).length > 0) {
    const { error: updErr } = await admin
      .from('automations')
      .update(update)
      .eq('id', id)
      .eq('user_id', user.id);
    if (updErr)
      return NextResponse.json({ error: 'Falha ao salvar automação' }, { status: 500 });
  }

  if (Array.isArray(body.steps)) {
    const err = await replaceSteps(id, body.steps as BuilderStepInput[]);
    if (err) {
      console.error('[api:automations] replace steps failed:', err);
      return NextResponse.json({ error: 'Failed to save automation' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Deleting an automation is a write — enforce `agent` (the service-role
  // client below bypasses the agent-gated automations_delete RLS).
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const user = await requireUser();
  if (!user)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const deleteLimit = checkRateLimit(`automations:${user.id}`, RATE_LIMITS.adminAction);
  if (!deleteLimit.success) return rateLimitResponse(deleteLimit);

  const { error } = await supabaseAdmin()
    .from('automations')
    .delete()
    .eq('id', id)
    .eq('user_id', user.id);
  if (error)
    return NextResponse.json(
      { error: 'Failed to delete automation' },
      { status: 500 }
    );
  return NextResponse.json({ ok: true });
}
