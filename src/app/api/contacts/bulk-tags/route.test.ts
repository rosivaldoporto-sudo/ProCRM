import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requireRole: vi.fn() }));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

import { BULK_TAG_BATCH_SIZE, runBulkTagAction } from '@/lib/contacts/bulk-tags';
import { POST } from './route';

const ACCOUNT = 'account-1';
const TAG = '22222222-2222-4222-8222-222222222222';
const OTHER_TAG = '22222222-2222-4222-8222-333333333333';

const contactId = (i: number) =>
  `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`;
const contactIds = (n: number) => Array.from({ length: n }, (_, i) => contactId(i));

interface FakeError {
  code?: string;
  message: string;
}

/**
 * The PostgREST behaviour the route depends on: ids in the URL have a cap,
 * a duplicate is skipped with `ignoreDuplicates`, and only the rows really
 * written come back. Each awaited query counts as a round trip.
 */
function fakeDb(contacts: Map<string, string>, tags: Map<string, string>) {
  const links = new Set<string>();
  const state = {
    links,
    roundTrips: 0,
    longestInList: 0,
    /** Falha a N-ésima gravação, contando a partir de 1. */
    failWriteNumber: null as number | null,
    failWritesUntilRecovered: 0,
    writes: 0,
  };

  const key = (contact: string, tag: string) => `${contact}:${tag}`;

  function shouldFailWrite(): FakeError | null {
    state.writes += 1;
    if (state.failWritesUntilRecovered > 0) {
      state.failWritesUntilRecovered -= 1;
      return { code: '57014', message: 'statement timeout' };
    }
    if (state.failWriteNumber !== null && state.writes >= state.failWriteNumber) {
      return { code: '57014', message: 'statement timeout' };
    }
    return null;
  }

  const db = {
    from(table: string) {
      const filters: Record<string, string> = {};
      let inList: string[] | null = null;
      let op: 'select' | 'upsert' | 'delete' = 'select';
      let rows: { contact_id: string; tag_id: string }[] = [];

      const run = (): { data: unknown; error: FakeError | null } => {
        state.roundTrips += 1;
        if (table === 'tags') {
          const found = tags.get(filters.id) === filters.account_id;
          return { data: found ? { id: filters.id } : null, error: null };
        }
        if (table === 'contacts') {
          const owned = (inList ?? []).filter(
            (id) => contacts.get(id) === filters.account_id
          );
          return { data: owned.map((id) => ({ id })), error: null };
        }
        const failure = shouldFailWrite();
        if (failure) return { data: null, error: failure };
        if (op === 'upsert') {
          const inserted = rows.filter(
            (row) => !links.has(key(row.contact_id, row.tag_id))
          );
          inserted.forEach((row) => links.add(key(row.contact_id, row.tag_id)));
          return {
            data: inserted.map((row) => ({ contact_id: row.contact_id })),
            error: null,
          };
        }
        const removed = (inList ?? []).filter((id) =>
          links.delete(key(id, filters.tag_id))
        );
        return { data: removed.map((id) => ({ contact_id: id })), error: null };
      };

      const builder = {
        select: () => builder,
        eq(column: string, value: string) {
          filters[column] = value;
          return builder;
        },
        in(_column: string, values: string[]) {
          state.longestInList = Math.max(state.longestInList, values.length);
          inList = values;
          return builder;
        },
        upsert(values: typeof rows, options: { onConflict: string }) {
          expect(options.onConflict).toBe('contact_id,tag_id');
          op = 'upsert';
          rows = values;
          return builder;
        },
        delete() {
          op = 'delete';
          return builder;
        },
        maybeSingle: () => Promise.resolve(run()),
        then(
          resolve: (value: { data: unknown; error: FakeError | null }) => unknown
        ) {
          return Promise.resolve(run()).then(resolve);
        },
      };
      return builder;
    },
  };

  return { db, state };
}

function setup(count = 1000) {
  const contacts = new Map(contactIds(count).map((id) => [id, ACCOUNT]));
  const tags = new Map([[TAG, ACCOUNT]]);
  const { db, state } = fakeDb(contacts, tags);
  mocks.requireRole.mockImplementation(async () => ({
    supabase: db,
    accountId: ACCOUNT,
    // Conta nova a cada chamada: o limite de taxa não é o assunto daqui.
    userId: `user-${Math.random()}`,
    role: 'agent',
  }));
  return { state, contacts, tags };
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/contacts/bulk-tags', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

/** O caminho inteiro da tela: o navegador divide e a rota grava. */
function runThroughRoute(
  ids: string[],
  action: 'add' | 'remove' = 'add',
  onProgress?: (progress: { done: number; total: number }) => void
) {
  const wait = vi.fn(() => Promise.resolve());
  const request = vi.fn((url: string, init: RequestInit) =>
    POST(new Request(`http://localhost${url}`, init as RequestInit))
  );
  return runBulkTagAction({
    contactIds: ids,
    tagId: TAG,
    action,
    onProgress,
    request,
    wait,
  }).then((outcome) => ({ outcome, request, wait }));
}

beforeEach(() => {
  mocks.requireRole.mockReset();
});

describe('etiquetar 1000 contatos selecionados', () => {
  it('grava todos, em lotes, com poucas idas ao banco', async () => {
    const { state } = setup();
    const progress: number[] = [];

    const { outcome, request } = await runThroughRoute(
      contactIds(1000),
      'add',
      ({ done }) => progress.push(done)
    );

    expect(outcome).toMatchObject({
      total: 1000,
      changed: 1000,
      unchanged: 0,
      notFound: 0,
      failedIds: [],
      error: null,
    });
    expect(state.links.size).toBe(1000);
    expect(request).toHaveBeenCalledTimes(10);
    // Antes eram 3 idas por contato: 3000 para este lote.
    expect(state.roundTrips).toBe(30);
    expect(state.longestInList).toBeLessThanOrEqual(BULK_TAG_BATCH_SIZE);
    expect(progress).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900, 1000,
    ]);
  });

  it('repetir o lote não duplica e conta quem já tinha a etiqueta', async () => {
    const { state } = setup();
    await runThroughRoute(contactIds(1000));

    const { outcome } = await runThroughRoute(contactIds(1000));

    expect(outcome).toMatchObject({ changed: 0, unchanged: 1000 });
    expect(state.links.size).toBe(1000);
  });

  it('para no lote que falha e devolve exatamente quem ficou de fora', async () => {
    const { state } = setup();
    state.failWriteNumber = 6;

    const { outcome, wait } = await runThroughRoute(contactIds(1000));

    expect(outcome.changed).toBe(500);
    expect(state.links.size).toBe(500);
    expect(outcome.failedIds).toEqual(contactIds(1000).slice(500));
    expect(outcome.error).toBe(
      'Não foi possível gravar as etiquetas. Tente novamente.'
    );
    // Erro do servidor pode passar sozinho: tenta de novo antes de desistir.
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('termina o lote ao repetir só quem ficou de fora', async () => {
    const { state } = setup();
    state.failWriteNumber = 6;
    const first = await runThroughRoute(contactIds(1000));
    state.failWriteNumber = null;

    const { outcome } = await runThroughRoute(first.outcome.failedIds);

    expect(outcome).toMatchObject({ changed: 500, failedIds: [], error: null });
    expect(state.links.size).toBe(1000);
  });

  it('recupera sozinho de uma falha passageira', async () => {
    const { state } = setup();
    state.failWritesUntilRecovered = 1;

    const { outcome, wait } = await runThroughRoute(contactIds(1000));

    expect(outcome).toMatchObject({ changed: 1000, error: null });
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('não repete um erro que não passa sozinho', async () => {
    const { tags } = setup();
    tags.clear(); // etiqueta excluída por outra pessoa no meio do caminho

    const { outcome, request, wait } = await runThroughRoute(contactIds(1000));

    expect(outcome.error).toBe('Etiqueta não encontrada');
    expect(outcome.failedIds).toHaveLength(1000);
    expect(request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('um contato excluído no meio do caminho não derruba o lote', async () => {
    const { contacts, state } = setup();
    contacts.delete(contactId(7));

    const { outcome } = await runThroughRoute(contactIds(1000));

    expect(outcome).toMatchObject({ changed: 999, notFound: 1, error: null });
    expect(state.links.size).toBe(999);
  });
});

describe('remover etiqueta em massa', () => {
  it('conta só quem realmente tinha a etiqueta', async () => {
    const { state } = setup();
    await runThroughRoute(contactIds(400));

    const { outcome } = await runThroughRoute(contactIds(1000), 'remove');

    expect(outcome).toMatchObject({ changed: 400, unchanged: 600, error: null });
    expect(state.links.size).toBe(0);
    expect(state.longestInList).toBeLessThanOrEqual(BULK_TAG_BATCH_SIZE);
  });
});

describe('POST /api/contacts/bulk-tags', () => {
  it('exige ao menos o papel de agente', async () => {
    setup();
    await post({ contact_ids: [contactId(1)], tag_id: TAG, action: 'add' });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
  });

  it('não grava contato de outra conta', async () => {
    const { contacts, state } = setup(2);
    contacts.set(contactId(1), 'other-account');

    const response = await post({
      contact_ids: contactIds(2),
      tag_id: TAG,
      action: 'add',
    });

    expect(await response.json()).toEqual({
      ok: true,
      changed: 1,
      unchanged: 0,
      not_found: 1,
    });
    expect(state.links.has(`${contactId(1)}:${TAG}`)).toBe(false);
  });

  it('não aceita etiqueta de outra conta', async () => {
    const { state } = setup();

    const response = await post({
      contact_ids: [contactId(1)],
      tag_id: OTHER_TAG,
      action: 'add',
    });

    expect(response.status).toBe(404);
    expect(state.links.size).toBe(0);
  });

  it.each([
    ['sem contatos', { contact_ids: [], tag_id: TAG }],
    ['sem etiqueta', { contact_ids: [contactId(1)] }],
    ['id inválido', { contact_ids: ['abc'], tag_id: TAG }],
    ['etiqueta inválida', { contact_ids: [contactId(1)], tag_id: 'abc' }],
    ['ação inválida', { contact_ids: [contactId(1)], tag_id: TAG, action: 'x' }],
    ['lote acima do teto', { contact_ids: contactIds(BULK_TAG_BATCH_SIZE + 1), tag_id: TAG }],
    ['contact_ids não é lista', { contact_ids: 'abc', tag_id: TAG }],
  ])('recusa o pedido: %s', async (_label, body) => {
    const { state } = setup();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(state.roundTrips).toBe(0);
  });

  it('o erro do banco não vaza para a resposta', async () => {
    const { state } = setup();
    state.failWriteNumber = 1;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const response = await post({
      contact_ids: [contactId(1)],
      tag_id: TAG,
      action: 'add',
    });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('statement timeout');
    consoleError.mockRestore();
  });
});
