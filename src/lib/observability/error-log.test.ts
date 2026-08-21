import { afterEach, describe, expect, it, vi } from 'vitest';
import { logServerError } from './error-log';

describe('logServerError', () => {
  afterEach(() => vi.restoreAllMocks());

  it('emits a correlated structured record and redacts credentials', async () => {
    const output: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((value) => {
      output.push(String(value));
    });

    const requestId = crypto.randomUUID();
    const returned = await logServerError(
      new Error('provider failed with Bearer top-secret-token'),
      {
        source: 'test',
        requestId,
        route: '/api/test?token=url-secret',
        context: {
          api_key: 'context-secret',
          nested: { password: 'password-secret', safe: 'visible' },
        },
        persist: false,
      }
    );

    expect(returned).toBe(requestId);
    expect(output).toHaveLength(1);
    expect(output[0]).toContain(requestId);
    expect(output[0]).toContain('[REDACTED]');
    expect(output[0]).toContain('visible');
    expect(output[0]).not.toContain('top-secret-token');
    expect(output[0]).not.toContain('url-secret');
    expect(output[0]).not.toContain('context-secret');
    expect(output[0]).not.toContain('password-secret');
  });
});

