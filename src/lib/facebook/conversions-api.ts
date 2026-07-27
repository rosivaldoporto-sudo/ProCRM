/**
 * Meta Conversions API (CAPI) client.
 *
 * Sends server-side conversion events directly to Meta's Graph API
 * so WhatsApp leads are attributed to the correct ad — even though
 * there's no browser pixel firing on the WhatsApp conversation.
 *
 * https://developers.facebook.com/docs/marketing-api/conversions-api
 */

const META_API_VERSION = 'v21.0';
const CAPI_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

export interface CapiEvent {
  /** Standard Meta event name: "Lead", "Contact", "Purchase", etc. */
  event_name: string;
  /** Unix timestamp in seconds (when the event happened). */
  event_time: number;
  /** Action source — always "whatsapp" for inbound message leads. */
  action_source: 'whatsapp' | 'website' | 'phone_call' | 'email' | 'other';
  /** Unique idempotency key for this event (prevents double-counting). */
  event_id?: string;
  /** Event source URL — the tracking link the user clicked. */
  event_source_url?: string;
  user_data: {
    /** Array of phone numbers, E.164 format (hashed = auto, raw accepted). */
    phones?: string[];
    /** Optional: first name (will be hashed by Meta if passed). */
    firstName?: string;
    /** Optional: last name. */
    lastName?: string;
    /** Optional: email. */
    email?: string;
    /** Optional: Meta external_id for dedup with pixel. */
    external_id?: string;
  };
  custom_data?: {
    /** Lead source description, e.g. "WhatsApp" */
    lead_source?: string;
    /** Campaign name from UTM. */
    campaign_name?: string;
    /** Ad name from UTM content. */
    ad_name?: string;
    /** Currency for purchase events. */
    currency?: string;
    /** Value for purchase events. */
    value?: number;
    /** Any additional custom properties. */
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

/**
 * Send one or more events to the Meta Conversions API.
 *
 * - Events are posted to `/{pixel_id}/events` with the access token.
 * - When `testEventCode` is set, the event carries `test_event_code`
 *   so it shows up in the Events Manager test view (no production data).
 * - Phone numbers are deduplicated and expected in E.164 format.
 *   Meta's CAPI applies standard hashing (SHA-256) on its side when
 *   `hash_phone` is not explicitly set.
 */
export async function sendCapiEvents(
  config: CapiConfig,
  events: CapiEvent[],
): Promise<CapiResponse> {
  const { pixelId, accessToken, testEventCode } = config;

  const payload: Record<string, unknown> = {
    data: events.map((e) => ({
      event_name: e.event_name,
      event_time: e.event_time,
      action_source: e.action_source,
      event_id: e.event_id,
      event_source_url: e.event_source_url,
      user_data: {
        ...(e.user_data.phones && e.user_data.phones.length > 0
          ? { ph: e.user_data.phones }
          : {}),
        ...(e.user_data.firstName ? { fn: e.user_data.firstName } : {}),
        ...(e.user_data.lastName ? { ln: e.user_data.lastName } : {}),
        ...(e.user_data.email ? { em: e.user_data.email } : {}),
        ...(e.user_data.external_id
          ? { external_id: e.user_data.external_id }
          : {}),
      },
      ...(e.custom_data ? { custom_data: e.custom_data } : {}),
    })),
  };

  if (testEventCode) {
    payload.test_event_code = testEventCode;
  }

  const url = `${CAPI_BASE}/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const body = await res.json();

  if (!res.ok) {
    const errMsg =
      body?.error?.message ?? body?.message ?? 'Conversions API request failed';
    throw new Error(`Meta CAPI error: ${errMsg}`);
  }

  return body as CapiResponse;
}
