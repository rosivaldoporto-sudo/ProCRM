import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  deleteContactsInBatches,
  fetchContactPage,
  fetchContactTagIds,
  fetchExistingPhones,
} from './contact-list';

const MAX_ROWS = 1000;
const MAX_IN_VALUES = 200;

interface FakeError {
  code?: string;
  message: string;
}

interface FakeOptions {
  contacts?: { id: string }[];
  /** Vínculos contato-etiqueta. */
  links?: { contact_id: string; tag_id: string }[];
  /** Falha a N-ésima chamada, contando a partir de 1. */
  failCall?: number;
}

/**
 * O PostgREST nos dois limites que importam aqui: corta a resposta em 1000
 * linhas sem erro e recusa uma URL com ids demais.
 */
function fakeSupabase(options: FakeOptions = {}) {
  const contacts = options.contacts ?? [];
  const links = options.links ?? [];
  const log = {
    calls: 0,
    rpcCalls: [] as { p_limit: number; p_offset: number }[],
    orders: [] as string[],
    ranges: [] as [number, number][],
    inSizes: [] as number[],
    counted: [] as boolean[],
  };

  const fail = (): FakeError | null => {
    log.calls += 1;
    return options.failCall === log.calls ? { message: 'boom' } : null;
  };

  const db = {
    rpc(_name: string, args: { p_limit: number; p_offset: number }) {
      log.rpcCalls.push(args);
      const error = fail();
      if (error) return Promise.resolve({ data: null, error });
      const page = contacts
        .slice(args.p_offset, args.p_offset + args.p_limit)
        .slice(0, MAX_ROWS);
      return Promise.resolve({
        data: page.map((contact) => ({ contact, total_count: contacts.length })),
        error: null,
      });
    },
    from(table: string) {
      let range: [number, number] = [0, MAX_ROWS - 1];
      let inValues: string[] | null = null;
      let wantsCount = false;
      let isDelete = false;

      const execute = () => {
        const error = fail();
        if (error) return { data: null, count: null, error };
        if (inValues && inValues.length > MAX_IN_VALUES) {
          return { data: null, count: null, error: { message: 'URI Too Long' } };
        }
        if (isDelete) {
          return { data: (inValues ?? []).map((id) => ({ id })), count: null, error: null };
        }
        const source: Record<string, unknown>[] =
          table === 'contact_tags'
            ? links.filter((link) => inValues?.includes(link.contact_id))
            : table === 'contacts' && inValues
              ? (inValues.slice(0, 3).map((phone) => ({ phone_normalized: phone })))
              : contacts;
        if (wantsCount && range[0] >= source.length && range[0] > 0) {
          return { data: null, count: null, error: { code: 'PGRST103', message: 'range' } };
        }
        return {
          data: source.slice(range[0], range[1] + 1).slice(0, MAX_ROWS),
          count: wantsCount ? source.length : null,
          error: null,
        };
      };

      const builder = {
        select(_columns: string, opts?: { count?: string }) {
          wantsCount = opts?.count === 'exact';
          log.counted.push(wantsCount);
          return builder;
        },
        order(column: string) {
          log.orders.push(column);
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          log.ranges.push(range);
          return builder;
        },
        or: () => builder,
        eq: () => builder,
        in(_column: string, values: string[]) {
          log.inSizes.push(values.length);
          inValues = values;
          return builder;
        },
        delete() {
          isDelete = true;
          return builder;
        },
        then(resolve: (value: ReturnType<typeof execute>) => unknown) {
          return Promise.resolve(execute()).then(resolve);
        },
      };
      return builder;
    },
  };

  return { db: db as unknown as SupabaseClient, log };
}

const contacts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `contact-${i}` }));

const query = (overrides = {}) => ({
  from: 0,
  pageSize: 250,
  term: '',
  tagIds: [],
  source: null,
  ...overrides,
});

describe('fetchContactPage', () => {
  it('lê uma página de 3000 mesmo com o corte de 1000 por resposta', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(5000) });

    const page = await fetchContactPage(db, query({ pageSize: 3000 }));

    expect(page?.rows).toHaveLength(3000);
    expect(new Set(page?.rows.map((row) => row.id)).size).toBe(3000);
    expect(page?.total).toBe(5000);
    expect(log.ranges).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it('com etiqueta, também lê a página inteira pelo RPC', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(5000) });

    const page = await fetchContactPage(
      db,
      query({ pageSize: 2000, tagIds: ['tag-1'] })
    );

    expect(page?.rows).toHaveLength(2000);
    expect(log.rpcCalls.map((call) => call.p_offset)).toEqual([0, 1000]);
  });

  it('usa só uma chamada quando a página cabe em uma resposta', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(5000) });

    await fetchContactPage(db, query());

    expect(log.calls).toBe(1);
  });

  it('não pede além do total', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(1200) });

    const page = await fetchContactPage(db, query({ pageSize: 3000 }));

    expect(page?.rows).toHaveLength(1200);
    expect(log.calls).toBe(2);
  });

  it('não confunde um teto de linhas menor com o fim da lista', async () => {
    // O corte do servidor pode ser menor que o pedido; a contagem manda.
    const { db } = fakeSupabase({ contacts: contacts(1500) });

    const page = await fetchContactPage(db, query({ pageSize: 1500 }));

    expect(page?.rows).toHaveLength(1500);
  });

  it('desempata por id para a paginação ser estável', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(10) });

    await fetchContactPage(db, query());

    expect(log.orders).toEqual(['created_at', 'id']);
  });

  it('só pede a contagem exata no primeiro bloco', async () => {
    const { db, log } = fakeSupabase({ contacts: contacts(5000) });

    await fetchContactPage(db, query({ pageSize: 2000 }));

    expect(log.counted).toEqual([true, false]);
  });

  it('não publica uma página pela metade quando um bloco falha', async () => {
    const { db } = fakeSupabase({ contacts: contacts(5000), failCall: 2 });

    await expect(
      fetchContactPage(db, query({ pageSize: 2000 }))
    ).rejects.toThrow('boom');
  });

  it('devolve vazio quando a página passou do fim', async () => {
    const { db } = fakeSupabase({ contacts: contacts(10) });

    const page = await fetchContactPage(db, query({ from: 250 }));

    expect(page).toEqual({ rows: [], total: 0 });
  });

  it('devolve nulo se foi cancelada', async () => {
    const { db } = fakeSupabase({ contacts: contacts(10) });

    await expect(fetchContactPage(db, query(), () => true)).resolves.toBeNull();
  });
});

describe('fetchContactTagIds', () => {
  const ids = (n: number) => contacts(n).map((contact) => contact.id);

  it('divide 1000 contatos em pedaços curtos para caber na URL', async () => {
    const links = ids(1000).map((id) => ({ contact_id: id, tag_id: 'tag-1' }));
    const { db, log } = fakeSupabase({ links });

    const result = await fetchContactTagIds(db, ids(1000));

    expect(result?.size).toBe(1000);
    expect(Math.max(...log.inSizes)).toBeLessThanOrEqual(100);
    expect(log.inSizes).toHaveLength(10);
  });

  it('reúne todas as etiquetas quando um pedaço passa de 1000 vínculos', async () => {
    const links = ids(100).flatMap((id) =>
      Array.from({ length: 15 }, (_, i) => ({ contact_id: id, tag_id: `tag-${i}` }))
    );
    const { db } = fakeSupabase({ links });

    const result = await fetchContactTagIds(db, ids(100));

    expect(result?.get('contact-99')).toHaveLength(15);
    expect([...(result?.values() ?? [])].flat()).toHaveLength(1500);
  });

  it('avisa o erro em vez de devolver etiquetas faltando', async () => {
    const { db } = fakeSupabase({ failCall: 3 });

    await expect(fetchContactTagIds(db, ids(1000))).rejects.toThrow('boom');
  });

  it('devolve nulo se foi cancelada', async () => {
    const { db } = fakeSupabase();

    await expect(
      fetchContactTagIds(db, ids(10), () => true)
    ).resolves.toBeNull();
  });
});

describe('deleteContactsInBatches', () => {
  const ids = contacts(1000).map((contact) => contact.id);

  it('exclui 1000 em pedaços que cabem na URL e informa o progresso', async () => {
    const { db, log } = fakeSupabase();
    const progress: number[] = [];

    const outcome = await deleteContactsInBatches(db, ids, (done) =>
      progress.push(done)
    );

    expect(outcome).toEqual({ deleted: 1000, failedIds: [], failed: false });
    expect(Math.max(...log.inSizes)).toBeLessThanOrEqual(100);
    expect(progress.at(-1)).toBe(1000);
  });

  it('para no pedaço que falha e devolve quem ficou de fora', async () => {
    const { db } = fakeSupabase({ failCall: 4 });

    const outcome = await deleteContactsInBatches(db, ids);

    expect(outcome.deleted).toBe(300);
    expect(outcome.failed).toBe(true);
    expect(outcome.failedIds).toEqual(ids.slice(300));
  });
});

describe('fetchExistingPhones', () => {
  it('consulta só os telefones da lista, em pedaços e sem repetição', async () => {
    const phones = Array.from({ length: 1500 }, (_, i) => `55119${i}`);
    const { db, log } = fakeSupabase();

    const existing = await fetchExistingPhones(db, 'account-1', [...phones, ...phones]);

    expect(log.inSizes).toHaveLength(8);
    expect(Math.max(...log.inSizes)).toBeLessThanOrEqual(200);
    expect(existing.size).toBeGreaterThan(0);
  });

  it('falha em vez de tratar um número existente como novo', async () => {
    const { db } = fakeSupabase({ failCall: 1 });

    await expect(fetchExistingPhones(db, 'account-1', ['1'])).rejects.toThrow('boom');
  });
});
