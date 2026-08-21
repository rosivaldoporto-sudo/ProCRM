import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getClientIp } from '@/lib/request-ip';
import {
  checkDistributedRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 1024;

function opaqueBucket(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function noStore<T extends NextResponse>(response: T): T {
  response.headers.set('Cache-Control', 'no-store, private');
  response.headers.set('Pragma', 'no-cache');
  return response;
}

export async function POST(request: NextRequest) {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return noStore(
      NextResponse.json({ error: 'invalid_request' }, { status: 415 })
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return noStore(
      NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    );
  }

  if (!body || typeof body !== 'object') {
    return noStore(
      NextResponse.json({ error: 'invalid_request' }, { status: 400 })
    );
  }

  const input = body as Record<string, unknown>;
  const email =
    typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (
    !email ||
    !password ||
    email.length > MAX_EMAIL_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    return noStore(
      NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    );
  }

  const clientIp = getClientIp(request);
  const ipKey = opaqueBucket(clientIp);
  const credentialKey = opaqueBucket(`${clientIp}\0${email}`);

  const ipLimit = await checkDistributedRateLimit(
    `login-ip:${ipKey}`,
    RATE_LIMITS.loginIp
  );
  if (!ipLimit.success) return noStore(rateLimitResponse(ipLimit));

  const credentialLimit = await checkDistributedRateLimit(
    `login-credential:${credentialKey}`,
    RATE_LIMITS.loginCredential
  );
  if (!credentialLimit.success) {
    return noStore(rateLimitResponse(credentialLimit));
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Do not return provider messages: different details can expose whether
    // an account exists. Status/code are sufficient for operational logs.
    if (error.status === 429) {
      const response = NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '60' } }
      );
      return noStore(response);
    }
    if (![400, 401, 403].includes(error.status ?? 0)) {
      console.error('[auth/login] Supabase sign-in failed', {
        status: error.status,
        code: error.code,
      });
      return noStore(
        NextResponse.json({ error: 'auth_unavailable' }, { status: 503 })
      );
    }
    return noStore(
      NextResponse.json({ error: 'invalid_credentials' }, { status: 401 })
    );
  }

  return noStore(NextResponse.json({ ok: true }));
}
