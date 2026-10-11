import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import {
  ContactTagWriteError,
  removeContactTag,
} from '@/lib/contacts/tag-write';
import { isUuid } from '@/lib/api-validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

function tagWriteErrorResponse(error: ContactTagWriteError): NextResponse {
  return NextResponse.json({ error: error.message }, { status: error.status });
}

async function readTagId(request: Request): Promise<string | null> {
  const body = (await request.json().catch(() => null)) as {
    tag_id?: unknown;
  } | null;
  return typeof body?.tag_id === 'string' && body.tag_id.trim()
    ? body.tag_id.trim()
    : null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const postLimit = checkRateLimit(`tags:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!postLimit.success) return rateLimitResponse(postLimit);
    const { id: contactId } = await params;
    if (!isUuid(contactId)) {
      return NextResponse.json({ error: 'Invalid contact id' }, { status: 400 });
    }
    const tagId = await readTagId(request);
    if (!tagId || !isUuid(tagId)) {
      return NextResponse.json({ error: 'tag_id must be a UUID' }, { status: 400 });
    }

    const result = await addContactTagAndDispatch({
      db: ctx.supabase,
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent');
    const deleteLimit = checkRateLimit(`tags:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!deleteLimit.success) return rateLimitResponse(deleteLimit);
    const { id: contactId } = await params;
    if (!isUuid(contactId)) {
      return NextResponse.json({ error: 'Invalid contact id' }, { status: 400 });
    }
    const tagId = await readTagId(request);
    if (!tagId || !isUuid(tagId)) {
      return NextResponse.json({ error: 'tag_id must be a UUID' }, { status: 400 });
    }

    await removeContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      return tagWriteErrorResponse(error);
    }
    return toErrorResponse(error);
  }
}
