import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendPendingRecipients } from './broadcast-send';

type Row = Record<string, unknown>;

interface FakeOptions {
  variables?: Record<string, { type: string; value: string }>;
  customValues?: Row[];
  errors?: Record<string, string>;
  template?: Row;
  headerMediaUrl?: string;
}

const SERVER_ROW_CAP = 10;

/** In-memory Supabase that cuts every response at SERVER_ROW_CAP rows, like PostgREST. */
function fakeDb(recipientCount: number, options: FakeOptions = {}) {
  const recipients: Row[] = Array.from({ length: recipientCount }, (_, i) => ({
    id: `r${String(i).padStart(4, '0')}`,
    broadcast_id: 'b1',
    status: 'pending',
    contact: { id: `c${i}`, phone: `+551190000${String(i).padStart(4, '0')}` },
  }));
  const broadcast: Row = {
    id: 'b1',
    account_id: 'acc',
    template_name: 'promo',
    template_language: 'pt_BR',
    template_variables: options.variables ?? {},
    post_send_tag_ids: [],
    header_media_url: options.headerMediaUrl ?? null,
    status: 'sending',
  };
  const queried: string[] = [];
  const updates: Row[] = [];

  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }),
    },
    from(table: string) {
      queried.push(table);
      const filters: ((row: Row) => boolean)[] = [];
      let range: [number, number] | null = null;
      let head = false;
      let patch: Row | null = null;

      const rowsOf = (): Row[] => {
        if (table === 'broadcast_recipients') return recipients;
        if (table === 'contact_custom_values') return options.customValues ?? [];
        if (table === 'broadcasts') return [broadcast];
        return [];
      };

      const builder = {
        select(_columns?: string, opts?: { head?: boolean }) {
          head = Boolean(opts?.head);
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
        order() {
          return builder;
        },
        range(from: number, to: number) {
          range = [from, to];
          return builder;
        },
        update(values: Row) {
          patch = values;
          updates.push(values);
          return builder;
        },
        single() {
          return Promise.resolve({ data: broadcast, error: null });
        },
        maybeSingle() {
          return Promise.resolve({ data: options.template ?? null, error: null });
        },
        then(resolve: (result: unknown) => void) {
          if (options.errors?.[table]) {
            return resolve({ data: null, error: { message: options.errors[table] } });
          }
          const matched = rowsOf().filter((row) => filters.every((f) => f(row)));
          if (patch) {
            matched.forEach((row) => Object.assign(row, patch));
            return resolve({ data: matched, error: null });
          }
          if (head) return resolve({ data: null, count: matched.length, error: null });
          const [from, to] = range ?? [0, matched.length];
          const page = matched.slice(from, Math.min(to + 1, from + SERVER_ROW_CAP));
          return resolve({ data: page, error: null });
        },
      };
      return builder;
    },
  };

  return {
    client: client as unknown as Parameters<typeof sendPendingRecipients>[0],
    recipients,
    broadcast,
    queried,
    updates,
  };
}

/** Every call to the media-preparation endpoint in the current test. */
let mediaCalls: { url: string; kind: string }[] = [];

/** Stands in for the broadcast endpoints, recording every recipient received. */
function stubBroadcastApi({ mediaError }: { mediaError?: string } = {}) {
  const dispatched: { phone: string; params: string[]; messageParams?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      if (url === '/api/whatsapp/broadcast/media') {
        mediaCalls.push(JSON.parse(init.body));
        return mediaError
          ? { ok: false, json: async () => ({ error: mediaError }) }
          : { ok: true, json: async () => ({ media_id: 'media-1' }) };
      }
      const { recipients } = JSON.parse(init.body) as {
        recipients: { phone: string; params: string[]; messageParams?: unknown }[];
      };
      dispatched.push(...recipients);
      return {
        ok: true,
        json: async () => ({
          results: recipients.map((r) => ({ phone: r.phone, status: 'sent' })),
        }),
      };
    }),
  );
  return dispatched;
}

/** The send loop pauses between batches, so timers must advance while it runs. */
async function run<T>(promise: Promise<T>): Promise<T> {
  const settled = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await settled;
  if ('error' in result) throw result.error;
  return result.value;
}

describe('sendPendingRecipients', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mediaCalls = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('header media', () => {
    const VIDEO_URL = 'https://proj.supabase.co/storage/v1/object/public/chat-media/promo.mp4';
    const video = {
      template: { header_type: 'video' },
      headerMediaUrl: VIDEO_URL,
    };

    it('prepares the media once and references its id in every batch', async () => {
      const dispatched = stubBroadcastApi();
      const { client } = fakeDb(25, video);

      await run(sendPendingRecipients(client, 'b1'));

      expect(mediaCalls).toEqual([{ url: VIDEO_URL, kind: 'video' }]);
      expect(dispatched).toHaveLength(25);
      for (const recipient of dispatched) {
        expect(recipient.messageParams).toEqual({ headerMediaId: 'media-1' });
      }
    });

    it('falls back to the media stored on the template', async () => {
      const dispatched = stubBroadcastApi();
      const { client } = fakeDb(1, {
        template: { header_type: 'video', header_media_url: VIDEO_URL },
      });

      await run(sendPendingRecipients(client, 'b1'));

      expect(mediaCalls).toEqual([{ url: VIDEO_URL, kind: 'video' }]);
      expect(dispatched[0].messageParams).toEqual({ headerMediaId: 'media-1' });
    });

    it('sends nothing and keeps everyone pending when the media fails', async () => {
      const dispatched = stubBroadcastApi({ mediaError: 'mídia indisponível' });
      const { client, recipients, broadcast } = fakeDb(25, video);

      await expect(run(sendPendingRecipients(client, 'b1'))).rejects.toThrow(
        'mídia indisponível',
      );

      expect(dispatched).toEqual([]);
      expect(recipients.every((r) => r.status === 'pending')).toBe(true);
      expect(broadcast.status).toBe('sending');
    });

    it('reuses an id the caller already prepared', async () => {
      const dispatched = stubBroadcastApi();
      const { client } = fakeDb(1, video);

      await run(sendPendingRecipients(client, 'b1', undefined, { headerMediaId: 'ready' }));

      expect(mediaCalls).toEqual([]);
      expect(dispatched[0].messageParams).toEqual({ headerMediaId: 'ready' });
    });

    it('does not prepare media when nobody is pending', async () => {
      stubBroadcastApi();
      const { client } = fakeDb(0, video);

      await run(sendPendingRecipients(client, 'b1'));

      expect(mediaCalls).toEqual([]);
    });

    it('does not prepare anything for a template without media', async () => {
      const dispatched = stubBroadcastApi();
      const { client } = fakeDb(1, { template: { header_type: 'text' } });

      await run(sendPendingRecipients(client, 'b1'));

      expect(mediaCalls).toEqual([]);
      expect(dispatched[0].messageParams).toBeUndefined();
    });
  });

  describe('recording the Meta id', () => {
    /** The send route: `during` runs while the batch is in flight. */
    function stubSendRoute(during: () => void, recorded?: boolean) {
      const dispatched: { phone: string; recipient_id?: string }[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init: { body: string }) => {
          const body = JSON.parse(init.body) as { recipients: typeof dispatched };
          dispatched.push(...body.recipients);
          during();
          return {
            ok: true,
            json: async () => ({
              results: body.recipients.map((r) => ({
                phone: r.phone,
                status: 'sent',
                whatsapp_message_id: `wamid-${r.recipient_id}`,
                ...(recorded === undefined ? {} : { recorded }),
              })),
            }),
          };
        }),
      );
      return dispatched;
    }

    it('tells the route which recipient each send belongs to', async () => {
      const dispatched = stubSendRoute(() => {});
      const { client } = fakeDb(2);

      await run(sendPendingRecipients(client, 'b1'));

      expect(dispatched.map((r) => r.recipient_id)).toEqual(['r0000', 'r0001']);
    });

    it('leaves alone a recipient the route already recorded', async () => {
      const { client, recipients, updates } = fakeDb(2);
      stubSendRoute(() => {
        Object.assign(recipients[0], {
          status: 'delivered',
          whatsapp_message_id: 'from-route',
        });
        Object.assign(recipients[1], {
          status: 'sent',
          whatsapp_message_id: 'from-route',
        });
      }, true);

      const result = await run(sendPendingRecipients(client, 'b1'));

      expect(recipients[0]).toMatchObject({
        status: 'delivered',
        whatsapp_message_id: 'from-route',
      });
      expect(result).toMatchObject({ sent: 2, failed: 0, pendingRemaining: 0 });
      // Not even a harmless write: each one would slow the batch down.
      expect(updates.filter((update) => 'whatsapp_message_id' in update)).toEqual([]);
    });

    it('records the id itself when the route could not', async () => {
      const { client, recipients } = fakeDb(1);
      stubSendRoute(() => {}, false);

      await run(sendPendingRecipients(client, 'b1'));

      expect(recipients[0]).toMatchObject({
        status: 'sent',
        whatsapp_message_id: 'wamid-r0000',
      });
    });

    it('never moves a recipient back to sent', async () => {
      const { client, recipients } = fakeDb(1);
      stubSendRoute(() => {
        recipients[0].status = 'delivered';
      }, false);

      await run(sendPendingRecipients(client, 'b1'));

      expect(recipients[0].status).toBe('delivered');
    });

    it('fails only the recipients not sent when the request dies midway', async () => {
      const { client, recipients } = fakeDb(2);
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          recipients[0].status = 'sent';
          throw new TypeError('Failed to fetch');
        }),
      );

      const result = await run(sendPendingRecipients(client, 'b1'));

      expect(recipients.map((r) => r.status)).toEqual(['sent', 'failed']);
      expect(result.failed).toBe(1);
    });
  });

  it('dispatches every pending recipient even past the server row cap', async () => {
    const dispatched = stubBroadcastApi();
    const { client, recipients, broadcast } = fakeDb(25);

    const result = await run(sendPendingRecipients(client, 'b1'));

    expect(new Set(dispatched.map((r) => r.phone)).size).toBe(25);
    expect(dispatched).toHaveLength(25);
    expect(recipients.every((r) => r.status === 'sent')).toBe(true);
    expect(result).toMatchObject({ sent: 25, failed: 0, pendingRemaining: 0 });
    expect(broadcast.status).toBe('sent');
  });

  it('resolves custom fields for every contact even past the server row cap', async () => {
    const dispatched = stubBroadcastApi();
    // Five values per contact: 3 contacts fit one request but overflow the cap.
    const customValues = ['c0', 'c1', 'c2'].flatMap((contactId) =>
      ['f1', 'f2', 'f3', 'f4', 'f5'].map((fieldId) => ({
        id: `${contactId}-${fieldId}`,
        contact_id: contactId,
        custom_field_id: fieldId,
        value: `${contactId}:${fieldId}`,
      })),
    );
    const { client } = fakeDb(3, {
      variables: { '1': { type: 'custom_field', value: 'f5' } },
      customValues,
    });

    await run(sendPendingRecipients(client, 'b1'));

    expect(dispatched.map((r) => r.params)).toEqual([
      ['c0:f5'],
      ['c1:f5'],
      ['c2:f5'],
    ]);
  });

  it('skips the custom-value lookup when no variable needs it', async () => {
    stubBroadcastApi();
    const { client, queried } = fakeDb(2, {
      variables: { '1': { type: 'static', value: 'oi' } },
    });

    await run(sendPendingRecipients(client, 'b1'));

    expect(queried).not.toContain('contact_custom_values');
  });

  it('sends nothing when custom values fail to load, instead of blank variables', async () => {
    const dispatched = stubBroadcastApi();
    const { client, recipients } = fakeDb(2, {
      variables: { '1': { type: 'custom_field', value: 'f1' } },
      errors: { contact_custom_values: 'boom' },
    });

    await expect(run(sendPendingRecipients(client, 'b1'))).rejects.toThrow('boom');

    expect(dispatched).toEqual([]);
    expect(recipients.every((r) => r.status === 'pending')).toBe(true);
  });

  it('throws when pending recipients fail to load', async () => {
    const dispatched = stubBroadcastApi();
    const { client } = fakeDb(2, { errors: { broadcast_recipients: 'boom' } });

    await expect(run(sendPendingRecipients(client, 'b1'))).rejects.toThrow(
      'Falha ao buscar os destinatários pendentes',
    );
    expect(dispatched).toEqual([]);
  });
});
