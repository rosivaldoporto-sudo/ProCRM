// ============================================================
// Audience helpers shared by the broadcast wizard and the send.
//
// The audience step, the review step and the send itself must agree
// on who receives a broadcast. Keeping the rules here stops the
// number shown on screen from drifting away from the real send.
//
// Pasted lists and CSVs are matched against `contacts` through
// `phone_normalized`, the digits-only column behind the UNIQUE index
// (migration 022). Matching on the raw `phone` misses "+5511..." vs
// "5511...", and the insert that follows violates that index.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AudienceConfig, CustomFieldFilter } from '@/lib/broadcast-send';
import { fetchAllInboxPages } from '@/lib/inbox/pagination';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { Contact } from '@/types';

/** PostgREST rejects URLs past its length cap, so `in.(...)` goes in chunks. */
const LOOKUP_CHUNK = 200;
/** Keeps each insert under PostgREST's default payload cap. */
const INSERT_CHUNK = 200;
/** A UUID takes 37 characters of URL, so an `in.(...)` of ids stays short. */
export const CONTACT_ID_CHUNK = 100;

export interface ListContact {
  phone: string;
  name?: string;
}

/** A row of a pasted list or CSV whose number is already a contact. */
export interface ExistingListContact {
  phone: string;
  name?: string;
  normalized: string;
  tagIds: string[];
}

/** One entry per number. A row with no digits can never receive a message. */
function uniqueByPhone(rows: ListContact[]): Map<string, ListContact> {
  const unique = new Map<string, ListContact>();
  for (const row of rows) {
    const normalized = normalizePhone(row.phone);
    if (normalized && !unique.has(normalized)) unique.set(normalized, row);
  }
  return unique;
}

/** Finds which rows of a list are already contacts, with their tags. */
export async function fetchExistingListContacts(
  supabase: SupabaseClient,
  accountId: string,
  rows: ListContact[],
  isCancelled: () => boolean = () => false,
): Promise<ExistingListContact[] | null> {
  const unique = uniqueByPhone(rows);
  const phones = [...unique.keys()];
  const found: ExistingListContact[] = [];

  for (let i = 0; i < phones.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .select('name, phone_normalized, contact_tags(tag_id)')
      .eq('account_id', accountId)
      .in('phone_normalized', phones.slice(i, i + LOOKUP_CHUNK));

    if (isCancelled()) return null;
    if (error) {
      throw new Error(`Falha ao verificar os contatos existentes: ${error.message}`);
    }

    for (const contact of data ?? []) {
      const row = unique.get(contact.phone_normalized);
      if (!row) continue;
      found.push({
        phone: row.phone,
        name: row.name ?? contact.name ?? undefined,
        normalized: contact.phone_normalized,
        tagIds: (contact.contact_tags ?? []).map(
          (link: { tag_id: string }) => link.tag_id,
        ),
      });
    }
  }

  return found;
}

/**
 * How many people a list reaches: each number once, minus the existing
 * contacts carrying an excluded tag. New numbers have no tags yet, so
 * they are never excluded. Mirrors what the send does.
 */
export function countListRecipients(
  rows: ListContact[],
  existing: ExistingListContact[],
  excludeTagIds: string[] = [],
): number {
  const excludedTags = new Set(excludeTagIds);
  const unique = uniqueByPhone(rows);
  let count = unique.size;
  for (const contact of existing) {
    // `existing` lags behind the list while a new lookup is in flight.
    if (!unique.has(contact.normalized)) continue;
    if (contact.tagIds.some((id) => excludedTags.has(id))) count -= 1;
  }
  return count;
}

/**
 * Every contact carrying any of the tags. Paginated because a response
 * cut off at the server's row cap would leave people out of a broadcast
 * or, for exclude tags, message people the user excluded.
 */
export async function fetchContactIdsWithTags(
  supabase: SupabaseClient,
  tagIds: string[],
): Promise<Set<string>> {
  if (tagIds.length === 0) return new Set();

  const { data, error } = await fetchAllInboxPages<
    { contact_id: string },
    { message: string }
  >((from, to) =>
    supabase
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('id')
      .range(from, to),
  );
  if (error) {
    throw new Error(`Falha ao buscar as etiquetas dos contatos: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.contact_id));
}

/** Every contact matching a custom-field rule. */
async function fetchContactIdsByCustomField(
  supabase: SupabaseClient,
  { fieldId, operator, value }: CustomFieldFilter,
): Promise<Set<string>> {
  const { data, error } = await fetchAllInboxPages<
    { contact_id: string },
    { message: string }
  >((from, to) => {
    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);
    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else query = query.ilike('value', `%${value}%`);
    return query.order('id').range(from, to);
  });
  if (error) {
    throw new Error(`Falha no filtro de campo personalizado: ${error.message}`);
  }
  return new Set((data ?? []).map((row) => row.contact_id));
}

async function fetchContactsByIds(
  supabase: SupabaseClient,
  ids: Iterable<string>,
): Promise<Contact[]> {
  const contactIds = [...ids];
  const contacts: Contact[] = [];
  for (let i = 0; i < contactIds.length; i += CONTACT_ID_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds.slice(i, i + CONTACT_ID_CHUNK));
    if (error) {
      throw new Error(`Falha ao buscar os contatos: ${error.message}`);
    }
    contacts.push(...((data ?? []) as Contact[]));
  }
  return contacts;
}

async function fetchAllContacts(supabase: SupabaseClient): Promise<Contact[]> {
  const { data, error } = await fetchAllInboxPages<Contact, { message: string }>(
    (from, to) => supabase.from('contacts').select('*').order('id').range(from, to),
  );
  if (error) {
    throw new Error(`Falha ao buscar os contatos: ${error.message}`);
  }
  return data ?? [];
}

/**
 * Lists arrive as raw phone/name pairs, but broadcast_recipients needs
 * real contacts.id UUIDs. Reuses the contacts that already exist in the
 * account and creates the rest, keeping the order of the list.
 */
export async function upsertListContacts(
  supabase: SupabaseClient,
  owner: { userId: string; accountId: string },
  rows: ListContact[],
): Promise<Contact[]> {
  const unique = uniqueByPhone(rows);
  const phones = [...unique.keys()];
  const byPhone = new Map<string, Contact>();

  for (let i = 0; i < phones.length; i += LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .eq('account_id', owner.accountId)
      .in('phone_normalized', phones.slice(i, i + LOOKUP_CHUNK));
    if (error) {
      throw new Error(`Falha ao localizar os contatos do CSV: ${error.message}`);
    }
    for (const contact of (data ?? []) as Contact[]) {
      byPhone.set(normalizePhone(contact.phone), contact);
    }
  }

  const missing = phones
    .filter((phone) => !byPhone.has(phone))
    .map((phone) => ({
      user_id: owner.userId,
      account_id: owner.accountId,
      phone: unique.get(phone)?.phone,
      name: unique.get(phone)?.name ?? null,
    }));

  for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
    const { data, error } = await supabase
      .from('contacts')
      .insert(missing.slice(i, i + INSERT_CHUNK))
      .select();
    if (error) {
      throw new Error(`Falha ao criar os contatos do CSV: ${error.message}`);
    }
    for (const contact of (data ?? []) as Contact[]) {
      byPhone.set(normalizePhone(contact.phone), contact);
    }
  }

  return phones
    .map((phone) => byPhone.get(phone))
    .filter((contact): contact is Contact => Boolean(contact));
}

/**
 * The contacts a broadcast must reach. Exclusions load first, so a failed
 * lookup aborts before any contact is created or any message goes out.
 */
export async function resolveAudienceContacts(
  supabase: SupabaseClient,
  owner: { userId: string; accountId: string },
  audience: AudienceConfig,
): Promise<Contact[]> {
  const excludedIds = await fetchContactIdsWithTags(
    supabase,
    audience.excludeTagIds ?? [],
  );

  let contacts: Contact[] = [];
  if (audience.type === 'all') {
    contacts = await fetchAllContacts(supabase);
  } else if (audience.type === 'tags' && audience.tagIds?.length) {
    contacts = await fetchContactsByIds(
      supabase,
      await fetchContactIdsWithTags(supabase, audience.tagIds),
    );
  } else if (audience.type === 'custom_field' && audience.customField) {
    contacts = await fetchContactsByIds(
      supabase,
      await fetchContactIdsByCustomField(supabase, audience.customField),
    );
  } else if (
    (audience.type === 'csv' || audience.type === 'manual_list') &&
    audience.csvContacts
  ) {
    contacts = await upsertListContacts(supabase, owner, audience.csvContacts);
  }

  return contacts.filter((contact) => !excludedIds.has(contact.id));
}

/**
 * Estimated recipients for an audience, after exclusions. Returns null
 * while the audience is only partially configured.
 */
export async function estimateAudienceCount(
  supabase: SupabaseClient,
  accountId: string | null | undefined,
  audience: AudienceConfig,
): Promise<number | null> {
  const excludeTagIds = audience.excludeTagIds ?? [];

  if (audience.type === 'csv' || audience.type === 'manual_list') {
    const rows = audience.csvContacts ?? [];
    if (rows.length === 0) return null;
    const existing =
      accountId && excludeTagIds.length > 0
        ? await fetchExistingListContacts(supabase, accountId, rows)
        : [];
    return countListRecipients(rows, existing ?? [], excludeTagIds);
  }

  // null means "every contact in the account".
  let baseIds: Set<string> | null = null;

  if (audience.type === 'tags') {
    if (!audience.tagIds?.length) return null;
    baseIds = await fetchContactIdsWithTags(supabase, audience.tagIds);
  } else if (audience.type === 'custom_field') {
    if (!audience.customField?.fieldId || !audience.customField.value) return null;
    baseIds = await fetchContactIdsByCustomField(supabase, audience.customField);
  }

  const excluded = await fetchContactIdsWithTags(supabase, excludeTagIds);

  if (baseIds) {
    return [...baseIds].filter((id) => !excluded.has(id)).length;
  }

  const { count } = await supabase
    .from('contacts')
    .select('*', { count: 'exact', head: true });
  return Math.max(0, (count ?? 0) - excluded.size);
}
