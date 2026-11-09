import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  checkMarketingToken: vi.fn(),
  calls: [] as Array<{
    table: string;
    op: string;
    values?: Record<string, unknown>;
  }>,
  configRow: null as Record<string, unknown> | null,
  saveError: null as unknown,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));

vi.mock('@/lib/facebook/ctwa-ads', () => ({
  checkMarketingToken: mocks.checkMarketingToken,
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: (typeof mocks.calls)[number] = { table, op: 'select' };
      const result = () => {
        mocks.calls.push(call);
        if (call.op === 'select') return { data: mocks.configRow, error: null };
        if (table === 'meta_ads_config' && call.op !== 'delete')
          return { data: null, error: mocks.saveError };
        return { data: null, error: null };
      };
      const b = {
        select: () => b,
        update: (values: Record<string, unknown>) => {
          call.op = 'update';
          call.values = values;
          return b;
        },
        insert: (values: Record<string, unknown>) => {
          call.op = 'insert';
          call.values = values;
          return b;
        },
        delete: () => {
          call.op = 'delete';
          return b;
        },
        eq: () => b,
        not: () => b,
        maybeSingle: async () => result(),
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve),
      };
      return b;
    },
  }),
}));

import { decrypt } from '@/lib/whatsapp/encryption';
import { DELETE, GET, POST } from './route';

function post(body: unknown) {
  return POST(
    new Request('https://crm.test/api/meta-ads/marketing-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

describe('/api/meta-ads/marketing-token', () => {
  beforeEach(() => {
    mocks.calls.length = 0;
    mocks.configRow = { id: 'cfg-1', access_token: 'enc', marketing_access_token: null };
    mocks.saveError = null;
    mocks.requireRole.mockResolvedValue({
      accountId: 'acc-1',
      userId: `user-${Math.random()}`,
    });
    mocks.checkMarketingToken.mockResolvedValue({
      ok: true,
      adAccounts: [{ id: '111', name: 'Loja' }],
    });
  });

  it('GET diz se há token sem devolvê-lo', async () => {
    mocks.configRow = {
      id: 'cfg-1',
      access_token: 'enc-capi',
      marketing_access_token: 'enc-mkt',
    };
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      has_token: true,
      has_capi_token: true,
      migration_missing: false,
    });
    expect(JSON.stringify(body)).not.toContain('enc-');
  });

  it('GET avisa quando a migration 065 não foi aplicada', async () => {
    mocks.configRow = { id: 'cfg-1', access_token: 'enc' };
    const body = await (await GET()).json();
    expect(body.migration_missing).toBe(true);
  });

  it('exige admin', async () => {
    mocks.requireRole.mockRejectedValue(new Error('forbidden'));
    const res = await post({ access_token: 'EAAB123' });
    expect(res.status).toBe(403);
    expect(mocks.checkMarketingToken).not.toHaveBeenCalled();
  });

  it('salva o token criptografado depois que a Meta aceita', async () => {
    const res = await post({ access_token: '  EAABtoken123  ' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      ad_accounts: [{ id: '111', name: 'Loja' }],
    });
    expect(mocks.checkMarketingToken).toHaveBeenCalledWith({
      accessToken: 'EAABtoken123',
    });
    const update = mocks.calls.find(
      (c) => c.table === 'meta_ads_config' && c.op === 'update'
    );
    const stored = update?.values?.marketing_access_token as string;
    expect(stored).not.toContain('EAABtoken123');
    expect(decrypt(stored)).toBe('EAABtoken123');
    // Limpa as falhas guardadas com o token anterior.
    expect(
      mocks.calls.some((c) => c.table === 'meta_ad_lookups' && c.op === 'delete')
    ).toBe(true);
  });

  it('cria a configuração quando a conta ainda não tem', async () => {
    mocks.configRow = null;
    await post({ access_token: 'EAABtoken123' });
    const insert = mocks.calls.find((c) => c.op === 'insert');
    expect(insert?.values).toMatchObject({ account_id: 'acc-1' });
    expect(decrypt(insert?.values?.marketing_access_token as string)).toBe(
      'EAABtoken123'
    );
  });

  it('não salva token que a Meta recusou', async () => {
    mocks.checkMarketingToken.mockResolvedValue({
      ok: false,
      error: '(#190) Invalid OAuth access token',
    });
    const res = await post({ access_token: 'EAABruim' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('(#190)');
    expect(mocks.calls.some((c) => c.op === 'update' || c.op === 'insert')).toBe(
      false
    );
  });

  it('recusa token vazio, com espaço no meio ou grande demais', async () => {
    for (const access_token of ['', '   ', 'EAAB 123', 'x'.repeat(5000), 42]) {
      const res = await post({ access_token });
      expect(res.status).toBe(400);
    }
    expect(mocks.checkMarketingToken).not.toHaveBeenCalled();
  });

  it('sem a migration 065, explica o que fazer', async () => {
    mocks.saveError = { code: 'PGRST204', message: 'column not found' };
    const res = await post({ access_token: 'EAABtoken123' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('065');
  });

  it('DELETE apaga o token', async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    const update = mocks.calls.find((c) => c.op === 'update');
    expect(update?.values).toMatchObject({ marketing_access_token: null });
  });
});
