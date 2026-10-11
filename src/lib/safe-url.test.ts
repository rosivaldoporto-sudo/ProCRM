import { describe, expect, it } from 'vitest';
import { isSafeLinkUrl } from './safe-url';

describe('isSafeLinkUrl', () => {
  it('aceita https, http, blob e paths same-origin', () => {
    expect(isSafeLinkUrl('https://example.com/a.mp3')).toBe(true);
    expect(isSafeLinkUrl('http://example.com/a.mp3')).toBe(true);
    expect(isSafeLinkUrl('blob:https://app/x')).toBe(true);
    expect(isSafeLinkUrl('/api/whatsapp/media/123')).toBe(true);
  });

  it('bloqueia javascript:, data:, vbscript: e bypass com controle', () => {
    expect(isSafeLinkUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeLinkUrl('JaVaScRiPt:alert(1)')).toBe(false);
    expect(isSafeLinkUrl('java\tscript:alert(1)')).toBe(false);
    expect(isSafeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeLinkUrl('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeLinkUrl('file:///etc/passwd')).toBe(false);
  });

  it('bloqueia protocol-relative e inválidas', () => {
    expect(isSafeLinkUrl('//evil.com/x')).toBe(false);
    expect(isSafeLinkUrl('not a url')).toBe(false);
    expect(isSafeLinkUrl('')).toBe(false);
    expect(isSafeLinkUrl(null)).toBe(false);
    expect(isSafeLinkUrl(undefined)).toBe(false);
  });
});
