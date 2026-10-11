import { isIP } from 'node:net';

/**
 * Resolve a client address without trusting the attacker-controlled
 * left-most X-Forwarded-For value. Hostinger/reverse proxies normally set
 * X-Real-IP; Cloudflare sets CF-Connecting-IP; otherwise we take the
 * right-most valid forwarded address, which is the hop appended by the
 * trusted edge. Every candidate is validated with `isIP` — garbage
 * headers fall through to 'unknown' instead of poisoning rate-limit
 * buckets and audit columns.
 */
export function getClientIp(request: Request): string {
  const connecting = request.headers.get('cf-connecting-ip')?.trim();
  if (connecting && isIP(connecting)) return connecting;

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp && isIP(realIp)) return realIp;

  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => isIP(value));
  return forwarded?.at(-1) ?? 'unknown';
}
