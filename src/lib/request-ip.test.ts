import { describe, expect, it } from 'vitest';
import { getClientIp } from './request-ip';

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/', { headers });
}

describe('getClientIp', () => {
  it('prefere cf-connecting-ip válido', () => {
    expect(
      getClientIp(
        req({
          'cf-connecting-ip': '1.2.3.4',
          'x-real-ip': '5.6.7.8',
          'x-forwarded-for': '9.9.9.9',
        })
      )
    ).toBe('1.2.3.4');
  });

  it('prefere x-real-ip ao XFF falsificável', () => {
    expect(
      getClientIp(
        req({
          'x-forwarded-for': 'spoofed, 5.6.7.8',
          'x-real-ip': '5.6.7.8',
        })
      )
    ).toBe('5.6.7.8');
  });

  it('pega o item mais à direita do XFF (hop do edge confiável)', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }))).toBe('2.2.2.2');
  });

  it('ignora valores inválidos e cai para unknown', () => {
    expect(getClientIp(req({ 'x-forwarded-for': 'spoofed' }))).toBe('unknown');
    expect(getClientIp(req({ 'x-real-ip': 'not-an-ip' }))).toBe('unknown');
    expect(getClientIp(req({}))).toBe('unknown');
  });
});
