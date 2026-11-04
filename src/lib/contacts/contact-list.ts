// ============================================================
// Consultas da tela de contatos, seguras para volume alto.
//
// O Supabase impõe dois limites que falham em silêncio:
//   - uma resposta traz no máximo 1.000 linhas, mesmo pedindo mais;
//   - `.in(...)` coloca os valores na URL, e uma URL longa demais é recusada.
// Por isso as páginas grandes vêm em blocos e as buscas por id, em pedaços.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { searchPattern } from '@/lib/inbox/query';
import type { Contact } from '@/types';

/** Teto de linhas por resposta (`db-max-rows`) no padrão do Supabase. */
const MAX_ROWS_PER_RESPONSE = 1000;
/** 100 UUIDs ocupam cerca de 4 KB de URL. */
const CONTACT_ID_CHUNK = 100;
/** Um telefone normalizado é bem mais curto que um UUID. */
const PHONE_CHUNK = 200;
/** Pedaços em paralelo: acelera sem abrir dezenas de conexões de uma vez. */
const LOOKUP_CONCURRENCY = 4;

export interface ContactPageQuery {
  from: number;
  pageSize: number;
  term: string;
  tagIds: string[];
  /** Canal: 'whatsapp', 'uazapi' ou nulo para todos. */
  source: string | null;
}

export interface ContactPage {
  rows: Contact[];
  total: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  isCancelled: () => boolean
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length && !isCancelled()) {
        await worker(items[next++]);
      }
    }
  );
  await Promise.all(runners);
}

async function readBlock(
  supabase: SupabaseClient,
  query: ContactPageQuery,
  offset: number,
  limit: number,
  wantsCount: boolean
): Promise<ContactPage> {
  const { term, tagIds, source } = query;

  if (tagIds.length > 0 || source) {
    // Etiqueta e/ou canal resolvem no servidor (migrations 025, 056 e 062).
    const { data, error } = await supabase.rpc('filter_contacts_by_tags', {
      p_tag_ids: tagIds,
      p_search: term || null,
      p_limit: limit,
      p_offset: offset,
      p_source: source,
    });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { contact: Contact; total_count: number }[];
    return {
      rows: rows.map((row) => row.contact),
      total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    };
  }

  // `id` desempata: um lote importado tem o mesmo created_at, e sem desempate
  // a mesma linha pode cair em duas páginas e outra não aparecer em nenhuma.
  let request = supabase
    .from('contacts')
    .select('*', wantsCount ? { count: 'exact' } : undefined)
    .order('created_at', { ascending: false })
    .order('id')
    .range(offset, offset + limit - 1);

  if (term) {
    const like = searchPattern(term);
    request = request.or(
      `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
    );
  }

  const { data, count, error } = await request;
  if (error) {
    // Página além do fim, por exemplo depois de excluir a última inteira.
    if (error.code === 'PGRST103') return { rows: [], total: 0 };
    throw new Error(error.message);
  }
  return { rows: (data ?? []) as Contact[], total: count ?? 0 };
}

/**
 * Lê uma página inteira, mesmo maior que o teto de linhas por resposta.
 * Devolve nulo se a leitura foi cancelada. Um erro em qualquer bloco
 * rejeita a promessa: nunca publica uma página pela metade.
 */
export async function fetchContactPage(
  supabase: SupabaseClient,
  query: ContactPageQuery,
  isCancelled: () => boolean = () => false
): Promise<ContactPage | null> {
  const rows: Contact[] = [];
  let total = 0;

  while (rows.length < query.pageSize) {
    const block = await readBlock(
      supabase,
      query,
      query.from + rows.length,
      Math.min(query.pageSize - rows.length, MAX_ROWS_PER_RESPONSE),
      rows.length === 0
    );
    if (isCancelled()) return null;
    if (rows.length === 0) total = block.total;
    rows.push(...block.rows);
    if (block.rows.length === 0 || query.from + rows.length >= total) break;
  }

  return { rows, total };
}

/**
 * Ids das etiquetas de cada contato. Devolve nulo se foi cancelada.
 * Um contato sem etiquetas simplesmente não aparece no mapa.
 */
export async function fetchContactTagIds(
  supabase: SupabaseClient,
  contactIds: string[],
  isCancelled: () => boolean = () => false
): Promise<Map<string, string[]> | null> {
  const tagIds = new Map<string, string[]>();

  await runWithConcurrency(
    chunk(contactIds, CONTACT_ID_CHUNK),
    LOOKUP_CONCURRENCY,
    async (ids) => {
      let read = 0;
      // Um pedaço pode passar do teto de linhas se os contatos tiverem
      // muitas etiquetas. A contagem diz se ainda falta alguma.
      while (!isCancelled()) {
        const { data, count, error } = await supabase
          .from('contact_tags')
          .select('contact_id, tag_id', { count: 'exact' })
          .in('contact_id', ids)
          .order('id')
          .range(read, read + MAX_ROWS_PER_RESPONSE - 1);
        if (error) throw new Error(error.message);

        for (const link of data ?? []) {
          const list = tagIds.get(link.contact_id);
          if (list) list.push(link.tag_id);
          else tagIds.set(link.contact_id, [link.tag_id]);
        }

        read += data?.length ?? 0;
        if (!data?.length || read >= (count ?? 0)) break;
      }
    },
    isCancelled
  );

  return isCancelled() ? null : tagIds;
}

export interface DeleteContactsOutcome {
  deleted: number;
  /** O pedaço que falhou e tudo o que vinha depois dele. */
  failedIds: string[];
  failed: boolean;
}

/** Exclui em pedaços e para no primeiro erro, dizendo o que ficou de fora. */
export async function deleteContactsInBatches(
  supabase: SupabaseClient,
  ids: string[],
  onProgress?: (done: number, total: number) => void
): Promise<DeleteContactsOutcome> {
  let deleted = 0;

  for (let i = 0; i < ids.length; i += CONTACT_ID_CHUNK) {
    const batch = ids.slice(i, i + CONTACT_ID_CHUNK);
    const { data, error } = await supabase
      .from('contacts')
      .delete()
      .in('id', batch)
      .select('id');
    if (error) {
      return { deleted, failedIds: ids.slice(i), failed: true };
    }
    deleted += data?.length ?? 0;
    onProgress?.(i + batch.length, ids.length);
  }

  return { deleted, failedIds: [], failed: false };
}

/**
 * Quais telefones de uma lista já existem na conta. Busca só os da lista:
 * ler a conta inteira pararia nas primeiras 1.000 linhas e deixaria passar
 * duplicados, que então só cairiam no índice único, um a um.
 */
export async function fetchExistingPhones(
  supabase: SupabaseClient,
  accountId: string,
  phones: string[]
): Promise<Set<string>> {
  const existing = new Set<string>();

  await runWithConcurrency(
    chunk([...new Set(phones)], PHONE_CHUNK),
    LOOKUP_CONCURRENCY,
    async (batch) => {
      const { data, error } = await supabase
        .from('contacts')
        .select('phone_normalized')
        .eq('account_id', accountId)
        .in('phone_normalized', batch);
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as { phone_normalized: string | null }[]) {
        if (row.phone_normalized) existing.add(row.phone_normalized);
      }
    },
    () => false
  );

  return existing;
}
