import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { BULK_TAG_BATCH_SIZE } from '@/lib/contacts/bulk-tags';
import {
  applyBulkContactTag,
  ContactTagWriteError,
} from '@/lib/contacts/tag-write';
import { bad, isUuid } from '@/lib/api-validate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

/**
 * One batch of a bulk tag action. The dashboard splits the selection with
 * `runBulkTagAction`, so a request is a single statement in the database.
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const tagLimit = checkRateLimit(
      `bulk-tags:${ctx.userId}`,
      RATE_LIMITS.bulkTagBatch
    );
    if (!tagLimit.success) return rateLimitResponse(tagLimit);
    const body = (await request.json().catch(() => null)) as {
      contact_ids?: unknown;
      tag_id?: unknown;
      action?: unknown;
    } | null;

    const contactIds = body?.contact_ids;
    const tagId = body?.tag_id;
    const action = body?.action ?? 'add';

    if (!Array.isArray(contactIds) || contactIds.length === 0 || !tagId) {
      return bad('Informe os contatos e a etiqueta');
    }
    if (
      contactIds.length > BULK_TAG_BATCH_SIZE ||
      !contactIds.every((id) => isUuid(id))
    ) {
      return bad(`Envie de 1 a ${BULK_TAG_BATCH_SIZE} contatos por requisição`);
    }
    if (!isUuid(tagId)) {
      return bad('Etiqueta inválida');
    }
    if (action !== 'add' && action !== 'remove') {
      return bad('Ação inválida');
    }

    const result = await applyBulkContactTag(ctx.supabase, {
      accountId: ctx.accountId,
      contactIds,
      tagId,
      action,
    });

    return NextResponse.json({
      ok: true,
      changed: result.changed,
      unchanged: result.unchanged,
      not_found: result.notFound,
    });
  } catch (error) {
    if (error instanceof ContactTagWriteError) {
      if (error.status >= 500) console.error('[bulk-tags]', error.message);
      return NextResponse.json(
        {
          error:
            error.status >= 500
              ? 'Não foi possível gravar as etiquetas. Tente novamente.'
              : error.message,
        },
        { status: error.status }
      );
    }
    return toErrorResponse(error);
  }
}
