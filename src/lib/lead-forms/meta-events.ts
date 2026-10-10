/**
 * Eventos Meta (Pixel browser + CAPI server) para o funil do Lead Form.
 *
 * Funil padrão:
 *  - ViewContent  → formulário visualizado
 *  - Lead         → resposta completa
 *  - CompleteRegistration → qualificado
 *  - Schedule     → reunião agendada
 *
 * Browser: snippet via <Script nonce> em public-form.tsx + `trackFormPixel()`.
 * Server: `fireFormCapiEvent()` reaproveita meta_ads_config da conta
 * (pixel_id + access_token) via Conversions API.
 */
import { sendCapiEvents } from '@/lib/facebook/conversions-api';
import { decrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin } from '@/lib/flows/admin-client';

export type FormFunnelEvent = 'ViewContent' | 'Lead' | 'CompleteRegistration' | 'Schedule' | 'QualifiedLead';

export const FB_EVENTS_URL = 'https://connect.facebook.net/en_US/fbevents.js';

export function trackFormPixel(pixelId: string, event: FormFunnelEvent, params: Record<string, unknown> = {}): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { fbq?: (...args: unknown[]) => void };
  if (typeof w.fbq !== 'function') return;
  try {
    w.fbq('trackSingle', pixelId, event, params);
  } catch {
    /* noop */
  }
}

interface FireArgs {
  accountId: string;
  formId: string;
  responseId?: string;
  event: FormFunnelEvent;
  email?: string;
  phone?: string;
  firstName?: string;
  eventSourceUrl?: string;
  fbp?: string;
  fbc?: string;
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
    const eventId = `form_${args.formId}_${args.event}_${args.responseId ?? Date.now()}_${Date.now()}`;
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
            ...(args.firstName ? { firstName: args.firstName } : {}),
            ...(args.email ? { email: args.email } : {}),
            ...(args.responseId ? { external_id: args.responseId } : {}),
          },
          custom_data: {
            content_name: `lead_form:${args.formId}`,
            ...(args.event === 'QualifiedLead' ? { lead_quality: 'qualified' } : {}),
            ...(args.value !== undefined ? { value: args.value, currency: 'BRL' } : {}),
            ...(args.fbp ? { fbp: args.fbp } : {}),
            ...(args.fbc ? { fbc: args.fbc } : {}),
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
