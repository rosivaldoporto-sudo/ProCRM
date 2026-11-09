import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from '@/lib/whatsapp/encryption';
import {
  captureAdsAttribution,
  checkMarketingToken,
  enrichAdReferral,
  FAILURE_TTL_MS,
  fetchAdNames,
  readStoredToken,
  resolveAdNames,
  SUCCESS_TTL_MS,
} from './ctwa-ads';

// ------------------------------------------------------------
// Supabase falso: registra cada chamada e responde pelo handler.
// ------------------------------------------------------------
interface Call {
  table: string;
  op: 'select' | 'update' | 'upsert' | 'insert' | 'delete';
  values?: unknown;
  options?: unknown;
  filters: Array<[string, unknown]>;
}
type Reply = { data?: unknown; error?: unknown };

function makeDb(handler: (call: Call) => Reply = () => ({})) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: 'select', filters: [] };
      const run = () => {
        calls.push(call);
        return Promise.resolve({ data: null, error: null, ...handler(call) });
      };
      const b = {
        select: () => b,
        update: (values: unknown) => {
          call.op = 'update';
          call.values = values;
          return b;
        },
        upsert: (values: unknown, options: unknown) => {
          call.op = 'upsert';
          call.values = values;
          call.options = options;
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters.push([col, val]);
          return b;
        },
        maybeSingle: () => run(),
        then: (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown
        ) => run().then(resolve, reject),
      };
      return b;
    },
  };
  return { db: db as unknown as SupabaseClient, calls };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const AD_BODY = {
  id: '120210000000001',
  name: 'Vídeo depoimento 01',
  adset: { id: '120210000000002', name: 'Mulheres 25-45 SP' },
  campaign: { id: '120210000000003', name: 'Black Friday 2026' },
};

const NAMES = {
  ad_name: 'Vídeo depoimento 01',
  adset_id: '120210000000002',
  adset_name: 'Mulheres 25-45 SP',
  campaign_id: '120210000000003',
  campaign_name: 'Black Friday 2026',
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('fetchAdNames', () => {
  it('lê nome do anúncio, do conjunto e da campanha', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(AD_BODY));
    const out = await fetchAdNames({
      adId: '120210000000001',
      accessToken: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual({ ok: true, names: NAMES });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.0\/120210000000001\?fields=/);
    expect(decodeURIComponent(url)).toContain('name,adset{id,name},campaign{id,name}');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer tok'
    );
  });

  it('devolve o erro da Meta', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { message: 'Missing permissions', code: 200 } },
        400
      )
    );
    const out = await fetchAdNames({
      adId: '1',
      accessToken: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ ok: false, error: '(#200) Missing permissions' });
  });

  it('não chama a Meta com ID inválido', async () => {
    const fetchImpl = vi.fn();
    for (const adId of ['', 'abc', '1/../me', '12 34', '1'.repeat(40)]) {
      const out = await fetchAdNames({
        adId,
        accessToken: 'tok',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      expect(out.ok).toBe(false);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('erro de rede vira erro, sem lançar', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('timeout');
    });
    const out = await fetchAdNames({
      adId: '1',
      accessToken: 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ ok: false, error: 'timeout' });
  });
});

describe('checkMarketingToken', () => {
  it('recusa token que a Meta não aceita', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Invalid OAuth access token', code: 190 } }, 400)
    );
    const out = await checkMarketingToken({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ ok: false, error: '(#190) Invalid OAuth access token' });
  });

  it('lista as contas de anúncios que o token enxerga', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/me/adaccounts')
        ? jsonResponse({
            data: [{ account_id: '111', id: 'act_111', name: 'Loja' }],
          })
        : jsonResponse({ id: '999' })
    );
    const out = await checkMarketingToken({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({ ok: true, adAccounts: [{ id: '111', name: 'Loja' }] });
  });

  it('falha ao listar contas vira aviso, não erro', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('/me/adaccounts')
        ? jsonResponse({ error: { message: 'Unsupported', code: 100 } }, 400)
        : jsonResponse({ id: '999' })
    );
    const out = await checkMarketingToken({
      accessToken: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(out).toEqual({
      ok: true,
      adAccounts: [],
      adAccountsError: '(#100) Unsupported',
    });
  });
});

describe('readStoredToken', () => {
  it('descriptografa, aceita texto puro legado e ignora lixo', () => {
    expect(readStoredToken(encrypt('segredo'))).toBe('segredo');
    expect(readStoredToken('EAAB-legado')).toBe('EAAB-legado');
    expect(readStoredToken('aa:bb:cc')).toBeNull();
    expect(readStoredToken(null)).toBeNull();
    expect(readStoredToken('')).toBeNull();
  });
});

describe('resolveAdNames', () => {
  const NOW = Date.parse('2026-11-09T12:00:00Z');
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const cacheRow = (over: Record<string, unknown>) => ({
    ad_name: NAMES.ad_name,
    adset_id: NAMES.adset_id,
    adset_name: NAMES.adset_name,
    campaign_id: NAMES.campaign_id,
    campaign_name: NAMES.campaign_name,
    error: null,
    fetched_at: iso(60_000),
    ...over,
  });

  it('usa o cache recente sem chamar a Meta', async () => {
    const { db } = makeDb((c) =>
      c.table === 'meta_ad_lookups' ? { data: cacheRow({}) } : {}
    );
    const fetchImpl = vi.fn();
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(out).toEqual(NAMES);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('não insiste numa falha recente', async () => {
    const { db } = makeDb((c) =>
      c.table === 'meta_ad_lookups'
        ? { data: cacheRow({ ad_name: null, campaign_name: null, adset_name: null, error: '(#200) x', fetched_at: iso(FAILURE_TTL_MS - 1000) }) }
        : {}
    );
    const fetchImpl = vi.fn();
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('cache vencido: busca com o token de Marketing e grava o cache', async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === 'meta_ad_lookups' && c.op === 'select')
        return { data: cacheRow({ fetched_at: iso(SUCCESS_TTL_MS + 1000) }) };
      if (c.table === 'meta_ads_config')
        return {
          data: {
            marketing_access_token: encrypt('mkt-token'),
            access_token: encrypt('capi-token'),
          },
        };
      return {};
    });
    const fetchImpl = vi.fn(async () => jsonResponse(AD_BODY));
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '120210000000001',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });

    expect(out).toEqual(NAMES);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer mkt-token'
    );
    const upsert = calls.find((c) => c.op === 'upsert');
    expect(upsert?.values).toMatchObject({
      account_id: 'acc',
      ad_id: '120210000000001',
      campaign_name: 'Black Friday 2026',
      error: null,
      fetched_at: new Date(NOW).toISOString(),
    });
    expect(upsert?.options).toEqual({ onConflict: 'account_id,ad_id' });
  });

  it('sem token de Marketing, tenta o da Conversions API', async () => {
    const { db } = makeDb((c) =>
      c.table === 'meta_ads_config'
        ? { data: { access_token: encrypt('capi-token') } }
        : {}
    );
    const fetchImpl = vi.fn(async () => jsonResponse(AD_BODY));
    await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer capi-token'
    );
  });

  it('sem nenhum token não chama a Meta', async () => {
    const { db } = makeDb();
    const fetchImpl = vi.fn();
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(out).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a Meta recusou: guarda o erro e devolve os nomes antigos', async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === 'meta_ad_lookups' && c.op === 'select')
        return { data: cacheRow({ fetched_at: iso(SUCCESS_TTL_MS + 1000) }) };
      if (c.table === 'meta_ads_config')
        return { data: { marketing_access_token: 'plain-token' } };
      return {};
    });
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'Missing permissions', code: 200 } }, 400)
    );
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(out).toEqual(NAMES);
    expect(calls.find((c) => c.op === 'upsert')?.values).toMatchObject({
      error: '(#200) Missing permissions',
      campaign_name: null,
    });
  });

  it('sem a tabela de cache (migration 065 pendente), busca e não grava', async () => {
    const { db, calls } = makeDb((c) => {
      if (c.table === 'meta_ad_lookups')
        return { error: { code: '42P01', message: 'relation does not exist' } };
      if (c.table === 'meta_ads_config')
        return { data: { access_token: 'plain-token' } };
      return {};
    });
    const fetchImpl = vi.fn(async () => jsonResponse(AD_BODY));
    const out = await resolveAdNames({
      db,
      accountId: 'acc',
      adId: '1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: NOW,
    });
    expect(out).toEqual(NAMES);
    expect(calls.some((c) => c.op === 'upsert')).toBe(false);
  });
});

describe('enrichAdReferral', () => {
  const referral = {
    source_id: '120210000000001',
    source_type: 'ad',
    headline: 'Consultoria',
    source_url: 'https://fb.me/x',
  };

  function dbWithToken(extra?: (c: Call) => Reply | undefined) {
    return makeDb((c) => {
      const r = extra?.(c);
      if (r) return r;
      if (c.table === 'meta_ads_config')
        return { data: { marketing_access_token: 'plain-token' } };
      return {};
    });
  }

  it('grava os nomes no referral da mensagem e no contato do mesmo anúncio', async () => {
    const { db, calls } = dbWithToken();
    const fetchImpl = vi.fn(async () => jsonResponse(AD_BODY));
    const out = await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'contact-1',
      referral,
      message: { conversationId: 'conv-1', whatsappMessageId: 'wamid.1' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toEqual(NAMES);
    const msgUpdate = calls.find((c) => c.table === 'messages' && c.op === 'update');
    expect(msgUpdate?.values).toEqual({ referral: { ...referral, ...NAMES } });
    expect(msgUpdate?.filters).toEqual([
      ['conversation_id', 'conv-1'],
      ['message_id', 'wamid.1'],
    ]);
    const contactUpdate = calls.find(
      (c) => c.table === 'contacts' && c.op === 'update'
    );
    expect(contactUpdate?.values).toEqual({
      ad_name: NAMES.ad_name,
      adset_id: NAMES.adset_id,
      adset_name: NAMES.adset_name,
      campaign_id: NAMES.campaign_id,
      campaign_name: NAMES.campaign_name,
      utm_campaign: NAMES.campaign_name,
    });
    // Primeiro anúncio vale: só atualiza o contato cujo anúncio é este.
    expect(contactUpdate?.filters).toEqual([
      ['id', 'contact-1'],
      ['ad_id', '120210000000001'],
    ]);
  });

  it('acha a mensagem pelo id interno (Uazapi)', async () => {
    const { db, calls } = dbWithToken();
    await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'c',
      referral,
      message: { id: 'msg-uuid' },
      fetchImpl: (async () => jsonResponse(AD_BODY)) as unknown as typeof fetch,
    });
    const msgUpdate = calls.find((c) => c.table === 'messages');
    expect(msgUpdate?.filters).toEqual([['id', 'msg-uuid']]);
  });

  it('não grava na mensagem gravada sem a coluna referral', async () => {
    const { db, calls } = dbWithToken();
    await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'c',
      referral,
      message: { id: 'msg-uuid' },
      saveOnMessage: false,
      fetchImpl: (async () => jsonResponse(AD_BODY)) as unknown as typeof fetch,
    });
    expect(calls.some((c) => c.table === 'messages')).toBe(false);
    expect(calls.some((c) => c.table === 'contacts')).toBe(true);
  });

  it('sem as colunas do conjunto (migration 065), grava o resto no contato', async () => {
    let contactUpdates = 0;
    const { db, calls } = dbWithToken((c) => {
      if (c.table === 'contacts' && c.op === 'update') {
        contactUpdates++;
        return contactUpdates === 1
          ? { error: { code: 'PGRST204', message: "Could not find the 'adset_id' column" } }
          : {};
      }
      return undefined;
    });
    await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'c',
      referral,
      message: { id: 'm' },
      fetchImpl: (async () => jsonResponse(AD_BODY)) as unknown as typeof fetch,
    });
    const updates = calls.filter((c) => c.table === 'contacts' && c.op === 'update');
    expect(updates).toHaveLength(2);
    expect(updates[1].values).not.toHaveProperty('adset_id');
    expect(updates[1].values).toHaveProperty('campaign_name', NAMES.campaign_name);
  });

  it('ignora publicação impulsionada e ID inválido', async () => {
    const { db, calls } = dbWithToken();
    const fetchImpl = vi.fn();
    await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'c',
      referral: { ...referral, source_type: 'post' },
      message: { id: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await enrichAdReferral({
      db,
      accountId: 'acc',
      contactId: 'c',
      referral: { ...referral, source_id: 'abc' },
      message: { id: 'm' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});

describe('captureAdsAttribution', () => {
  it('grava o anúncio no contato sem atribuição', async () => {
    const { db, calls } = makeDb();
    await captureAdsAttribution({
      db,
      contactId: 'c',
      conversationId: 'conv',
      ctwaClid: 'clid',
      adId: '123',
      sourceType: 'ad',
    });
    expect(calls.find((c) => c.table === 'contacts' && c.op === 'update')?.values).toMatchObject({
      ctwa_clid: 'clid',
      ad_id: '123',
      ad_source_type: 'ad',
      utm_source: 'facebook',
      utm_campaign: 'click_to_whatsapp',
    });
  });

  it('o primeiro anúncio vale', async () => {
    const { db, calls } = makeDb((c) =>
      c.table === 'contacts' && c.op === 'select'
        ? { data: { ctwa_clid: null, ad_id: '999' } }
        : {}
    );
    await captureAdsAttribution({
      db,
      contactId: 'c',
      conversationId: 'conv',
      adId: '123',
    });
    expect(calls.some((c) => c.op === 'update')).toBe(false);
  });
});
