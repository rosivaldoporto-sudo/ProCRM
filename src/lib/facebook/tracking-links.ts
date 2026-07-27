/**
 * Tracking-link generator for WhatsApp campaigns.
 *
 * Creates `wa.me` links with UTM parameters so when a lead clicks
 * and opens WhatsApp we can later capture the source on the inbound
 * webhook — and fire a Conversions API event back to Meta.
 */

export interface TrackingLinkParams {
  phone: string;
  utm_source?: string;
  utm_campaign?: string;
  utm_medium?: string;
  utm_term?: string;
  utm_content?: string;
  /** Optional: free-form ref param for internal routing. */
  ref?: string;
  /** Optional: pre-filled message text. */
  text?: string;
}

export interface ParsedTrackingParams {
  utm_source?: string;
  utm_campaign?: string;
  utm_medium?: string;
  utm_term?: string;
  utm_content?: string;
  ref?: string;
}

/**
 * Build a `wa.me` tracking link with UTM parameters.
 *
 * Example output:
 *   https://wa.me/5511999999999?utm_source=facebook&utm_campaign=summer_sale&text=Ola
 */
export function buildWaMeLink(params: TrackingLinkParams): string {
  const { phone, text, ...rest } = params;
  const cleanPhone = phone.replace(/[^\d]/g, '');
  const query = new URLSearchParams();

  const utmFields = [
    'utm_source',
    'utm_campaign',
    'utm_medium',
    'utm_term',
    'utm_content',
    'ref',
  ] as const;

  for (const field of utmFields) {
    const val = rest[field as keyof typeof rest];
    if (val) query.set(field, val);
  }

  if (text) query.set('text', text);

  const qs = query.toString();
  return qs
    ? `https://wa.me/${cleanPhone}?${qs}`
    : `https://wa.me/${cleanPhone}`;
}

/**
 * Parse UTM parameters from a URL search string or query object.
 *
 * Designed to be called from the WhatsApp webhook when a lead sends
 * their first message — the `referrer` or `context` from the inbound
 * message may carry the tracking link the user clicked.
 */
export function parseUtmParams(
  source: string | URLSearchParams | Record<string, string>,
): ParsedTrackingParams {
  const params =
    typeof source === 'string'
      ? new URLSearchParams(source)
      : source instanceof URLSearchParams
        ? source
        : new URLSearchParams(source);

  const result: ParsedTrackingParams = {};
  const utmKeys = [
    'utm_source',
    'utm_campaign',
    'utm_medium',
    'utm_term',
    'utm_content',
    'ref',
  ] as const;

  for (const key of utmKeys) {
    const val = params.get(key);
    if (val) result[key] = val;
  }

  return result;
}
