/**
 * Meta Pixel (browser) — client-safe, SEM imports de servidor.
 *
 * Mantido separado de `meta-events.ts` (que importa supabaseAdmin +
 * node:crypto via encryption) para não vazar módulos de servidor
 * para o bundle do cliente em /f/[slug].
 */
import type { FormFunnelEvent } from '@/lib/facebook/conversions-api';

export { FB_EVENTS_URL } from '@/lib/facebook/conversions-api';
export type { FormFunnelEvent };

/**
 * Dispara evento browser via fbq. `eventID` (4º arg do fbq) deve ser
 * IGUAL ao `event_id` do evento CAPI correspondente — é assim que a
 * Meta deduplica o redundant setup (browser + servidor).
 */
export function trackFormPixel(
  pixelId: string,
  event: FormFunnelEvent,
  params: Record<string, unknown> = {},
  eventID?: string,
): void {
  if (typeof window === 'undefined') return;
  const w = window as unknown as { fbq?: (...args: unknown[]) => void };
  if (typeof w.fbq !== 'function') return;
  try {
    const args: unknown[] = ['trackSingle', pixelId, event, params];
    if (eventID) args.push({ eventID });
    w.fbq(...args);
  } catch {
    /* noop */
  }
}
