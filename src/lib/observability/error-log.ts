import { createClient } from '@supabase/supabase-js';

const SENSITIVE_KEY =
  /authorization|cookie|password|passwd|secret|token|api[_-]?key|pin|credential/i;
const BEARER_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SECRET_QUERY =
  /([?&](?:token|secret|api_key|access_token|key|code)=)[^&#\s]*/gi;

export interface ErrorLogMeta {
  source: string;
  route?: string;
  method?: string;
  requestId?: string;
  accountId?: string | null;
  userId?: string | null;
  context?: Record<string, unknown>;
  persist?: boolean;
}

function redactString(value: string): string {
  return value
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(SECRET_QUERY, '$1[REDACTED]')
    .slice(0, 4000);
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[TRUNCATED]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 30).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 50)) {
      result[key] = SENSITIVE_KEY.test(key)
        ? '[REDACTED]'
        : sanitize(item, depth + 1);
    }
    return result;
  }
  return redactString(String(value));
}

function normalizeUuid(value?: string): string {
  return value && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value)
    ? value
    : crypto.randomUUID();
}

export async function logServerError(
  error: unknown,
  meta: ErrorLogMeta
): Promise<string> {
  const requestId = normalizeUuid(meta.requestId);
  const err = error instanceof Error ? error : new Error(String(error));
  const record = {
    request_id: requestId,
    occurred_at: new Date().toISOString(),
    account_id: meta.accountId ?? null,
    user_id: meta.userId ?? null,
    source: redactString(meta.source),
    route: meta.route ? redactString(meta.route.split('?')[0]) : null,
    method: meta.method?.slice(0, 10) ?? null,
    error_name: redactString(err.name),
    message: redactString(err.message || 'Unknown error'),
    stack: err.stack
      ? redactString(err.stack.split('\n').slice(0, 12).join('\n'))
      : null,
    context: sanitize(meta.context ?? {}) as Record<string, unknown>,
  };

  // Hostinger captures stderr. One-line JSON makes it searchable by
  // request_id while avoiding cookies, headers, bodies and credentials.
  console.error(JSON.stringify({ event: 'application_error', ...record }));

  if (meta.persist === false || !record.account_id) return requestId;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return requestId;

  try {
    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: insertError } = await admin
      .from('application_error_logs')
      .insert(record);
    if (insertError) {
      console.warn(
        JSON.stringify({
          event: 'application_error_log_insert_failed',
          request_id: requestId,
          code: insertError.code,
        })
      );
    }
  } catch {
    console.warn(
      JSON.stringify({
        event: 'application_error_log_insert_failed',
        request_id: requestId,
      })
    );
  }
  return requestId;
}

