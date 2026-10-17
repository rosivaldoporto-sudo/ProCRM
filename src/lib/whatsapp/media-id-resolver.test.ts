import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/uazapi/safe-fetch', () => ({
  fetchRemoteBytes: vi.fn(),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  uploadMediaToMeta: vi.fn(),
}));

import { fetchRemoteBytes } from '@/lib/uazapi/safe-fetch';
import { uploadMediaToMeta } from '@/lib/whatsapp/meta-api';
import { resolveMetaMediaId } from './media-id-resolver';

const fetchBytes = vi.mocked(fetchRemoteBytes);
const uploadMedia = vi.mocked(uploadMediaToMeta);

const MEDIA_URL = 'https://cdn.example.com/chat-media/creative.jpg';

const BASE = {
  accountId: 'acct-1',
  phoneNumberId: 'PNID-1',
  accessToken: 'token-1',
  kind: 'image' as const,
};

interface DbConfig {
  cached?: { media_id: string; expires_at: string } | null;
  selectError?: { message: string } | null;
  upsertError?: { message: string } | null;
}

/** Minimal chainable stub for the meta_media_cache queries. */
function makeDb(config: DbConfig = {}) {
  const builder: Record<string, unknown> = {};
  const maybeSingle = vi.fn(async () => ({
    data: config.cached ?? null,
    error: config.selectError ?? null,
  }));
  const upsert = vi.fn(async () => ({ error: config.upsertError ?? null }));
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.maybeSingle = maybeSingle;
  builder.upsert = upsert;
  const from = vi.fn(() => builder);
  return {
    db: { from } as unknown as SupabaseClient,
    from,
    maybeSingle,
    upsert,
  };
}

beforeEach(() => {
  fetchBytes.mockReset();
  uploadMedia.mockReset();
  // The fallback path logs warnings by design — keep test output clean.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveMetaMediaId', () => {
  it('reuses a fresh cached id without downloading or uploading', async () => {
    const { db, upsert } = makeDb({
      cached: {
        media_id: 'media-cached',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: MEDIA_URL,
    });

    expect(result).toBe('media-cached');
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('re-uploads when the cached id has expired', async () => {
    const { db, upsert } = makeDb({
      cached: {
        media_id: 'media-stale',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    fetchBytes.mockResolvedValue({
      buffer: new ArrayBuffer(4),
      contentType: 'image/jpeg',
    });
    uploadMedia.mockResolvedValue({ mediaId: 'media-fresh' });

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: MEDIA_URL,
    });

    expect(result).toBe('media-fresh');
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('downloads once with the per-kind limits and caches the uploaded id', async () => {
    const { db, from, upsert } = makeDb();
    fetchBytes.mockResolvedValue({
      buffer: new ArrayBuffer(16),
      contentType: 'video/mp4',
    });
    uploadMedia.mockResolvedValue({ mediaId: 'media-new' });

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      kind: 'video',
      sourceUrl: 'https://cdn.example.com/promo.mp4',
    });

    expect(result).toBe('media-new');
    expect(from).toHaveBeenCalledWith('meta_media_cache');
    expect(fetchBytes).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://cdn.example.com/promo.mp4',
        maxBytes: 16 * 1024 * 1024,
        allowedContentTypes: ['video/mp4', 'video/3gpp'],
      })
    );
    expect(uploadMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: 'PNID-1',
        accessToken: 'token-1',
        mimeType: 'video/mp4',
        fileName: 'promo.mp4',
      })
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acct-1',
        phone_number_id: 'PNID-1',
        source_url: 'https://cdn.example.com/promo.mp4',
        media_id: 'media-new',
        mime_type: 'video/mp4',
      }),
      { onConflict: 'phone_number_id,source_url' }
    );
  });

  it('falls back to null when the download is rejected', async () => {
    const { db } = makeDb();
    fetchBytes.mockResolvedValue(null);

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: MEDIA_URL,
    });

    expect(result).toBeNull();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('falls back to null when the Meta upload fails', async () => {
    const { db, upsert } = makeDb();
    fetchBytes.mockResolvedValue({
      buffer: new ArrayBuffer(4),
      contentType: 'image/png',
    });
    uploadMedia.mockRejectedValue(new Error('boom'));

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: MEDIA_URL,
    });

    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('still uploads when the cache lookup errors', async () => {
    const { db } = makeDb({ selectError: { message: 'lookup boom' } });
    fetchBytes.mockResolvedValue({
      buffer: new ArrayBuffer(4),
      contentType: 'image/jpeg',
    });
    uploadMedia.mockResolvedValue({ mediaId: 'media-after-error' });

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: MEDIA_URL,
    });

    expect(result).toBe('media-after-error');
  });

  it('rejects non-https URLs without touching Meta or the cache', async () => {
    const { db, from } = makeDb();

    const result = await resolveMetaMediaId({
      ...BASE,
      db,
      sourceUrl: 'http://cdn.example.com/creative.jpg',
    });

    expect(result).toBeNull();
    expect(from).not.toHaveBeenCalled();
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it('shares one in-flight upload across concurrent callers', async () => {
    const { db } = makeDb();
    let releaseFetch:
      | ((value: { buffer: ArrayBuffer; contentType: string } | null) => void)
      | undefined;
    const fetchStarted = new Promise<void>((started) => {
      fetchBytes.mockImplementation(() => {
        const pending = new Promise<{
          buffer: ArrayBuffer;
          contentType: string;
        } | null>((resolve) => {
          releaseFetch = resolve;
        });
        started();
        return pending;
      });
    });
    uploadMedia.mockResolvedValue({ mediaId: 'media-once' });

    const first = resolveMetaMediaId({ ...BASE, db, sourceUrl: MEDIA_URL });
    const second = resolveMetaMediaId({ ...BASE, db, sourceUrl: MEDIA_URL });
    await fetchStarted;
    releaseFetch!({ buffer: new ArrayBuffer(4), contentType: 'image/jpeg' });

    await expect(first).resolves.toBe('media-once');
    await expect(second).resolves.toBe('media-once');
    expect(fetchBytes).toHaveBeenCalledTimes(1);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });
});
