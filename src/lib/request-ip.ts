import { isIP } from 'node:net';

/**
 * Resolve a client address without trusting the attacker-controlled
 * left-most X-Forwarded-For value. Hostinger/reverse proxies normally set
 * X-Real-IP; otherwise we take the right-most valid forwarded address,
 * which is the hop appended by the trusted edge.
 */
export function getClientIp(request: Request): string {
  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp && isIP(realIp)) return realIp;

  const forwarded = request.headers
    .get('x-forwarded-for')
    ?.split(',')
    .map((value) => value.trim())
    .filter((value) => isIP(value));
  return forwarded?.at(-1) ?? 'unknown';
}
