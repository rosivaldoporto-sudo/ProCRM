import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverFormWebhook } from './webhook';

afterEach(() => vi.unstubAllGlobals());

describe('deliverFormWebhook', () => {
  it('never reaches internal destinations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const url of [
      'http://127.0.0.1:3000/api/x',
      'http://169.254.169.254/latest/meta-data',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost/x',
      'file:///etc/passwd',
      'not a url',
    ]) {
      await deliverFormWebhook(url, '{}');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to a public destination without following redirects', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await deliverFormWebhook('https://8.8.8.8/hook', '{"a":1}');
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.redirect).toBe('manual');
    expect(init.method).toBe('POST');
    expect(init.signal).toBeDefined();
  });

  it('swallows delivery failures so the lead flow is unaffected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom');
      })
    );
    await expect(
      deliverFormWebhook('https://8.8.8.8/hook', '{}')
    ).resolves.toBeUndefined();
  });
});
