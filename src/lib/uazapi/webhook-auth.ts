import { timingSafeEqual } from 'node:crypto';

export const UAZAPI_WEBHOOK_MAX_BYTES = 1024 * 1024;

export class WebhookPayloadTooLargeError extends Error {
  constructor() {
    super('Webhook payload too large');
    this.name = 'WebhookPayloadTooLargeError';
  }
}

function safeEqual(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Uazapi v2 includes the instance token in each webhook payload. Older
 * builds may instead be configured with a shared secret in the webhook URL
 * or a custom header. Accept either credential, but never accept a request
 * merely because it knows the account UUID.
 */
export function verifyUazapiWebhookCredential(args: {
  request: Request;
  payloadToken?: string;
  instanceToken: string;
  webhookSecret?: string;
}): boolean {
  const { request, payloadToken, instanceToken, webhookSecret } = args;
  if (safeEqual(payloadToken, instanceToken)) return true;
  if (!webhookSecret) return false;

  const urlSecret = new URL(request.url).searchParams.get('uazapi_secret');
  const headerSecret =
    request.headers.get('x-uazapi-webhook-secret') ??
    request.headers.get('x-webhook-secret');
  return (
    safeEqual(headerSecret, webhookSecret) ||
    safeEqual(urlSecret, webhookSecret)
  );
}

/** Read a request body without allowing an unauthenticated sender to buffer it indefinitely. */
export async function readWebhookBody(
  request: Request,
  maxBytes = UAZAPI_WEBHOOK_MAX_BYTES
): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new WebhookPayloadTooLargeError();
  }

  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new WebhookPayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    'utf8'
  );
}

export function buildUazapiWebhookUrl(
  origin: string,
  accountId: string,
  webhookSecret?: string
): string {
  const url = new URL(
    `/api/uazapi/webhook/${encodeURIComponent(accountId)}`,
    origin
  );
  if (webhookSecret) url.searchParams.set('uazapi_secret', webhookSecret);
  return url.toString();
}
