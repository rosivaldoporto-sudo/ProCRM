import { beforeEach, describe, expect, it, vi } from 'vitest';

// Webhook da Cloud API de ponta a ponta, com o Supabase simulado: a
// mensagem que vem de um anúncio precisa chegar ao insert com `referral`.

const mocks = vi.hoisted(() => ({
  messageInserts: [] as Record<string, unknown>[],
  insertErrors: [] as unknown[],
  pending: [] as Promise<unknown>[],
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: unknown) => {
      mocks.pending.push(
        Promise.resolve().then(() =>
          typeof task === 'function' ? (task as () => unknown)() : task
        )
      );
    },
  };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      let op: 'select' | 'insert' | 'update' = 'select';
      let insertError: unknown = null;
      const result = () => {
        if (op === 'insert') return { data: null, error: insertError };
        if (op === 'update') return { data: null, error: null };
        if (table === 'whatsapp_config') {
          return {
            data: [
              { account_id: 'acc-1', user_id: 'user-1', access_token: 'enc' },
            ],
            error: null,
          };
        }
        if (table === 'conversations') {
          return {
            data: [
              {
                id: 'conv-1',
                unread_count: 0,
                status: 'open',
                source: 'whatsapp',
                assigned_agent_id: null,
              },
            ],
            error: null,
          };
        }
        if (table === 'messages') return { data: null, count: 0, error: null };
        return { data: [], error: null };
      };
      const builder = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        update: () => {
          op = 'update';
          return builder;
        },
        insert: (row: Record<string, unknown>) => {
          op = 'insert';
          if (table === 'messages') {
            mocks.messageInserts.push({ ...row });
            insertError = mocks.insertErrors.shift() ?? null;
          }
          return builder;
        },
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        then: (
          resolve: (value: unknown) => unknown,
          reject?: (reason: unknown) => unknown
        ) => Promise.resolve(result()).then(resolve, reject),
      };
      return builder;
    },
  }),
}));

vi.mock('@/lib/whatsapp/webhook-signature', () => ({
  verifyMetaWebhookSignature: () => true,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: vi.fn(),
  getMessageDetails: vi.fn(async () => null),
}));
vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: vi.fn(async () => ({
    id: 'contact-1',
    name: 'Ana',
    phone: '5511999990000',
  })),
  resolveContactName: (name: string) => name,
  isUniqueViolation: () => false,
}));
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => {}),
}));
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => ({ consumed: true })),
}));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));
vi.mock('@/lib/deals/auto-create', () => ({ ensureLeadDeal: vi.fn() }));
vi.mock('@/lib/facebook/conversions-api', () => ({ sendCapiEvents: vi.fn() }));
vi.mock('@/lib/push/send', () => ({
  messagePreview: () => '',
  notifyInboundMessage: vi.fn(),
}));

import { handleWebhook } from './webhook-handler';

const AD_REFERRAL = {
  source_url: 'https://fb.me/2ZHeY5pVa',
  source_id: '120210000000000',
  source_type: 'ad',
  headline: 'Consultoria gratuita',
  body: 'Fale com a gente',
  media_type: 'image',
  image_url: 'https://scontent.xx.fbcdn.net/v/ad.jpg',
  thumbnail_url: 'https://scontent.xx.fbcdn.net/v/thumb.jpg',
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
};

function inboundText(referral?: Record<string, unknown>) {
  return {
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '15550000000',
                phone_number_id: 'pn-1',
              },
              contacts: [{ profile: { name: 'Ana' }, wa_id: '5511999990000' }],
              messages: [
                {
                  from: '5511999990000',
                  id: 'wamid.AD1',
                  timestamp: '1760000000',
                  type: 'text',
                  text: { body: 'Olá! Posso ter mais informações sobre isso?' },
                  ...(referral ? { referral } : {}),
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function deliver(payload: unknown) {
  const res = await handleWebhook(
    new Request('https://crm.test/api/whatsapp/webhook/acc-1', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'x-hub-signature-256': 'sha256=test' },
    }),
    'acc-1'
  );
  expect(res.status).toBe(200);
  // Roda o trabalho agendado com after(), inclusive o que ele agenda.
  while (mocks.pending.length) await mocks.pending.shift();
}

describe('webhook da Cloud API — anúncio de origem', () => {
  beforeEach(() => {
    mocks.messageInserts.length = 0;
    mocks.insertErrors.length = 0;
    mocks.pending.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('grava o referral na mensagem que veio de um anúncio', async () => {
    await deliver(inboundText(AD_REFERRAL));

    expect(mocks.messageInserts).toHaveLength(1);
    expect(mocks.messageInserts[0]).toMatchObject({
      message_id: 'wamid.AD1',
      content_text: 'Olá! Posso ter mais informações sobre isso?',
      referral: AD_REFERRAL,
    });
  });

  it('descarta link que não é https antes de gravar', async () => {
    await deliver(
      inboundText({ ...AD_REFERRAL, source_url: 'javascript:alert(1)' })
    );

    const referral = mocks.messageInserts[0].referral as Record<string, unknown>;
    expect(referral.source_url).toBeUndefined();
    expect(referral.headline).toBe('Consultoria gratuita');
  });

  it('mensagem comum não leva a coluna referral no insert', async () => {
    await deliver(inboundText());

    expect(mocks.messageInserts).toHaveLength(1);
    expect(mocks.messageInserts[0]).not.toHaveProperty('referral');
  });

  it('sem a migration 064, grava a mensagem sem o anúncio', async () => {
    mocks.insertErrors.push({
      code: 'PGRST204',
      message:
        "Could not find the 'referral' column of 'messages' in the schema cache",
    });

    await deliver(inboundText(AD_REFERRAL));

    expect(mocks.messageInserts).toHaveLength(2);
    expect(mocks.messageInserts[0]).toHaveProperty('referral');
    expect(mocks.messageInserts[1]).not.toHaveProperty('referral');
    expect(mocks.messageInserts[1]).toMatchObject({ message_id: 'wamid.AD1' });
  });
});
