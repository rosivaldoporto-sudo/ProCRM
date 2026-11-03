// ============================================================
// SSRF guard for outbound webhook delivery.
//
// A webhook URL is attacker-influenced (any account admin with
// `webhooks:manage` can register one) and our server makes the request,
// so an unguarded fetch is a Server-Side Request Forgery primitive: a
// URL pointing at `127.0.0.1`, a cloud metadata IP (`169.254.169.254`),
// or an RFC1918 host would let a caller probe / POST to internal
// services from the app's network.
//
// `isDeliverableUrl` resolves the host and rejects any address that is
// loopback, private, link-local, ULA, or otherwise non-publicly-
// routable. Combined with `redirect: 'manual'` at the call site (so a
// public URL can't 3xx-bounce to an internal one), this blocks the
// common SSRF vectors. It is NOT a defense against DNS rebinding (a
// host that resolves public here but flips to private before connect) —
// that needs pinning the resolved IP into the socket, which fetch
// doesn't expose; documented as a residual risk.
// ============================================================

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

function isPrivateOrReservedIpv4(a: number, b: number, c: number): boolean {
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * Expand an IPv6 literal into its 8 hextets, or null when it can't be
 * parsed. A dotted IPv4 tail (`::ffff:127.0.0.1`) is folded into two
 * hextets so every spelling of the same address compares the same —
 * the WHATWG URL parser rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`,
 * so matching on the textual form alone lets an embedded private IPv4
 * through.
 */
function parseIpv6(raw: string): number[] | null {
  let ip = raw.split('%')[0];
  const dotted = ip.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dotted) {
    const octets = dotted.slice(2).map(Number);
    if (octets.some((n) => n > 255)) return null;
    ip =
      dotted[1] +
      ((octets[0] << 8) | octets[1]).toString(16) +
      ':' +
      ((octets[2] << 8) | octets[3]).toString(16);
  }

  const sides = ip.split('::');
  if (sides.length > 2) return null;
  const head = sides[0] ? sides[0].split(':') : [];
  const tail = sides[1] ? sides[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (sides.length === 1 ? missing !== 0 : missing < 1) return null;

  const hextets = [...head, ...Array<string>(missing).fill('0'), ...tail].map(
    (part) => (/^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : NaN)
  );
  return hextets.some(Number.isNaN) ? null : hextets;
}

/** True for loopback / private / link-local / reserved IPv4 or IPv6. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    return isPrivateOrReservedIpv4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
  }

  const parts = parseIpv6(ip.toLowerCase().replace(/^\[|\]$/g, ''));
  // Unparseable means we can't vouch for it — treat as not public.
  if (!parts) return true;

  const embeddedV4 = (hi: number, lo: number) =>
    isPrivateOrReservedIpv4(hi >> 8, hi & 0xff, lo >> 8);
  const allZero = (from: number, to: number) =>
    parts.slice(from, to).every((part) => part === 0);

  if (allZero(0, 6)) {
    // `::`, `::1` and the deprecated IPv4-compatible `::a.b.c.d`.
    if (parts[6] === 0 && parts[7] <= 1) return true;
    return embeddedV4(parts[6], parts[7]);
  }
  if (allZero(0, 5) && parts[5] === 0xffff) {
    return embeddedV4(parts[6], parts[7]); // IPv4-mapped
  }
  if (allZero(0, 4) && parts[4] === 0xffff && parts[5] === 0) {
    return embeddedV4(parts[6], parts[7]); // IPv4-translated
  }
  if (parts[0] === 0x64 && parts[1] === 0xff9b) {
    if (parts[2] !== 0) return true; // 64:ff9b:1::/48 local-use NAT64
    return embeddedV4(parts[6], parts[7]);
  }
  if (parts[0] === 0x2002) return embeddedV4(parts[1], parts[2]); // 6to4
  if (parts[0] === 0x2001 && (parts[1] === 0 || parts[1] === 0xdb8)) {
    return true; // Teredo + documentation
  }
  if ((parts[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((parts[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((parts[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((parts[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * True if `rawUrl`'s host resolves only to publicly-routable
 * address(es). Returns false for a malformed URL, a non-http(s) scheme,
 * an obvious internal name (`localhost`, `*.local`, `*.internal`), a
 * literal private IP, or a hostname that resolves to any
 * private/reserved address.
 */
export async function isDeliverableUrl(rawUrl: string): Promise<boolean> {
  let host: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    host = parsed.hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }

  if (isIP(host)) return !isPrivateOrReservedIp(host);

  const lower = host.toLowerCase().replace(/\.$/, '');
  if (
    lower === 'localhost' ||
    lower.endsWith('.localhost') ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return false;
  }

  try {
    const results = await lookup(host, { all: true });
    if (results.length === 0) return false;
    return results.every((r) => !isPrivateOrReservedIp(r.address));
  } catch {
    return false; // unresolvable → not deliverable
  }
}
