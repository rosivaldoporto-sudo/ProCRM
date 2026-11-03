/**
 * Response headers for the authenticated media proxies
 * (`/api/whatsapp/media/*`, `/api/uazapi/media/*`).
 *
 * The bytes and the content type come from whoever sent the WhatsApp
 * message, and the proxies answer from the app's own origin. So a file
 * declared as `text/html` or `image/svg+xml` must never render inline
 * (stored XSS / phishing under our domain), and a customer's attachment
 * must never land in a shared cache (`private`, not `public`).
 */
const INLINE_PREFIXES = ['image/', 'audio/', 'video/'];
const INLINE_EXACT = ['application/pdf'];
const NEVER_INLINE = ['image/svg+xml'];

export function mediaResponseHeaders(
  rawContentType: string | null | undefined
): Record<string, string> {
  const contentType = (rawContentType ?? '').trim();
  const essence = contentType.split(';', 1)[0].trim().toLowerCase();
  const inline =
    !NEVER_INLINE.includes(essence) &&
    (INLINE_EXACT.includes(essence) ||
      INLINE_PREFIXES.some((prefix) => essence.startsWith(prefix)));

  return {
    'Content-Type': inline ? contentType : 'application/octet-stream',
    'Content-Disposition': inline ? 'inline' : 'attachment',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=86400',
  };
}
