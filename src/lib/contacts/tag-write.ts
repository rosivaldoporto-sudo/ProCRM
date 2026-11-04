import type { SupabaseClient } from '@supabase/supabase-js';

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<void> {
  const [contactResult, tagResult] = await Promise.all([
    db
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('tags')
      .select('id')
      .eq('id', input.tagId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
  ]);

  if (contactResult.error || tagResult.error) {
    throw new ContactTagWriteError('Não foi possível verificar a etiqueta do contato');
  }
  if (!contactResult.data) {
    throw new ContactTagWriteError('Contato não encontrado', 404);
  }
  if (!tagResult.data) {
    throw new ContactTagWriteError('Etiqueta não encontrada', 404);
  }
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op and must not emit a tag_added event.
 */
export async function addContactTagIfAbsent(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const { error } = await db
    .from('contact_tags')
    .insert({ contact_id: input.contactId, tag_id: input.tagId })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return false;
  if (error) {
    throw new ContactTagWriteError(
      `Falha ao adicionar a etiqueta: ${error.message}`
    );
  }
  return true;
}

export async function removeContactTag(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<void> {
  await assertContactAndTagOwnership(db, input);

  const { error } = await db
    .from('contact_tags')
    .delete()
    .eq('contact_id', input.contactId)
    .eq('tag_id', input.tagId);

  if (error) {
    throw new ContactTagWriteError(
      `Falha ao remover a etiqueta: ${error.message}`
    );
  }
}

interface BulkContactTagInput {
  accountId: string;
  contactIds: string[];
  tagId: string;
  action: 'add' | 'remove';
}

export interface BulkContactTagResult {
  changed: number;
  unchanged: number;
  notFound: number;
}

/**
 * Add or remove one tag on a batch of contacts in a single statement, so
 * the batch lands whole or not at all. Callers cap the batch size, because
 * the ids travel in the URL (see BULK_TAG_BATCH_SIZE).
 *
 * The contacts are filtered first, so one contact deleted in the meantime
 * doesn't fail the whole statement on the foreign key. Like the rest of
 * this route, a bulk add does not dispatch `tag_added` automations.
 */
export async function applyBulkContactTag(
  db: SupabaseClient,
  { accountId, contactIds, tagId, action }: BulkContactTagInput
): Promise<BulkContactTagResult> {
  const uniqueIds = [...new Set(contactIds)];

  const [tagResult, contactsResult] = await Promise.all([
    db
      .from('tags')
      .select('id')
      .eq('id', tagId)
      .eq('account_id', accountId)
      .maybeSingle(),
    db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .in('id', uniqueIds),
  ]);

  if (tagResult.error || contactsResult.error) {
    throw new ContactTagWriteError('Não foi possível verificar os contatos');
  }
  if (!tagResult.data) {
    throw new ContactTagWriteError('Etiqueta não encontrada', 404);
  }

  const ownedIds = (contactsResult.data ?? []).map(
    (row: { id: string }) => row.id
  );
  const notFound = uniqueIds.length - ownedIds.length;
  if (ownedIds.length === 0) return { changed: 0, unchanged: 0, notFound };

  // `ignoreDuplicates` + `select`: only the rows really inserted come back.
  const { data, error } =
    action === 'add'
      ? await db
          .from('contact_tags')
          .upsert(
            ownedIds.map((id) => ({ contact_id: id, tag_id: tagId })),
            { onConflict: 'contact_id,tag_id', ignoreDuplicates: true }
          )
          .select('contact_id')
      : await db
          .from('contact_tags')
          .delete()
          .eq('tag_id', tagId)
          .in('contact_id', ownedIds)
          .select('contact_id');

  if (error) {
    throw new ContactTagWriteError(
      action === 'add'
        ? `Falha ao adicionar a etiqueta: ${error.message}`
        : `Falha ao remover a etiqueta: ${error.message}`
    );
  }

  const changed = data?.length ?? 0;
  return { changed, unchanged: ownedIds.length - changed, notFound };
}
