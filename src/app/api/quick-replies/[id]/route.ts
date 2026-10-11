import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { validateInteractivePayload } from '@/lib/whatsapp/interactive';
import { reqStr } from '@/lib/api-validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

// Update / delete a single quick reply. Quick replies are account-
// shared, so every mutation is scoped by `account_id` (the service-role
// client bypasses the agent-gated RLS, so both the role check and the
// account scope are enforced here).

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const patchLimit = checkRateLimit(`quickreplies:${ctx.userId}`, RATE_LIMITS.adminAction);
  if (!patchLimit.success) return rateLimitResponse(patchLimit);

  const body = await request.json().catch(() => null);
  if (!body)
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.title === 'string') {
    const title = reqStr(body.title, 120);
    if (!title)
      return NextResponse.json(
        { error: 'title cannot be empty' },
        { status: 400 }
      );
    update.title = title;
  }

  // When `kind` is supplied (e.g. the editor flips Text ↔ Interactive), it
  // drives which content column is authoritative and the other is cleared —
  // otherwise a switched row keeps a stale payload the picker mis-routes on.
  if ('kind' in body) {
    if (body.kind !== 'text' && body.kind !== 'interactive') {
      return NextResponse.json(
        { error: 'kind must be "text" or "interactive"' },
        { status: 400 }
      );
    }
    update.kind = body.kind;
    if (body.kind === 'interactive') {
      const result = validateInteractivePayload(body.interactive_payload);
      if (!result.ok)
        return NextResponse.json({ error: result.error }, { status: 400 });
      update.interactive_payload = body.interactive_payload;
      update.content_text = null;
    } else {
      const text =
        typeof body.content_text === 'string' ? body.content_text : '';
      if (!text.trim()) {
        return NextResponse.json(
          { error: 'content_text is required for text quick replies' },
          { status: 400 }
        );
      }
      if (text.length > 4096) {
        return NextResponse.json(
          { error: 'content_text is too long' },
          { status: 400 }
        );
      }
      update.content_text = text;
      update.interactive_payload = null;
    }
  } else {
    // No kind change — allow partial edits of whichever field the row uses.
    if ('content_text' in body) {
      const v = body.content_text;
      if (v !== null) {
        if (typeof v !== 'string') {
          return NextResponse.json(
            { error: 'content_text must be a string' },
            { status: 400 }
          );
        }
        if (v.length > 4096) {
          return NextResponse.json(
            { error: 'content_text is too long' },
            { status: 400 }
          );
        }
      }
      update.content_text = v ?? null;
    }
    if ('interactive_payload' in body) {
      if (body.interactive_payload != null) {
        const result = validateInteractivePayload(body.interactive_payload);
        if (!result.ok) {
          return NextResponse.json({ error: result.error }, { status: 400 });
        }
      }
      update.interactive_payload = body.interactive_payload ?? null;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabaseAdmin()
    .from('quick_replies')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error)
    return NextResponse.json(
      { error: 'Failed to update quick reply' },
      { status: 500 }
    );
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('agent');
  } catch (err) {
    return toErrorResponse(err);
  }

  const deleteLimit = checkRateLimit(`quickreplies:${ctx.userId}`, RATE_LIMITS.adminAction);
  if (!deleteLimit.success) return rateLimitResponse(deleteLimit);

  const { error } = await supabaseAdmin()
    .from('quick_replies')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error)
    return NextResponse.json(
      { error: 'Failed to delete quick reply' },
      { status: 500 }
    );
  return NextResponse.json({ ok: true });
}
