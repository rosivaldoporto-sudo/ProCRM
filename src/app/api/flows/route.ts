import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getFlowTemplate } from '@/lib/flows/templates';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { reqStr, isValidEnum, jsonSizeOk } from '@/lib/api-validate';

const FLOW_TRIGGER_TYPES = ['keyword', 'first_inbound_message', 'manual'] as const;

/**
 * GET /api/flows — list the caller's flows.
 * POST /api/flows — create a new (draft) flow.
 *
 * Available to every authenticated user. The previous per-account
 * beta gate was removed when Flows went to soft-GA; the UI still
 * shows a "Beta" label so users know the surface is young, but the
 * routes themselves are open.
 */

async function requireUser(): Promise<
  | {
      ok: true;
      userId: string;
      supabase: Awaited<ReturnType<typeof createClient>>;
    }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } };
  }
  return { ok: true, userId: user.id, supabase };
}

export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { supabase } = guard;

  const { data, error } = await supabase
    .from('flows')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json(
      { error: 'Failed to load flows' },
      { status: 500 }
    );
  }
  return NextResponse.json({ flows: data ?? [] });
}

export async function POST(request: Request) {
  // Creating a flow is a write — the RLS flows_insert policy requires
  // `agent`, but this route inserts via the service-role client which
  // bypasses RLS, so the role must be enforced here.
  try {
    await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const guard = await requireUser();
  if (!guard.ok) {
    return NextResponse.json(guard.body, { status: guard.status });
  }
  const { userId, supabase } = guard;

  const limit = checkRateLimit(`flows:${userId}`, RATE_LIMITS.adminAction);
  if (!limit.success) return rateLimitResponse(limit);

  // Resolve the caller's account_id — `flows.account_id` is NOT NULL
  // post-017, so an INSERT without it trips the not-null constraint
  // even though the admin client below bypasses RLS.
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .single();
  const accountId = profile?.account_id as string | undefined;
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    name?: string;
    description?: string | null;
    trigger_type?: 'keyword' | 'first_inbound_message' | 'manual';
    trigger_config?: Record<string, unknown>;
    /**
     * If set, clone the matching template's name + trigger +
     * entry_node_id + nodes[] into a fresh draft for this user.
     * `name` from the body overrides the template default if
     * provided.
     */
    template_slug?: string;
  } | null;
  if (!body) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // -------- Template clone path --------
  if (body.template_slug) {
    const template = getFlowTemplate(body.template_slug);
    if (!template) {
      return NextResponse.json(
        { error: `Unknown template_slug "${body.template_slug}"` },
        { status: 400 }
      );
    }
    const { data: flow, error: flowErr } = await admin
      .from('flows')
      .insert({
        user_id: userId,
        account_id: accountId,
        name: body.name !== undefined ? reqStr(body.name, 200) ?? template.name : template.name,
        description: template.description,
        status: 'draft',
        trigger_type: template.trigger_type,
        trigger_config: template.trigger_config,
        entry_node_id: template.entry_node_id,
      })
      .select()
      .single();
    if (flowErr || !flow) {
      console.error('[api:flows] flow insert failed:', flowErr);
      return NextResponse.json(
        { error: 'Failed to create flow' },
        { status: 500 }
      );
    }
    if (template.nodes.length > 0) {
      const { error: nodesErr } = await admin.from('flow_nodes').insert(
        template.nodes.map((n) => ({
          flow_id: flow.id,
          node_key: n.node_key,
          node_type: n.node_type,
          config: n.config,
        }))
      );
      if (nodesErr) {
        // Roll back the parent flow so a half-cloned template doesn't
        // sit as an empty draft. CASCADE on flow_id removes the
        // (probably zero) nodes too.
        await admin.from('flows').delete().eq('id', flow.id);
        console.error('[api:flows] flow nodes insert failed:', nodesErr);
        return NextResponse.json({ error: 'Failed to create flow' }, { status: 500 });
      }
    }
    return NextResponse.json({ flow }, { status: 201 });
  }

  // -------- Plain (empty) create path --------
  const name = reqStr(body.name, 200);
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }
  const trigger_type = body.trigger_type ?? 'keyword';
  if (!isValidEnum(trigger_type, FLOW_TRIGGER_TYPES)) {
    return NextResponse.json({ error: 'Invalid trigger_type' }, { status: 400 });
  }
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      return NextResponse.json({ error: 'Invalid description' }, { status: 400 });
    }
    if (body.description.length > 2000) {
      return NextResponse.json({ error: 'description is too long' }, { status: 400 });
    }
    description = body.description;
  }
  const triggerConfig = body.trigger_config ?? {};
  if (!jsonSizeOk(triggerConfig, 20000)) {
    return NextResponse.json({ error: 'trigger_config is too large' }, { status: 400 });
  }

  const { data, error } = await admin
    .from('flows')
    .insert({
      user_id: userId,
      account_id: accountId,
      name,
      description,
      status: 'draft',
      trigger_type,
      trigger_config: triggerConfig,
    })
    .select()
    .single();
  if (error || !data) {
    console.error('[api:flows] flow insert failed:', error);
    return NextResponse.json(
      { error: 'Failed to create flow' },
      { status: 500 }
    );
  }
  return NextResponse.json({ flow: data }, { status: 201 });
}
