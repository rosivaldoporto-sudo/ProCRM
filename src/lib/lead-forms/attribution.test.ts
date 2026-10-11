import { describe, expect, it } from 'vitest';
import {
  attributionLabel,
  normalizeAttribution,
  sanitizeTracking,
} from './attribution';

describe('normalizeAttribution', () => {
  it('resolve campanha/conjunto/anúncio das macros da Meta', () => {
    const a = normalizeAttribution({
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'Promo Verão',
      utm_term: 'Interesses',
      utm_content: 'Criativo A',
      ad_id: '123',
      fbclid: 'abc',
    });
    expect(a.source).toBe('meta');
    expect(a.sourceLabel).toBe('Meta Ads');
    expect(a.campaign).toBe('Promo Verão');
    expect(a.adset).toBe('Interesses');
    expect(a.ad).toBe('Criativo A');
    expect(a.adId).toBe('123');
    expect(a.clickType).toBe('fbclid');
    expect(a.hasAds).toBe(true);
    expect(attributionLabel(a)).toBe('Promo Verão · Criativo A');
  });

  it('deduz Meta só pelo fbclid quando não há utm', () => {
    const a = normalizeAttribution({ fbclid: 'xyz' });
    expect(a.source).toBe('meta');
    expect(a.hasAds).toBe(true);
    expect(attributionLabel(a)).toBe('Meta Ads');
  });

  it('deduz Google pelo gclid e TikTok pelo ttclid', () => {
    expect(normalizeAttribution({ gclid: 'g' }).source).toBe('google');
    expect(normalizeAttribution({ ttclid: 't' }).source).toBe('tiktok');
  });

  it('usa o referrer quando não há params pagos', () => {
    const a = normalizeAttribution({ referrer: 'https://www.google.com/search?q=x' });
    expect(a.source).toBe('google');
    expect(a.hasAds).toBe(false);
  });

  it('retorna Direto sem nenhum sinal', () => {
    const a = normalizeAttribution({});
    expect(a.source).toBe('direct');
    expect(a.sourceLabel).toBe('Direto');
    expect(a.hasAds).toBe(false);
    expect(attributionLabel(a)).toBe('Direto');
  });

  it('exibe utm_source desconhecido como está', () => {
    const a = normalizeAttribution({ utm_source: 'newsletter' });
    expect(a.source).toBe('newsletter');
    expect(a.sourceLabel).toBe('newsletter');
  });

  it('tolera tracking nulo (linhas antigas)', () => {
    expect(normalizeAttribution(null).source).toBe('direct');
    expect(normalizeAttribution(undefined).source).toBe('direct');
  });
});

describe('sanitizeTracking', () => {
  it('mantém só chaves conhecidas e corta valores longos', () => {
    const out = sanitizeTracking({
      utm_campaign: 'Promo',
      fbclid: 'abc',
      evil: 'x',
      __proto__: 'polluted',
      utm_source: 123,
      source_url: `https://x/${'a'.repeat(5000)}`,
    });
    expect(out).toEqual({
      utm_campaign: 'Promo',
      fbclid: 'abc',
      source_url: expect.stringMatching(/^https:\/\/x\//),
    });
    expect((out.source_url ?? '').length).toBeLessThanOrEqual(2000);
    expect('evil' in out).toBe(false);
    // '__proto__' nunca vira own-property (sem ele, JSON.parse não polui o prototype)
    expect({}.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect((out as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('retorna {} para entradas inválidas sem lançar', () => {
    expect(sanitizeTracking(null)).toEqual({});
    expect(sanitizeTracking('str')).toEqual({});
    expect(sanitizeTracking([['utm_source', 'x']])).toEqual({});
  });
});
