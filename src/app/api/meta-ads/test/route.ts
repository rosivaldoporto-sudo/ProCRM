import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { sendCapiEvents, splitName } from '@/lib/facebook/conversions-api';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getClientIp } from '@/lib/request-ip';

function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function getIp(req: Request): string | undefined {
  const ip = getClientIp(req);
  return ip === 'unknown' ? undefined : ip;
}

const ALLOWED_EVENTS = [
  'Lead',
  'CompleteRegistration',
  'Schedule',
  'ViewContent',
  'Contact',
] as const;

type AllowedEvent = (typeof ALLOWED_EVENTS)[number];

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');
    const limit = checkRateLimit(
      `meta-ads-test:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const rawEvent =
      typeof body.event_name === 'string' ? body.event_name.trim() : 'Lead';
    if (!(ALLOWED_EVENTS as readonly string[]).includes(rawEvent)) {
      return bad(`event_name deve ser um de: ${ALLOWED_EVENTS.join(', ')}`);
    }
    const eventName = rawEvent as AllowedEvent;

    const email =
      typeof body.email === 'string' ? body.email.trim().slice(0, 320) : '';
    const phone =
      typeof body.phone === 'string' ? body.phone.trim().slice(0, 40) : '';
    const fullName =
      typeof body.full_name === 'string'
        ? body.full_name.trim().slice(0, 200)
        : typeof body.name === 'string'
          ? body.name.trim().slice(0, 200)
          : '';
    const pixelOverride =
      typeof body.pixel_id === 'string' ? body.pixel_id.trim() : '';
    const testCodeOverride =
      typeof body.test_event_code === 'string'
        ? body.test_event_code.trim()
        : undefined;
    const eventSourceUrl =
      typeof body.event_source_url === 'string' &&
      body.event_source_url.trim().length > 0
        ? body.event_source_url.trim().slice(0, 2000)
        : undefined;

    if (pixelOverride && !/^\d{5,30}$/.test(pixelOverride)) {
      return bad('Invalid pixel_id');
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return bad('E-mail de teste inválido');
    }
    if (testCodeOverride !== undefined && testCodeOverride.length > 200) {
      return bad('test_event_code excede o tamanho permitido');
    }

    const { data: cfg, error } = await supabaseAdmin()
      .from('meta_ads_config')
      .select('pixel_id, access_token, test_event_code')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) throw error;
    const row = cfg as {
      pixel_id: string | null;
      access_token: string | null;
      test_event_code: string | null;
    } | null;

    const pixelId = pixelOverride || row?.pixel_id || '';
    if (!pixelId) return bad('Configure o Pixel ID antes de testar');
    if (!/^\d{5,30}$/.test(pixelId)) return bad('Pixel ID salvo é inválido');

    if (!row?.access_token) return bad('Configure o token da Conversions API antes de testar');
    let token = row.access_token;
    if (token.includes(':')) {
      try {
        token = decrypt(token);
      } catch {
        return bad('Token armazenado não pode ser descriptografado. Salve-o novamente.', 500);
      }
    }
    if (!token) return bad('Token da Conversions API ausente');

    // Test code: override explícito vence; senão usa o salvo.
    // String vazia no override = envio produtivo intencional.
    const testEventCode =
      testCodeOverride !== undefined
        ? testCodeOverride || undefined
        : row?.test_event_code || undefined;

    const finalEmail = email || 'teste@example.com';
    const finalPhone = phone || '5511999999999';
    const { first, last } = splitName(fullName || 'Lead Teste ProCRM');

    const eventId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const ua =
      request.headers.get('user-agent')?.slice(0, 500) ||
      'ProCRM Meta test panel';
    const ip = getIp(request);

    try {
      const result = await sendCapiEvents(
        { pixelId, accessToken: token, testEventCode },
        [
          {
            event_name: eventName,
            event_time: Math.floor(Date.now() / 1000),
            action_source: 'website',
            event_id: eventId,
            event_source_url:
              eventSourceUrl ?? 'https://procrm.local/meta-ads/test',
            user_data: {
              emails: [finalEmail],
              phones: [finalPhone],
              ...(first ? { firstName: first } : {}),
              ...(last ? { lastName: last } : {}),
              external_id: eventId,
              ...(ip ? { clientIpAddress: ip } : {}),
              clientUserAgent: ua,
            },
            custom_data: {
              content_name: 'meta_ads_test_panel',
              test: true,
            },
          },
        ]
      );

      return NextResponse.json({
        success: true,
        events_received: result.events_received,
        fbtrace_id: result.fbtrace_id ?? null,
        messages: result.messages ?? [],
        event_id: eventId,
        event_name: eventName,
        pixel_id: pixelId,
        test_mode: !!testEventCode,
        test_event_code: testEventCode ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Falha no envio';
      return bad(message.replace(/^Meta CAPI error:\s*/i, 'Meta rejeitou o evento: '));
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
