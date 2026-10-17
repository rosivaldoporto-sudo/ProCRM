import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for the media-id resolution wiring in the dashboard broadcast
// route: a media-header template must be resolved to a Meta media id
// ONCE per request (instead of Meta downloading the file from our
// storage for every recipient), with an untouched link fallback when
// resolution fails.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  sendTemplateMessage: vi.fn(),
  resolveMetaMediaId: vi.fn(),
  persistBroadcastMessage: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  sendTemplateMessage: mocks.sendTemplateMessage,
}));

vi.mock('@/lib/whatsapp/media-id-resolver', () => ({
  resolveMetaMediaId: mocks.resolveMetaMediaId,
}));

vi.mock('@/lib/whatsapp/broadcast-inbox', () => ({
  persistBroadcastMessageIfConversationExists: mocks.persistBroadcastMessage,
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
  encrypt: vi.fn(() => 'enc-token'),
  isLegacyFormat: vi.fn(() => false),
}));

const MEDIA_URL =
  'https://cdn.example.com/storage/v1/object/public/chat-media/promo.mp4';

const DEFAULT_TEMPLATE_ROW: Record<string, unknown> = {
  id: 'tpl-1',
  user_id: 'user-1',
  name: 'promo_video',
  category: 'Marketing',
  language: 'pt_BR',
  header_type: 'video',
  header_media_url: MEDIA_URL,
  body_text: 'Olá {{1}}!',
  created_at: '2026-01-01T00:00:00.000Z',
};

let templateRow: Record<string, unknown> = { ...DEFAULT_TEMPLATE_ROW };

function makeSupabaseMock() {
  function builder(table: string) {
    const result = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null };
        case 'whatsapp_config':
          return {
            data: {
              id: 'cfg-1',
              account_id: 'acct-1',
              phone_number_id: 'PNID-1',
              access_token: 'enc-token',
            },
            error: null,
          };
        case 'message_templates':
          return { data: templateRow, error: null };
        default:
          return { data: null, error: null };
      }
    };

    const b: Record<string, unknown> = {};
    b.select = vi.fn(() => b);
    b.eq = vi.fn(() => b);
    b.single = vi.fn(async () => result());
    b.maybeSingle = vi.fn(async () => result());
    return b;
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  };
}

const supabaseMock = makeSupabaseMock();

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => supabaseMock,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

function postBroadcast(body: Record<string, unknown>) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template_name: 'promo_video',
        template_language: 'pt_BR',
        ...body,
      }),
    })
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  templateRow = { ...DEFAULT_TEMPLATE_ROW };
  mocks.sendTemplateMessage.mockReset().mockResolvedValue({
    messageId: 'wamid-1',
  });
  mocks.resolveMetaMediaId.mockReset().mockResolvedValue(null);
  mocks.persistBroadcastMessage.mockReset().mockResolvedValue(false);
});

describe('POST /api/whatsapp/broadcast — media id resolution', () => {
  it('resolves the template media URL once and injects the Meta id', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue('media-123');

    const res = await postBroadcast({
      recipients: [
        { phone: '+15551234567', params: ['Ana'] },
        { phone: '+15557654321', params: ['Bea'] },
      ],
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      total: 2,
      sent: 2,
      failed: 0,
    });

    // ONE resolution for the whole request — not one per recipient.
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        sourceUrl: MEDIA_URL,
        kind: 'video',
      })
    );

    for (const call of mocks.sendTemplateMessage.mock.calls) {
      expect(call[0]).toMatchObject({
        phoneNumberId: 'PNID-1',
        templateName: 'promo_video',
        messageParams: { headerMediaId: 'media-123' },
      });
    }
  });

  it('resolves a per-recipient headerMediaUrl override and keeps the url', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue('media-override');
    const override = 'https://cdn.example.com/chat-media/campaign-2.mp4';

    await postBroadcast({
      recipients: [
        { phone: '+15551234567', messageParams: { headerMediaUrl: override } },
        { phone: '+15557654321', messageParams: { headerMediaUrl: override } },
      ],
    });

    expect(mocks.resolveMetaMediaId).toHaveBeenCalledTimes(1);
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledWith(
      expect.objectContaining({ sourceUrl: override })
    );
    for (const call of mocks.sendTemplateMessage.mock.calls) {
      expect(call[0].messageParams).toEqual({
        headerMediaUrl: override,
        headerMediaId: 'media-override',
      });
    }
  });

  it('keeps the link path when resolution fails', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue(null);
    const override = 'https://cdn.example.com/chat-media/campaign-2.mp4';

    const res = await postBroadcast({
      recipients: [
        { phone: '+15551234567', messageParams: { headerMediaUrl: override } },
      ],
    });
    const body = await res.json();

    expect(body.sent).toBe(1);
    expect(mocks.sendTemplateMessage.mock.calls[0][0].messageParams).toEqual({
      headerMediaUrl: override,
    });
  });

  it('leaves a caller-supplied headerMediaId untouched', async () => {
    await postBroadcast({
      recipients: [
        {
          phone: '+15551234567',
          messageParams: { headerMediaId: 'caller-id' },
        },
      ],
    });

    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
    expect(mocks.sendTemplateMessage.mock.calls[0][0].messageParams).toEqual({
      headerMediaId: 'caller-id',
    });
  });

  it('does not resolve when the template has no media header', async () => {
    templateRow = {
      ...DEFAULT_TEMPLATE_ROW,
      header_type: 'text',
      header_media_url: undefined,
    };

    await postBroadcast({
      recipients: [{ phone: '+15551234567', params: ['Ana'] }],
    });

    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
    expect(mocks.sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
