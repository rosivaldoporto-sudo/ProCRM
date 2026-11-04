import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  resolveMetaMediaId: vi.fn(),
  config: null as Record<string, unknown> | null,
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/whatsapp/media-id-resolver', () => ({
  resolveMetaMediaId: mocks.resolveMetaMediaId,
  MEDIA_UNAVAILABLE_ERROR: 'media-unavailable',
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: vi.fn(() => 'plaintext-token'),
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      single: async () => ({
        data: mocks.config,
        error: mocks.config ? null : { message: 'not found' },
      }),
    };
    return { from: () => builder };
  },
}));

import { ForbiddenError, UnauthorizedError } from '@/lib/auth/account';
import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

const VIDEO_URL = 'https://proj.supabase.co/storage/v1/object/public/chat-media/promo.mp4';

function prepare(body: unknown = { url: VIDEO_URL, kind: 'video' }) {
  return POST(
    new Request('http://localhost/api/whatsapp/broadcast/media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  __resetRateLimitForTests();
  mocks.config = { phone_number_id: 'PNID-1', access_token: 'enc-token' };
  mocks.requireRole.mockReset().mockResolvedValue({
    userId: 'user-1',
    accountId: 'acct-1',
    role: 'agent',
  });
  mocks.resolveMetaMediaId.mockReset().mockResolvedValue('media-123');
});

describe('POST /api/whatsapp/broadcast/media', () => {
  it('returns the Meta media id for the account sending number', async () => {
    const res = await prepare();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ media_id: 'media-123' });
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        phoneNumberId: 'PNID-1',
        accessToken: 'plaintext-token',
        sourceUrl: VIDEO_URL,
        kind: 'video',
      }),
    );
  });

  it('reports a failure so the campaign stops before sending', async () => {
    mocks.resolveMetaMediaId.mockResolvedValue(null);

    const res = await prepare();

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'media-unavailable' });
  });

  it('rejects a signed-out caller and a read-only role', async () => {
    mocks.requireRole.mockRejectedValueOnce(new UnauthorizedError());
    expect((await prepare()).status).toBe(401);

    mocks.requireRole.mockRejectedValueOnce(new ForbiddenError());
    expect((await prepare()).status).toBe(403);

    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
  });

  it.each([
    ['no url', { kind: 'video' }],
    ['an empty url', { url: '  ', kind: 'video' }],
    ['an oversized url', { url: `https://x.test/${'a'.repeat(2048)}`, kind: 'video' }],
    ['a kind that is not a header media', { url: VIDEO_URL, kind: 'audio' }],
    ['no kind', { url: VIDEO_URL }],
  ])('rejects %s', async (_label, body) => {
    const res = await prepare(body);

    expect(res.status).toBe(400);
    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
  });

  it('rejects a body that is not JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/broadcast/media', {
        method: 'POST',
        body: 'not json',
      }),
    );

    expect(res.status).toBe(400);
  });

  it('asks to configure WhatsApp when the account has no config', async () => {
    mocks.config = null;

    const res = await prepare();

    expect(res.status).toBe(400);
    expect(mocks.resolveMetaMediaId).not.toHaveBeenCalled();
  });

  it('limits how often campaigns can prepare media', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await prepare()).status).toBe(200);
    }

    const res = await prepare();

    expect(res.status).toBe(429);
    expect(mocks.resolveMetaMediaId).toHaveBeenCalledTimes(5);
  });
});
