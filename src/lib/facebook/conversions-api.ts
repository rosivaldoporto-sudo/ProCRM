/**
 * Meta Conversions API (CAPI) client.
 *
 * Sends server-side conversion events directly to Meta's Graph API
 * so WhatsApp / form leads are attributed to the correct ad — even
 * though there's no browser pixel firing on those conversations.
 *
 * Tracking correto (conforme a doc oficial):
 *  - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *  - https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event/
 *  - https://developers.facebook.com/documentation/ads-commerce/conversions-api/using-the-api
 *
 * Regras que este client aplica:
 *  1. `em` / `ph` / `fn` / `ln` / `external_id` são NORMALIZADOS +
 *     hasheados em SHA-256 antes do envio. A Meta REJEITA PII sem
 *     hash ("Our systems are designed to not accept customer
 *     information that is unhashed") — enviar raw quebra o match.
 *  2. `fbp` / `fbc` / `client_ip_address` / `client_user_agent` vão
 *     em `user_data` SEM hash (nunca no custom_data). ip + ua são
 *     OBRIGATÓRIOS para action_source=website.
 *  3. `event_source_url` é obrigatório para website.
 *  4. `action_source` usa o enum oficial — 'whatsapp' NÃO existe;
 *     conversa de WhatsApp = 'chat'.
 *  5. `event_id` igual no browser e no servidor = deduplicação
 *     (redundant setup recomendado pela Meta).
 */

const META_API_VERSION = 'v26.0';
const CAPI_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/** Funil do Lead Form (eventos padrão + QualifiedLead custom). */
export type FormFunnelEvent =
  | 'ViewContent'
  | 'Lead'
  | 'CompleteRegistration'
  | 'Schedule'
  | 'QualifiedLead';

export const FB_EVENTS_URL = 'https://connect.facebook.net/en_US/fbevents.js';

/** Valores oficiais de action_source (server-event parameters). */
export type CapiActionSource =
  | 'website'
  | 'app'
  | 'phone_call'
  | 'chat'
  | 'email'
  | 'physical_store'
  | 'system_generated'
  | 'business_messaging'
  | 'other';

export interface CapiEvent {
  /** Standard Meta event name: "Lead", "Contact", "Schedule", etc. */
  event_name: string;
  /** Unix timestamp in seconds (when the event happened). */
  event_time: number;
  action_source: CapiActionSource;
  /** Shared browser↔server id for dedup (same event_name + event_id). */
  event_id?: string;
  /** REQUIRED for website events — page URL where it happened. */
  event_source_url?: string;
  user_data: {
    /** RAW values — this client normalizes + hashes before sending. */
    phones?: string[];
    emails?: string[];
    firstName?: string;
    lastName?: string;
    /** Hashing recommended by Meta; hashed here like the rest. */
    external_id?: string;
    /** Browser ID (_fbp cookie). Never hashed. */
    fbp?: string;
    /** Click ID (_fbc cookie or fbclid-derived). Never hashed. */
    fbc?: string;
    /** REQUIRED for website events. Never hashed. */
    clientIpAddress?: string;
    /** REQUIRED for website events. Never hashed. */
    clientUserAgent?: string;
  };
  custom_data?: {
    lead_source?: string;
    campaign_name?: string;
    ad_name?: string;
    currency?: string;
    value?: number;
    [key: string]: unknown;
  };
}

export interface CapiConfig {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
}

export interface CapiResponse {
  events_received: number;
  messages?: string[];
  fbtrace_id?: string;
}

// ============================================================
// Normalização + hash (exportados p/ testes com vetores da doc)
// ============================================================

/** Email: trim + lowercase. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Phone: só dígitos, sem zeros à esquerda. Deve incluir o DDI
 * (ex.: +55 (11) 99999-9999 → 5511999999999).
 */
export function normalizePhone(value: string): string {
  return value.replace(/\D/g, '').replace(/^0+/, '');
}

/** Nome: trim + lowercase + sem pontuação (UTF-8 preservado). */
export function normalizeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/["'.,;:\-()+[\]{}]+/g, '')
    .replace(/\s+/g, ' ');
}

/** Divide "João Silva" → { first: "João", last: "Silva" }. */
export function splitName(full?: string | null): {
  first?: string;
  last?: string;
} {
  if (!full || !full.trim()) return {};
  const parts = full.trim().split(/\s+/);
  return {
    first: parts[0],
    last: parts.length > 1 ? parts.slice(1).join(' ') : undefined,
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** fbc válido (cookie) ou sintetizado a partir do fbclid. */
export function buildFbc(fbc?: string, fbclid?: string): string | undefined {
  if (fbc && /^fb\.\d+\.\d+\..+/.test(fbc)) return fbc;
  const click = fbclid?.trim();
  if (click) return `fb.1.${Date.now()}.${click}`;
  return undefined;
}

/** fbp válido (fb.subdomain.creation.random) ou undefined. */
export function validFbp(fbp?: string): string | undefined {
  if (fbp && /^fb\.\d+\.\d+\.\d+$/.test(fbp.trim())) return fbp.trim();
  return undefined;
}

async function hashAll(values: string[], normalize: (v: string) => string): Promise<string[]> {
  const out: string[] = [];
  for (const raw of values) {
    const n = normalize(raw);
    if (n) out.push(await sha256Hex(n));
  }
  return out;
}

/**
 * Send one or more events to the Meta Conversions API.
 *
 * PII é hasheada aqui — callers passam valores RAW.
 * `testEventCode` envia para a aba Test Events (sem dado produtivo).
 */
export async function sendCapiEvents(
  config: CapiConfig,
  events: CapiEvent[],
): Promise<CapiResponse> {
  const { pixelId, accessToken, testEventCode } = config;

  const data = await Promise.all(
    events.map(async (e) => {
      const user_data: Record<string, unknown> = {};
      if (e.user_data.emails?.length) {
        user_data.em = await hashAll(e.user_data.emails, normalizeEmail);
      }
      if (e.user_data.phones?.length) {
        user_data.ph = await hashAll(e.user_data.phones, normalizePhone);
      }
      if (e.user_data.firstName) {
        const n = normalizeName(e.user_data.firstName);
        if (n) user_data.fn = [await sha256Hex(n)];
      }
      if (e.user_data.lastName) {
        const n = normalizeName(e.user_data.lastName);
        if (n) user_data.ln = [await sha256Hex(n)];
      }
      if (e.user_data.external_id) {
        user_data.external_id = [await sha256Hex(e.user_data.external_id)];
      }
      if (e.user_data.fbp) user_data.fbp = e.user_data.fbp;
      if (e.user_data.fbc) user_data.fbc = e.user_data.fbc;
      if (e.user_data.clientIpAddress) {
        user_data.client_ip_address = e.user_data.clientIpAddress;
      }
      if (e.user_data.clientUserAgent) {
        user_data.client_user_agent = e.user_data.clientUserAgent;
      }
      return {
        event_name: e.event_name,
        event_time: e.event_time,
        action_source: e.action_source,
        event_id: e.event_id,
        event_source_url: e.event_source_url,
        user_data,
        ...(e.custom_data ? { custom_data: e.custom_data } : {}),
      };
    }),
  );

  const payload: Record<string, unknown> = { data };
  if (testEventCode) payload.test_event_code = testEventCode;

  const url = `${CAPI_BASE}/${pixelId}/events`;

  // Timeout explícito: sem ele, uma Meta lenta congela o submit do
  // formulário (a rota pública aguarda o CAPI antes de responder).
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const errMsg =
      body?.error?.message ?? body?.message ?? 'Conversions API request failed';
    throw new Error(`Meta CAPI error: ${errMsg}`);
  }

  return body as CapiResponse;
}
