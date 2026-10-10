/**
 * Eventos Meta CAPI (server) para o funil do Lead Form.
 *
 * SERVER-ONLY (importa supabaseAdmin + encryption). O browser usa
 * `meta-pixel.ts` (client-safe).
 *
 * Funil:
 *  - ViewContent          → browser (pixel)
 *  - Lead                 → browser + CAPI com o MESMO event_id (dedup)
 *  - CompleteRegistration → CAPI (qualificado, sem par browser)
 *  - QualifiedLead        → CAPI como Lead + lead_quality=qualified
 *  - Schedule             → browser + CAPI com event_id `booking_<id>`
 */
import {
  buildFbc,
  sendCapiEvents,
  splitName,
  validFbp,
  type FormFunnelEvent,
} from '@/lib/facebook/conversions-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export type { FormFunnelEvent };

interface FireArgs {
  accountId: string;
  formId: string;
  responseId?: string;
  event: FormFunnelEvent;
  email?: string;
  phone?: string;
  fullName?: string;
  eventSourceUrl?: string;
  fbp?: string;
  fbc?: string;
  fbclid?: string;
  clientIp?: string;
  clientUa?: string;
  /** Id de dedup compartilhado com o browser (redundant setup). */
  eventId?: string;
  custom?: Record<string, unknown>;
  value?: number;
}

/** Dispara CAPI server-side. Fire-and-forget — nunca quebra o submit. */
export async function fireFormCapiEvent(args: FireArgs): Promise<string | null> {
  try {
    const db = supabaseAdmin();
    const { data: cfg } = await db
      .from('meta_ads_config')
      .select('pixel_id, access_token, test_event_code')
      .eq('account_id', args.accountId)
      .maybeSingle();
    const row = cfg as { pixel_id: string | null; access_token: string | null; test_event_code: string | null } | null;
    if (!row?.pixel_id || !row?.access_token) return null;
    let token = row.access_token;
    if (token.includes(':')) {
      try {
        token = decrypt(token);
      } catch {
        return null;
      }
    }
    const eventId =
      args.eventId ?? `form_${args.formId}_${args.event}_${args.responseId ?? Date.now()}_${Date.now()}`;
    const { first, last } = splitName(args.fullName);
    await sendCapiEvents(
      { pixelId: row.pixel_id, accessToken: token, testEventCode: row.test_event_code ?? undefined },
      [
        {
          event_name: args.event === 'QualifiedLead' ? 'Lead' : args.event,
          event_time: Math.floor(Date.now() / 1000),
          action_source: 'website',
          event_id: eventId,
          event_source_url: args.eventSourceUrl,
          user_data: {
            ...(args.phone ? { phones: [args.phone] } : {}),
            ...(args.email ? { emails: [args.email] } : {}),
            ...(first ? { firstName: first } : {}),
            ...(last ? { lastName: last } : {}),
            ...(args.responseId ? { external_id: args.responseId } : {}),
            ...(validFbp(args.fbp) ? { fbp: validFbp(args.fbp) } : {}),
            ...(buildFbc(args.fbc, args.fbclid) ? { fbc: buildFbc(args.fbc, args.fbclid) } : {}),
            ...(args.clientIp && args.clientIp !== 'unknown' ? { clientIpAddress: args.clientIp } : {}),
            ...(args.clientUa ? { clientUserAgent: args.clientUa.slice(0, 500) } : {}),
          },
          custom_data: {
            content_name: `lead_form:${args.formId}`,
            ...(args.event === 'QualifiedLead' ? { lead_quality: 'qualified' } : {}),
            ...(args.value !== undefined ? { value: args.value, currency: 'BRL' } : {}),
            ...args.custom,
          },
        },
      ],
    );
    return eventId;
  } catch (err) {
    console.error('[lead-forms:capi]', err instanceof Error ? err.message : err);
    return null;
  }
}
