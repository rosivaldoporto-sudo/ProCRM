import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  countListRecipients,
  estimateAudienceCount,
  fetchContactIdsWithTags,
  fetchExistingListContacts,
  resolveAudienceContacts,
  upsertListContacts,
} from './broadcast-audience';

type Row = Record<string, unknown>;

interface FakeOptions {
  /** Most rows the fake server returns per request, like PostgREST max-rows. */
  maxRows?: number;
  errors?: Record<string, string>;
}

/** In-memory stand-in for the PostgREST builder, covering what the helpers use. */
function fakeDb(tables: Record<string, Row[]>, options: FakeOptions = {}) {
  const inserted: Row[] = [];
  const lookups: { table: string; column: string; values: unknown[] }[] = [];
  const maxRows = options.maxRows ?? 1000;

  const client = {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let range: [number, number] | null = null;
      let head = false;
      let insertRows: Row[] | null = null;

      const builder = {
        select(_columns?: string, opts?: { head?: boolean }) {
          head = Boolean(opts?.head);
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        neq(column: string, value: unknown) {
          filters.push((row) => row[column] !== value);
          return builder;
        },
        ilike(column: string, pattern: string) {
          const needle = pattern.replaceAll('%', '').toLowerCase();
          filters.push((row) => String(row[column]).toLowerCase().includes(needle));
          return builder;
        },
        in(column: string, values: unknown[]) {
          lookups.push({ table, column, values });
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        order() {
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          return builder;
        },
        insert(rows: Row[]) {
          insertRows = rows;
          return builder;
        },
        then(resolve: (result: unknown) => void) {
          if (options.errors?.[table]) {
            return resolve({ data: null, error: { message: options.errors[table] } });
          }
          if (insertRows) {
            const created = insertRows.map((row, i) => ({
              id: `new-${inserted.length + i}`,
              ...row,
            }));
            inserted.push(...created);
            return resolve({ data: created, error: null });
          }
          const matched = (tables[table] ?? []).filter((row) =>
            filters.every((filter) => filter(row)),
          );
          if (head) return resolve({ data: null, count: matched.length, error: null });
          const [from, to] = range ?? [0, matched.length];
          const page = matched.slice(from, Math.min(to + 1, from + maxRows));
          return resolve({ data: page, error: null });
        },
      };
      return builder;
    },
  };

  return { client: client as unknown as SupabaseClient, inserted, lookups };
}

describe('countListRecipients', () => {
  const existing = [
    { phone: '+5511900000001', normalized: '5511900000001', tagIds: ['block'] },
    { phone: '+5511900000002', normalized: '5511900000002', tagIds: ['block', 'vip'] },
    { phone: '+5511900000003', normalized: '5511900000003', tagIds: [] },
  ];
  const rows = [
    { phone: '+5511900000001' },
    { phone: '+5511900000002' },
    { phone: '+5511900000003' },
    { phone: '+5511900000004' },
  ];

  it('counts everyone when no tag is excluded', () => {
    expect(countListRecipients(rows, existing)).toBe(4);
    expect(countListRecipients(rows, existing, [])).toBe(4);
  });

  it('subtracts existing contacts carrying an excluded tag', () => {
    expect(countListRecipients(rows, existing, ['vip'])).toBe(3);
    expect(countListRecipients(rows, existing, ['block'])).toBe(2);
  });

  it('subtracts a contact only once when it has several excluded tags', () => {
    expect(countListRecipients(rows, existing, ['block', 'vip'])).toBe(2);
  });

  it('ignores an excluded contact that has already left the list', () => {
    const remaining = rows.filter((row) => row.phone !== '+5511900000001');
    expect(countListRecipients(remaining, existing, ['vip'])).toBe(2);
    expect(countListRecipients(remaining, [existing[0]], ['block'])).toBe(3);
  });

  it('counts a number once across formats, and ignores rows without digits', () => {
    const messy = [
      { phone: '+5511900000001' },
      { phone: '5511900000001' },
      { phone: '55 11 90000-0001' },
      { phone: 'sem telefone' },
    ];
    expect(countListRecipients(messy, [])).toBe(1);
  });
});

describe('fetchExistingListContacts', () => {
  it('matches across formats and returns the tags of each contact', async () => {
    const { client } = fakeDb({
      contacts: [
        {
          account_id: 'acc',
          name: 'Júnior',
          phone_normalized: '5511900000001',
          contact_tags: [{ tag_id: 'a' }, { tag_id: 'b' }],
        },
        {
          account_id: 'acc',
          name: null,
          phone_normalized: '5511900000002',
          contact_tags: [],
        },
        {
          account_id: 'other',
          name: 'Outra conta',
          phone_normalized: '5511900000003',
          contact_tags: [{ tag_id: 'z' }],
        },
      ],
    });

    const found = await fetchExistingListContacts(client, 'acc', [
      { phone: '+5511900000001' },
      { phone: '5511900000002', name: 'Da lista' },
      { phone: '+5511900000003' },
      { phone: '+5511900000004' },
    ]);

    expect(found).toEqual([
      {
        phone: '+5511900000001',
        name: 'Júnior',
        normalized: '5511900000001',
        tagIds: ['a', 'b'],
      },
      {
        phone: '5511900000002',
        name: 'Da lista',
        normalized: '5511900000002',
        tagIds: [],
      },
    ]);
  });

  it('looks numbers up in chunks small enough for the PostgREST URL cap', async () => {
    const { client, lookups } = fakeDb({ contacts: [] });
    const rows = Array.from({ length: 450 }, (_, i) => ({
      phone: `+55119${String(i).padStart(8, '0')}`,
    }));

    await fetchExistingListContacts(client, 'acc', rows);

    expect(lookups.map((l) => l.values.length)).toEqual([200, 200, 50]);
  });

  it('returns null once cancelled, so a stale result is never published', async () => {
    const { client } = fakeDb({ contacts: [] });
    const found = await fetchExistingListContacts(
      client,
      'acc',
      [{ phone: '+5511900000001' }],
      () => true,
    );
    expect(found).toBeNull();
  });

  it('throws when the lookup fails', async () => {
    const { client } = fakeDb({}, { errors: { contacts: 'boom' } });
    await expect(
      fetchExistingListContacts(client, 'acc', [{ phone: '+5511900000001' }]),
    ).rejects.toThrow('boom');
  });
});

describe('fetchContactIdsWithTags', () => {
  it('reads past the server row cap, so no excluded contact is missed', async () => {
    const links = Array.from({ length: 7 }, (_, i) => ({
      contact_id: `c${i}`,
      tag_id: 'block',
    }));
    const { client } = fakeDb({ contact_tags: links }, { maxRows: 3 });

    const ids = await fetchContactIdsWithTags(client, ['block']);

    expect(ids.size).toBe(7);
  });

  it('skips the query when no tag is selected', async () => {
    const { client, lookups } = fakeDb({ contact_tags: [] });
    expect((await fetchContactIdsWithTags(client, [])).size).toBe(0);
    expect(lookups).toEqual([]);
  });

  it('throws when the lookup fails rather than excluding nobody', async () => {
    const { client } = fakeDb({}, { errors: { contact_tags: 'boom' } });
    await expect(fetchContactIdsWithTags(client, ['block'])).rejects.toThrow('boom');
  });
});

describe('upsertListContacts', () => {
  const owner = { userId: 'user-1', accountId: 'acc' };

  it('reuses a contact saved without + instead of colliding on the unique index', async () => {
    const stored = {
      id: 'c1',
      account_id: 'acc',
      user_id: 'user-1',
      phone: '5511900000001',
      phone_normalized: '5511900000001',
    };
    const { client, inserted } = fakeDb({ contacts: [stored] });

    const result = await upsertListContacts(client, owner, [{ phone: '+5511900000001' }]);

    expect(inserted).toEqual([]);
    expect(result.map((c) => c.id)).toEqual(['c1']);
  });

  it('reuses a contact created by another user of the same account', async () => {
    const stored = {
      id: 'c1',
      account_id: 'acc',
      user_id: 'colleague',
      phone: '+5511900000001',
      phone_normalized: '5511900000001',
    };
    const { client, inserted } = fakeDb({ contacts: [stored] });

    const result = await upsertListContacts(client, owner, [{ phone: '+5511900000001' }]);

    expect(inserted).toEqual([]);
    expect(result.map((c) => c.id)).toEqual(['c1']);
  });

  it('creates a number once when the list repeats it in two formats', async () => {
    const { client, inserted } = fakeDb({ contacts: [] });

    const result = await upsertListContacts(client, owner, [
      { phone: '+5511900000001', name: 'Ana' },
      { phone: '5511900000001' },
    ]);

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      phone: '+5511900000001',
      name: 'Ana',
      user_id: 'user-1',
      account_id: 'acc',
    });
    expect(result).toHaveLength(1);
  });

  it('keeps the order of the list across existing and new contacts', async () => {
    const stored = {
      id: 'c2',
      account_id: 'acc',
      phone: '5511900000002',
      phone_normalized: '5511900000002',
    };
    const { client } = fakeDb({ contacts: [stored] });

    const result = await upsertListContacts(client, owner, [
      { phone: '+5511900000001' },
      { phone: '+5511900000002' },
    ]);

    expect(result.map((c) => c.phone)).toEqual(['+5511900000001', '5511900000002']);
  });
});

describe('resolveAudienceContacts', () => {
  const owner = { userId: 'user-1', accountId: 'acc' };
  /** Fake contacts past the row cap, so a missing pagination shows up. */
  const manyContacts = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    account_id: 'acc',
    phone: `+551190000000${i}`,
    phone_normalized: `551190000000${i}`,
  }));

  it('reads every contact past the server row cap for "all contacts"', async () => {
    const { client } = fakeDb({ contacts: manyContacts }, { maxRows: 3 });

    const contacts = await resolveAudienceContacts(client, owner, { type: 'all' });

    expect(contacts).toHaveLength(7);
  });

  it('reads every contact of a tag past the server row cap', async () => {
    const contacts = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, phone: `${i}` }));
    const { client } = fakeDb(
      {
        contacts,
        contact_tags: contacts.map((c, i) => ({
          id: `l${i}`,
          contact_id: c.id,
          tag_id: 'vip',
        })),
      },
      { maxRows: 150 },
    );

    const result = await resolveAudienceContacts(client, owner, {
      type: 'tags',
      tagIds: ['vip'],
    });

    expect(result).toHaveLength(250);
  });

  it('reads every contact of a custom-field rule past the server row cap', async () => {
    const contacts = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, phone: `${i}` }));
    const { client } = fakeDb(
      {
        contacts,
        contact_custom_values: contacts.map((c, i) => ({
          id: `v${i}`,
          contact_id: c.id,
          custom_field_id: 'city',
          value: 'Curitiba',
        })),
      },
      { maxRows: 150 },
    );

    const result = await resolveAudienceContacts(client, owner, {
      type: 'custom_field',
      customField: { fieldId: 'city', operator: 'is', value: 'Curitiba' },
    });

    expect(result).toHaveLength(250);
  });

  it('applies each custom-field operator', async () => {
    const tables = {
      contacts: [
        { id: 'a', phone: '1' },
        { id: 'b', phone: '2' },
      ],
      contact_custom_values: [
        { id: 'v1', contact_id: 'a', custom_field_id: 'city', value: 'Curitiba' },
        { id: 'v2', contact_id: 'b', custom_field_id: 'city', value: 'Londrina' },
      ],
    };
    const idsFor = async (operator: 'is' | 'is_not' | 'contains', value: string) => {
      const result = await resolveAudienceContacts(fakeDb(tables).client, owner, {
        type: 'custom_field',
        customField: { fieldId: 'city', operator, value },
      });
      return result.map((c) => c.id);
    };

    expect(await idsFor('is', 'Curitiba')).toEqual(['a']);
    expect(await idsFor('is_not', 'Curitiba')).toEqual(['b']);
    expect(await idsFor('contains', 'londr')).toEqual(['b']);
  });

  it('asks for contacts by id in chunks short enough for the URL cap', async () => {
    const contacts = Array.from({ length: 250 }, (_, i) => ({ id: `c${i}`, phone: `${i}` }));
    const { client, lookups } = fakeDb({
      contacts,
      contact_tags: contacts.map((c, i) => ({
        id: `l${i}`,
        contact_id: c.id,
        tag_id: 'vip',
      })),
    });

    const result = await resolveAudienceContacts(client, owner, {
      type: 'tags',
      tagIds: ['vip'],
    });

    expect(result).toHaveLength(250);
    expect(
      lookups.filter((l) => l.table === 'contacts').map((l) => l.values.length),
    ).toEqual([100, 100, 50]);
  });

  it('removes excluded contacts from every kind of audience', async () => {
    const tables = {
      contacts: manyContacts,
      contact_tags: [{ id: 'l1', contact_id: 'c0', tag_id: 'block' }],
    };

    const all = await resolveAudienceContacts(fakeDb(tables).client, owner, {
      type: 'all',
      excludeTagIds: ['block'],
    });
    expect(all.map((c) => c.id)).not.toContain('c0');
    expect(all).toHaveLength(6);

    const list = await resolveAudienceContacts(fakeDb(tables).client, owner, {
      type: 'manual_list',
      csvContacts: [{ phone: '+5511900000000' }, { phone: '+5511900000001' }],
      excludeTagIds: ['block'],
    });
    expect(list.map((c) => c.id)).toEqual(['c1']);
  });

  it('creates no contact when the exclude lookup fails', async () => {
    const { client, inserted } = fakeDb({}, { errors: { contact_tags: 'boom' } });

    await expect(
      resolveAudienceContacts(client, owner, {
        type: 'manual_list',
        csvContacts: [{ phone: '+5511900000001' }],
        excludeTagIds: ['block'],
      }),
    ).rejects.toThrow('boom');
    expect(inserted).toEqual([]);
  });

  it('throws when the contacts fail to load, instead of sending to a partial audience', async () => {
    const { client } = fakeDb({}, { errors: { contacts: 'boom' } });
    await expect(
      resolveAudienceContacts(client, owner, { type: 'all' }),
    ).rejects.toThrow('boom');
  });
});

describe('estimateAudienceCount', () => {
  it('counts a tag audience past the server row cap', async () => {
    const links = Array.from({ length: 7 }, (_, i) => ({
      id: `l${i}`,
      contact_id: `c${i}`,
      tag_id: 'vip',
    }));
    const { client } = fakeDb({ contact_tags: links }, { maxRows: 3 });

    expect(
      await estimateAudienceCount(client, 'acc', { type: 'tags', tagIds: ['vip'] }),
    ).toBe(7);
  });

  it('counts a custom-field audience past the server row cap', async () => {
    const values = Array.from({ length: 7 }, (_, i) => ({
      id: `v${i}`,
      contact_id: `c${i}`,
      custom_field_id: 'city',
      value: 'Curitiba',
    }));
    const { client } = fakeDb({ contact_custom_values: values }, { maxRows: 3 });

    expect(
      await estimateAudienceCount(client, 'acc', {
        type: 'custom_field',
        customField: { fieldId: 'city', operator: 'is', value: 'Curitiba' },
      }),
    ).toBe(7);
  });

  it('applies exclude tags to pasted lists', async () => {
    const { client } = fakeDb({
      contacts: [
        {
          account_id: 'acc',
          name: 'A',
          phone_normalized: '5511900000001',
          contact_tags: [{ tag_id: 'block' }],
        },
      ],
    });
    const audience = {
      type: 'manual_list' as const,
      csvContacts: [{ phone: '+5511900000001' }, { phone: '+5511900000002' }],
    };

    expect(await estimateAudienceCount(client, 'acc', audience)).toBe(2);
    expect(
      await estimateAudienceCount(client, 'acc', { ...audience, excludeTagIds: ['block'] }),
    ).toBe(1);
  });

  it('subtracts exclude tags from "all contacts"', async () => {
    const { client } = fakeDb({
      contacts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      contact_tags: [{ id: '1', contact_id: 'a', tag_id: 'block' }],
    });

    expect(
      await estimateAudienceCount(client, 'acc', { type: 'all', excludeTagIds: ['block'] }),
    ).toBe(2);
  });

  it('subtracts exclude tags from a tag audience, once per contact', async () => {
    const { client } = fakeDb({
      contact_tags: [
        { id: '1', contact_id: 'a', tag_id: 'vip' },
        { id: '2', contact_id: 'b', tag_id: 'vip' },
        { id: '3', contact_id: 'b', tag_id: 'block' },
      ],
    });

    expect(
      await estimateAudienceCount(client, 'acc', {
        type: 'tags',
        tagIds: ['vip'],
        excludeTagIds: ['block'],
      }),
    ).toBe(1);
  });

  it('returns null while the audience is only partially configured', async () => {
    const { client } = fakeDb({});
    expect(await estimateAudienceCount(client, 'acc', { type: 'tags' })).toBeNull();
    expect(await estimateAudienceCount(client, 'acc', { type: 'csv' })).toBeNull();
    expect(
      await estimateAudienceCount(client, 'acc', {
        type: 'custom_field',
        customField: { fieldId: '', operator: 'is', value: '' },
      }),
    ).toBeNull();
  });
});
