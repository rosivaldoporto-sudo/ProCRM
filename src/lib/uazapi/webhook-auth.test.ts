import { describe, expect, it } from 'vitest';
import {
  buildUazapiWebhookUrl,
  readWebhookBody,
  verifyUazapiWebhookCredential,
  WebhookPayloadTooLargeError,
} from './webhook-auth';

describe('verifyUazapiWebhookCredential', () => {
  it('accepts the instance token using constant-time comparison', () => {
    const request = new Request('https://crm.example/api/webhook');
    expect(
      verifyUazapiWebhookCredential({
        request,
        payloadToken: 'instance-secret',
        instanceToken: 'instance-secret',
      })
    ).toBe(true);
  });

  it('accepts a configured shared secret and rejects invalid credentials', () => {
    const valid = new Request('https://crm.example/api/webhook', {
      headers: { 'x-uazapi-webhook-secret': 'shared-secret' },
    });
    const invalid = new Request('https://crm.example/api/webhook', {
      headers: { 'x-uazapi-webhook-secret': 'wrong' },
    });
    const args = {
      instanceToken: 'instance-secret',
      webhookSecret: 'shared-secret',
    };
    expect(verifyUazapiWebhookCredential({ ...args, request: valid })).toBe(
      true
    );
    expect(verifyUazapiWebhookCredential({ ...args, request: invalid })).toBe(
      false
    );
  });

  it('rejects secrets placed in the URL query string', () => {
    const request = new Request(
      'https://crm.example/api/webhook?uazapi_secret=shared-secret'
    );
    expect(
      verifyUazapiWebhookCredential({
        request,
        instanceToken: 'instance-secret',
        webhookSecret: 'shared-secret',
      })
    ).toBe(false);
  });
});

describe('readWebhookBody', () => {
  it('reads a bounded body', async () => {
    const request = new Request('https://crm.example/api/webhook', {
      method: 'POST',
      body: '{"ok":true}',
    });
    await expect(readWebhookBody(request, 32)).resolves.toBe('{"ok":true}');
  });

  it('rejects an oversized body before JSON parsing', async () => {
    const request = new Request('https://crm.example/api/webhook', {
      method: 'POST',
      body: 'x'.repeat(33),
    });
    await expect(readWebhookBody(request, 32)).rejects.toBeInstanceOf(
      WebhookPayloadTooLargeError
    );
  });
});

it('builds an encoded webhook URL without putting secrets in its query', () => {
  expect(
    buildUazapiWebhookUrl('https://crm.example', 'account/id')
  ).toBe('https://crm.example/api/uazapi/webhook/account%2Fid');
});
