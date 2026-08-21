import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

export class UnsafeRemoteUrlError extends Error {
  constructor(message = 'Remote URL is not allowed') {
    super(message);
    this.name = 'UnsafeRemoteUrlError';
  }
}

export function isSameOrigin(candidate: string, trustedBase: string): boolean {
  try {
    return new URL(candidate).origin === new URL(trustedBase).origin;
  } catch {
    return false;
  }
}

export async function fetchRemoteBytes(args: {
  url: string;
  headers?: Record<string, string>;
  maxBytes: number;
  allowedContentTypes?: readonly string[];
  timeoutMs?: number;
}): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const {
    url,
    headers = {},
    maxBytes,
    allowedContentTypes,
    timeoutMs = 15_000,
  } = args;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeRemoteUrlError();
  }
  if (
    parsed.protocol !== 'https:' ||
    !(await isDeliverableUrl(parsed.toString()))
  ) {
    throw new UnsafeRemoteUrlError();
  }

  const response = await fetch(parsed, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || (response.status >= 300 && response.status < 400))
    return null;

  const contentType = (
    response.headers.get('content-type') || 'application/octet-stream'
  )
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (
    allowedContentTypes?.length &&
    !allowedContentTypes.some(
      (allowed) =>
        contentType === allowed || contentType.startsWith(`${allowed}/`)
    )
  ) {
    return null;
  }

  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return {
    buffer: bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ),
    contentType,
  };
}
