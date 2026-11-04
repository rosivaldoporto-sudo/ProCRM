import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Meta's receipts can arrive while the batch that sent those messages is still
// running. These tests run the real send loop, send route and webhook handler
// over one in-memory database, so a receipt lands at that exact moment.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const tables: Record<string, Row[]> = {};

  function from(table: string) {
    const filters: ((row: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let head = false;
    let page: [number, number] | null = null;

    const run = () => {
      const rows = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
      if (patch) rows.forEach((row) => Object.assign(row, patch));
      return page ? rows.slice(page[0], page[1] + 1) : rows;
    };
    const one = async () => ({ data: run()[0] ?? null, error: null });

    const builder = {
      select(_columns?: string, options?: { head?: boolean }) {
        head = Boolean(options?.head);
        return builder;
      },
      eq(column: string, value: unknown) {
        filters.push((row) => row[column] === value);
        return builder;
      },
      in(column: string, values: unknown[]) {
        filters.push((row) => values.includes(row[column]));
        return builder;
      },
      order: () => builder,
      limit: () => builder,
      range(start: number, end: number) {
        page = [start, end];
        return builder;
      },
      update(values: Row) {
        patch = values;
        return builder;
      },
      single: one,
      maybeSingle: one,
      then(resolve: (result: unknown) => void) {
        const rows = run();
        resolve(
          head
            ? { data: null, count: rows.length, error: null }
            : { data: rows, error: null },
        );
      },
    };
    return builder;
  }

  const session = { user: { id: 'u1' } };
  return {
    tables,
    client: {
      from,
      auth: {
        getUser: async () => ({ data: { user: session.user }, error: null }),
        getSession: async () => ({ data: { session } }),
      },
    },
    sendTemplateMessage: vi.fn(),
  };
});

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.client }));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.client }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.client }));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: h.sendTemplateMessage,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: () => 'token',
  encrypt: () => 'enc',
  isLegacyFormat: () => false,
}));
vi.mock('@/lib/whatsapp/broadcast-inbox', () => ({
  persistBroadcastMessageIfConversationExists: async () => false,
}));
vi.mock('@/lib/automations/engine', () => ({ runAutomationsForTrigger: vi.fn() }));
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn() }));
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn() }));
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn() }));

import { POST } from '@/app/api/whatsapp/broadcast/route';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { handleStatusUpdate } from '@/lib/whatsapp/webhook-handler';
import { sendPendingRecipients } from './broadcast-send';

type Client = Parameters<typeof sendPendingRecipients>[0];
const client = h.client as unknown as Client;

function callSendRoute(url: string, init: RequestInit) {
  return POST(new Request(`http://localhost${url}`, init));
}

function seed(recipientCount: number) {
  h.tables.profiles = [{ user_id: 'u1', account_id: 'acc', account_role: 'agent' }];
  h.tables.whatsapp_config = [
    { account_id: 'acc', phone_number_id: 'PNID', access_token: 'enc' },
  ];
  h.tables.message_templates = [];
  h.tables.messages = [];
  h.tables.broadcasts = [
    {
      id: 'b1',
      account_id: 'acc',
      template_name: 'promo',
      template_language: 'pt_BR',
      template_variables: {},
      post_send_tag_ids: [],
      header_media_url: null,
      status: 'sending',
    },
  ];
  h.tables.broadcast_recipients = Array.from({ length: recipientCount }, (_, i) => ({
    id: `r${i}`,
    broadcast_id: 'b1',
    status: 'pending',
    whatsapp_message_id: null,
    contact: { id: `c${i}`, phone: `+551190000${String(i).padStart(4, '0')}` },
  }));
}

function statusOf(
  id: string,
  status: string,
  errors?: { code: number; title: string; details?: string }[],
) {
  return {
    id,
    status,
    timestamp: '1760000000',
    recipient_id: '5511900000000',
    ...(errors ? { errors } : {}),
  };
}

/** Each message's receipt lands during the next send of the same batch. */
function metaAnswersMidBatch(receipt: (id: string) => ReturnType<typeof statusOf>) {
  const sent: string[] = [];
  h.sendTemplateMessage.mockImplementation(async () => {
    const previous = sent.at(-1);
    if (previous) await handleStatusUpdate(receipt(previous));
    const id = `wamid-${sent.length}`;
    sent.push(id);
    return { messageId: id };
  });
}

const rows = () => h.tables.broadcast_recipients;

describe('Meta receipts that arrive while a batch is still sending', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    h.sendTemplateMessage.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(callSendRoute));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(['delivered', 'read'])('keeps a "%s" receipt', async (status) => {
    seed(10);
    metaAnswersMidBatch((id) => statusOf(id, status));

    const result = await sendPendingRecipients(client, 'b1');

    // The last message has no later send to carry its receipt.
    expect(rows().slice(0, 9).map((r) => r.status)).toEqual(Array(9).fill(status));
    expect(rows()[9].status).toBe('sent');
    expect(result).toMatchObject({ sent: 10, failed: 0, pendingRemaining: 0 });
    expect(h.tables.broadcasts[0].status).toBe('sent');
  });

  it('keeps a failure and its reason', async () => {
    seed(3);
    metaAnswersMidBatch((id) =>
      statusOf(id, 'failed', [{ code: 131026, title: 'Message undeliverable' }]),
    );

    await sendPendingRecipients(client, 'b1');

    expect(rows()[0]).toMatchObject({
      status: 'failed',
      error_message: '(#131026) Message undeliverable',
    });
  });

  it('does not send twice when the browser loses the response', async () => {
    seed(2);
    h.sendTemplateMessage.mockImplementation(async () => ({
      messageId: `wamid-${h.sendTemplateMessage.mock.calls.length}`,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        await callSendRoute(url, init);
        throw new TypeError('Failed to fetch');
      }),
    );

    const first = await sendPendingRecipients(client, 'b1');
    const resumed = await sendPendingRecipients(client, 'b1');

    expect(rows().map((r) => r.status)).toEqual(['sent', 'sent']);
    expect(first.failed).toBe(0);
    expect(resumed).toMatchObject({ sent: 0, failed: 0 });
    expect(h.sendTemplateMessage).toHaveBeenCalledTimes(2);
  });
});
