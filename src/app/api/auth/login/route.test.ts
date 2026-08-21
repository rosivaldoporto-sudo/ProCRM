import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  checkDistributedRateLimit: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { signInWithPassword: mocks.signInWithPassword },
  })),
}));

vi.mock('@/lib/request-ip', () => ({
  getClientIp: vi.fn(() => '203.0.113.10'),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>();
  return {
    ...actual,
    checkDistributedRateLimit: mocks.checkDistributedRateLimit,
  };
});

import { POST } from './route';

function loginRequest(body: unknown, contentType = 'application/json') {
  return new NextRequest('https://app.leadfycrm.com.br/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: JSON.stringify(body),
  });
}

describe('POST /api/auth/login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkDistributedRateLimit.mockResolvedValue({
      success: true,
      remaining: 10,
      reset: Date.now() + 60_000,
      limit: 20,
    });
    mocks.signInWithPassword.mockResolvedValue({ error: null });
  });

  it('rejects non-JSON bodies before authentication', async () => {
    const response = await POST(loginRequest({}, 'text/plain'));
    expect(response.status).toBe(415);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('applies opaque IP and credential buckets', async () => {
    const response = await POST(
      loginRequest({ email: '  User@Example.com ', password: 'secret' })
    );

    expect(response.status).toBe(200);
    expect(mocks.checkDistributedRateLimit).toHaveBeenCalledTimes(2);
    const keys = mocks.checkDistributedRateLimit.mock.calls.map(
      ([key]) => key as string
    );
    expect(keys[0]).toMatch(/^login-ip:[a-f0-9]{64}$/);
    expect(keys[1]).toMatch(/^login-credential:[a-f0-9]{64}$/);
    expect(keys.join(' ')).not.toContain('User@Example.com');
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'secret',
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('stops before Supabase when the rate limit is exhausted', async () => {
    mocks.checkDistributedRateLimit.mockResolvedValueOnce({
      success: false,
      remaining: 0,
      reset: Date.now() + 60_000,
      limit: 20,
    });

    const response = await POST(
      loginRequest({ email: 'user@example.com', password: 'wrong' })
    );
    expect(response.status).toBe(429);
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('returns a generic response for bad credentials', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      error: { status: 400, code: 'invalid_credentials' },
    });

    const response = await POST(
      loginRequest({ email: 'missing@example.com', password: 'wrong' })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid_credentials',
    });
  });

  it('preserves provider rate limits without exposing provider details', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      error: { status: 429, code: 'over_request_rate_limit' },
    });

    const response = await POST(
      loginRequest({ email: 'user@example.com', password: 'wrong' })
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: 'rate_limited' });
  });
});
