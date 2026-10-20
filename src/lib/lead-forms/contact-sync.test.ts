import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { syncLeadRecords, type SyncLeadArgs } from './contact-sync';

interface FakeData {
  /** Candidatos retornados pela busca por telefone (findExistingContact). */
  phoneCandidates?: Array<{ id: string; phone: string }>;
  stage?: { id: string; pipeline_id: string } | null;
  contactInsertId?: string | null;
  dealInsertId?: string | null;
}

interface Call {
  table: string;
  op: 'select' | 'insert' | 'update';
  payload?: Record<string, unknown>;
}

function fakeDb(data: FakeData = {}): { db: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];

  function from(table: string) {
    let op: Call['op'] = 'select';
    let payload: Record<string, unknown> | undefined;

    const builder: Record<string, unknown> = {};

    const resolved = () => {
      if (table === 'pipeline_stages') {
        return { data: data.stage ?? null, error: null };
      }
      if (table === 'contacts') {
        return { data: null, error: null };
      }
      return { data: null, error: null };
    };

    Object.assign(builder, {
      select: () => builder,
      insert: (row: Record<string, unknown>) => {
        op = 'insert';
        payload = row;
        calls.push({ table, op, payload });
        return builder;
      },
      update: (row: Record<string, unknown>) => {
        op = 'update';
        payload = row;
        calls.push({ table, op, payload });
        return builder;
      },
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      like: () => Promise.resolve({ data: data.phoneCandidates ?? [], error: null }),
      maybeSingle: () => Promise.resolve(resolved()),
      single: () => {
        if (table === 'contacts' && op === 'insert') {
          return Promise.resolve({
            data: data.contactInsertId ? { id: data.contactInsertId } : null,
            error: null,
          });
        }
        if (table === 'deals' && op === 'insert') {
          return Promise.resolve({
            data: data.dealInsertId ? { id: data.dealInsertId } : null,
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      // UPDATE ... EQ() é awaited diretamente (sem maybeSingle).
      then: (
        onFulfilled?: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected),
    });

    return builder;
  }

  return { db: { from } as unknown as SupabaseClient, calls };
}

const baseArgs: SyncLeadArgs = {
  accountId: 'acc-1',
  ownerId: 'user-1',
  formName: 'Diagnóstico',
  contact: { name: 'Ana', email: 'ana@example.com', phone: '(11) 99999-9999' },
  tracking: { utm_source: 'google', utm_campaign: 'black-friday' },
  settings: { create_contact: true, create_deal: true },
};

describe('syncLeadRecords', () => {
  it('updates the partial contact/deal instead of creating duplicates', async () => {
    const { db, calls } = fakeDb();
    const result = await syncLeadRecords(db, {
      ...baseArgs,
      existingContactId: 'contact-1',
      existingDealId: 'deal-1',
    });

    expect(result).toEqual({ contactId: 'contact-1', dealId: 'deal-1' });
    expect(calls.filter((c) => c.table === 'contacts' && c.op === 'insert')).toHaveLength(0);
    expect(calls.filter((c) => c.table === 'deals' && c.op === 'insert')).toHaveLength(0);

    const contactUpdate = calls.find((c) => c.table === 'contacts' && c.op === 'update');
    expect(contactUpdate?.payload).toMatchObject({
      name: 'Ana',
      email: 'ana@example.com',
      utm_source: 'google',
    });
    // Telefone existente (possivelmente do WhatsApp) não é sobrescrito.
    expect(contactUpdate?.payload).not.toHaveProperty('phone');

    const dealUpdate = calls.find((c) => c.table === 'deals' && c.op === 'update');
    expect(dealUpdate?.payload).toMatchObject({ title: 'Ana — Diagnóstico' });
  });

  it('dedupes by phone and reuses the contact when no id was carried over', async () => {
    const { db, calls } = fakeDb({
      phoneCandidates: [{ id: 'contact-whatsapp', phone: '5511999999999' }],
      stage: { id: 'stage-1', pipeline_id: 'pipe-1' },
      dealInsertId: 'deal-new',
    });
    const result = await syncLeadRecords(db, {
      ...baseArgs,
      settings: { create_contact: true, create_deal: true, qualified_pipeline_stage_id: 'stage-1' },
    });

    expect(result).toEqual({ contactId: 'contact-whatsapp', dealId: 'deal-new' });
    expect(calls.filter((c) => c.table === 'contacts' && c.op === 'insert')).toHaveLength(0);
    const dealInsert = calls.find((c) => c.table === 'deals' && c.op === 'insert');
    expect(dealInsert?.payload).toMatchObject({
      contact_id: 'contact-whatsapp',
      pipeline_id: 'pipe-1',
      stage_id: 'stage-1',
    });
  });

  it('creates a contact when the phone is new', async () => {
    const { db, calls } = fakeDb({
      phoneCandidates: [],
      contactInsertId: 'contact-new',
    });
    const result = await syncLeadRecords(db, {
      ...baseArgs,
      settings: { create_contact: true, create_deal: false },
    });

    expect(result).toEqual({ contactId: 'contact-new', dealId: null });
    const contactInsert = calls.find((c) => c.table === 'contacts' && c.op === 'insert');
    expect(contactInsert?.payload).toMatchObject({
      account_id: 'acc-1',
      user_id: 'user-1',
      name: 'Ana',
      phone: '(11) 99999-9999',
      utm_source: 'google',
    });
    expect(calls.filter((c) => c.table === 'deals' && c.op === 'insert')).toHaveLength(0);
  });

  it('respects create_contact=false', async () => {
    const { db, calls } = fakeDb();
    const result = await syncLeadRecords(db, {
      ...baseArgs,
      settings: { create_contact: false, create_deal: true },
    });

    expect(result).toEqual({ contactId: null, dealId: null });
    expect(calls).toHaveLength(0);
  });
});
