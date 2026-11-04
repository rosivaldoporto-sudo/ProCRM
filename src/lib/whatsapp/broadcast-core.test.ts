import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const mocks = vi.hoisted(() => ({
  resolveMetaMediaId: vi.fn(),
  sendTemplateMessage: vi.fn(),
  findOrCreateContact: vi.fn(),
  events: [] as string[],
}));

vi.mock('@/lib/whatsapp/media-id-resolver', () => ({
  resolveMetaMediaId: mocks.resolveMetaMediaId,
  MEDIA_UNAVAILABLE_ERROR: 'media-unavailable',
}));
vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: mocks.sendTemplateMessage,
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}));
vi.mock('@/lib/api/v1/contacts', () => ({
  findOrCreateContact: mocks.findOrCreateContact,
}));
vi.mock('@/lib/whatsapp/broadcast-inbox', () => ({
  persistBroadcastMessageIfConversationExists: vi.fn(async () => {
    mocks.events.push('inbox');
  }),
}));

import { createBroadcast, deliverBroadcast, BroadcastError } from './broadcast-core';

// These assertions all fire in the pure validation prologue, before
// any Supabase call — a bare stub is enough.
const db = {} as SupabaseClient;

describe('media-header templates', () => {
  const MEDIA_URL = 'https://proj.supabase.co/storage/v1/object/public/chat-media/promo.mp4';
  const params = {
    templateName: 'promo_video',
    recipients: [{ to: '+5511900000001' }, { to: '+5511900000002' }],
  };

  function fakeDb(template: Record<string, unknown>) {
    const touched: string[] = [];
    const client = {
      from(table: string) {
        touched.push(table);
        let inserted: Record<string, unknown>[] = [];
        const builder = {
          select: () => builder,
          eq: () => builder,
          update() {
            if (table === 'broadcast_recipients') mocks.events.push('record');
            return builder;
          },
          insert(rows: Record<string, unknown>[]) {
            inserted = rows;
            return builder;
          },
          single: async () =>
            table === 'whatsapp_config'
              ? { data: { phone_number_id: 'PNID-1', access_token: 'enc' }, error: null }
              : { data: { id: 'b1' }, error: null },
          maybeSingle: async () => ({ data: template, error: null }),
          then(resolve: (result: unknown) => void) {
            resolve({
              data: inserted.map((row, i) => ({ id: `r${i}`, contact_id: row.contact_id })),
              error: null,
            });
          },
        };
        return builder;
      },
    };
    return { client: client as unknown as SupabaseClient, touched };
  }

  const videoTemplate = {
    id: 't1',
    user_id: 'u1',
    name: 'promo_video',
    body_text: 'Olá',
    header_type: 'video',
    header_media_url: MEDIA_URL,
  };

  beforeEach(() => {
    mocks.resolveMetaMediaId.mockReset();
    mocks.sendTemplateMessage.mockReset().mockResolvedValue({ messageId: 'wamid-1' });
    mocks.findOrCreateContact
      .mockReset()
      .mockImplementation(async (_db, _account, _user, contact: { phone: string }) => ({
        id: `contact-${contact.phone}`,
      }));
  });

  it('rejects before persisting anything when the media cannot be prepared', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue(null);
    const { client, touched } = fakeDb(videoTemplate);

    const error = await createBroadcast(client, 'acct-1', 'u1', params).catch((e) => e);

    expect(error).toBeInstanceOf(BroadcastError);
    expect(error).toMatchObject({ code: 'media_unavailable', status: 502 });
    expect(mocks.findOrCreateContact).not.toHaveBeenCalled();
    expect(touched).not.toContain('broadcasts');
  });

  it('prepares the media once and sends every recipient by id', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue('media-123');
    const { client } = fakeDb(videoTemplate);

    const plan = await createBroadcast(client, 'acct-1', 'u1', params);
    await deliverBroadcast(client, plan);

    expect(mocks.resolveMetaMediaId).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: MEDIA_URL, kind: 'video', phoneNumberId: 'PNID-1' }),
    );
    expect(mocks.sendTemplateMessage).toHaveBeenCalledTimes(2);
    for (const [args] of mocks.sendTemplateMessage.mock.calls) {
      expect(args.messageParams).toEqual({ headerMediaId: 'media-123' });
    }
  });

  it('records the Meta id before copying the message to the inbox', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue('media-123');
    mocks.events.length = 0;
    const { client } = fakeDb(videoTemplate);

    const plan = await createBroadcast(client, 'acct-1', 'u1', params);
    await deliverBroadcast(client, plan);

    expect(mocks.events).toEqual(['record', 'inbox', 'record', 'inbox']);
  });

  it('skips media preparation for a template without a media header', async () => {
    const { client } = fakeDb({ ...videoTemplate, header_type: 'text', header_media_url: null });

    const plan = await createBroadcast(client, 'acct-1', 'u1', params);

    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
    expect(plan.headerMediaId).toBeNull();
  });
});

describe('createBroadcast validation', () => {
  it('rejects a missing template_name', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: '',
        recipients: [{ to: '+14155550123' }],
      })
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  it('rejects an empty recipient list', async () => {
    await expect(
      createBroadcast(db, 'acc', 'user', {
        templateName: 'promo',
        recipients: [],
      })
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('rejects more than 1000 recipients', async () => {
    const recipients = Array.from({ length: 1001 }, () => ({
      to: '+14155550123',
    }));
    await expect(
      createBroadcast(db, 'acc', 'user', { templateName: 'promo', recipients })
    ).rejects.toMatchObject({ status: 400 });
  });
});
