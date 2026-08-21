import { describe, expect, it } from 'vitest';
import { buildMediaPath, MEDIA_MAX_BYTES_BY_KIND } from './upload-media';

const ACCOUNT = '11111111-2222-3333-4444-555555555555';

describe('buildMediaPath', () => {
  it('namespaces under account-<id> so RLS write policies match', () => {
    const path = buildMediaPath(
      ACCOUNT,
      'photo.png',
      1700000000000,
      'random-id'
    );
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-random-id.png`);
    expect(path.split('/')[0]).toBe(`account-${ACCOUNT}`);
  });

  it('does not leak the original filename and lower-cases the extension', () => {
    const path = buildMediaPath(
      ACCOUNT,
      'Customer Invoice.PDF',
      1700000000000,
      'unguessable'
    );
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-unguessable.pdf`);
    expect(path).not.toContain('Customer');
  });

  it('sanitizes and caps the random identifier', () => {
    const path = buildMediaPath(
      ACCOUNT,
      'image.png',
      1700000000000,
      'a/' + 'b'.repeat(100)
    );
    const id = path
      .split('/')[1]
      .replace('1700000000000-', '')
      .replace('.png', '');
    expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(id.length).toBe(64);
  });

  it('uses bin for a nameless input', () => {
    const path = buildMediaPath(ACCOUNT, '', 1700000000000, 'random-id');
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-random-id.bin`);
  });

  it('defaults the extension to bin when there is none', () => {
    const path = buildMediaPath(ACCOUNT, 'README', 1700000000000, 'random-id');
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-random-id.bin`);
  });
});

describe('MEDIA_MAX_BYTES_BY_KIND', () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it('caps video/audio/document at the 16 MB bucket limit', () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});
