import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { addContactTagIfAbsent, removeContactTag } from '@/lib/contacts/tag-write';
import { bad, isUuid } from '@/lib/api-validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const tagLimit = checkRateLimit(`tags:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!tagLimit.success) return rateLimitResponse(tagLimit);
    const body = await request.json().catch(() => null) as {
      contact_ids?: string[];
      tag_id?: string;
      action?: 'add' | 'remove';
    } | null;

    if (!body?.contact_ids?.length || !body?.tag_id) {
      return NextResponse.json(
        { error: 'contact_ids and tag_id are required' },
        { status: 400 }
      );
    }

    if (
      !Array.isArray(body.contact_ids) ||
      body.contact_ids.length === 0 ||
      body.contact_ids.length > 500 ||
      !body.contact_ids.every((v) => isUuid(v))
    ) {
      return bad('contact_ids must be an array of 1-500 UUIDs');
    }
    if (!isUuid(body.tag_id)) {
      return bad('tag_id must be a UUID');
    }

    const { contact_ids, tag_id, action = 'add' } = body;

    if (action === 'add') {
      let addedCount = 0;
      for (const contactId of contact_ids) {
        const added = await addContactTagIfAbsent(ctx.supabase, {
          accountId: ctx.accountId,
          contactId,
          tagId: tag_id,
        });
        if (added) addedCount++;
      }
      return NextResponse.json({ ok: true, added: addedCount });
    }

    if (action === 'remove') {
      let removedCount = 0;
      for (const contactId of contact_ids) {
        try {
          await removeContactTag(ctx.supabase, {
            accountId: ctx.accountId,
            contactId,
            tagId: tag_id,
          });
          removedCount++;
        } catch {
          // Ignore individual errors
        }
      }
      return NextResponse.json({ ok: true, removed: removedCount });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    return toErrorResponse(error);
  }
}