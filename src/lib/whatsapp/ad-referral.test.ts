import { describe, expect, it } from 'vitest';
import {
  isMissingReferralColumnError,
  parseCloudApiReferral,
  parseUazapiReferral,
  toHttpsUrl,
} from './ad-referral';

describe('toHttpsUrl', () => {
  it('aceita só https', () => {
    expect(toHttpsUrl('https://fb.me/abc')).toBe('https://fb.me/abc');
    expect(toHttpsUrl('  https://fb.me/abc  ')).toBe('https://fb.me/abc');
    expect(toHttpsUrl('http://fb.me/abc')).toBeNull();
    expect(toHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(toHttpsUrl('java\tscript:alert(1)')).toBeNull();
    expect(toHttpsUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(toHttpsUrl('/api/x')).toBeNull();
    expect(toHttpsUrl('')).toBeNull();
    expect(toHttpsUrl(42)).toBeNull();
    expect(toHttpsUrl(`https://x.com/${'a'.repeat(3000)}`)).toBeNull();
  });
});

describe('parseCloudApiReferral', () => {
  it('converte o referral completo da Cloud API', () => {
    expect(
      parseCloudApiReferral({
        source_url: 'https://fb.me/2ZHeY5pVa',
        source_id: '120210000000000',
        source_type: 'ad',
        headline: 'Consultoria gratuita',
        body: 'Fale com a gente no WhatsApp',
        media_type: 'video',
        video_url: 'https://video.xx.fbcdn.net/v/ad.mp4',
        thumbnail_url: 'https://scontent.xx.fbcdn.net/v/thumb.jpg',
        ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
        welcome_message: { text: 'Olá!' },
      })
    ).toEqual({
      source_url: 'https://fb.me/2ZHeY5pVa',
      source_id: '120210000000000',
      source_type: 'ad',
      headline: 'Consultoria gratuita',
      body: 'Fale com a gente no WhatsApp',
      media_type: 'video',
      video_url: 'https://video.xx.fbcdn.net/v/ad.mp4',
      thumbnail_url: 'https://scontent.xx.fbcdn.net/v/thumb.jpg',
      ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ',
    });
  });

  it('descarta URLs que não são https e campos que não são texto', () => {
    expect(
      parseCloudApiReferral({
        source_url: 'javascript:alert(document.cookie)',
        image_url: 'http://insecure.example/a.jpg',
        headline: { nested: true },
        body: '   ',
        source_type: 'POST',
        media_type: 'gif',
      })
    ).toEqual({ source_type: 'post' });
  });

  it('limita o tamanho dos textos', () => {
    const out = parseCloudApiReferral({ body: 'x'.repeat(5000) });
    expect(out?.body).toHaveLength(1000);
  });

  it('devolve null sem referral ou sem nada aproveitável', () => {
    expect(parseCloudApiReferral(undefined)).toBeNull();
    expect(parseCloudApiReferral(null)).toBeNull();
    expect(parseCloudApiReferral('ad')).toBeNull();
    expect(parseCloudApiReferral([])).toBeNull();
    expect(parseCloudApiReferral({})).toBeNull();
    expect(parseCloudApiReferral({ source_url: 'ftp://x' })).toBeNull();
  });
});

describe('parseUazapiReferral', () => {
  it('lê externalAdReply com a grafia do whatsmeow (sourceURL, thumbnailURL)', () => {
    const content = {
      text: 'Olá! Posso ter mais informações sobre isso?',
      contextInfo: {
        externalAdReply: {
          title: 'Promoção de novembro',
          body: 'Clique e fale com a loja',
          mediaType: 1,
          thumbnailURL: 'https://scontent.xx.fbcdn.net/v/t.jpg',
          sourceType: 'ad',
          sourceID: '1202',
          sourceURL: 'https://fb.me/abc',
          ctwaClid: 'clid-1',
          thumbnail: '/9j/4AAQSkZJRg==',
        },
        conversionSource: 'FB_Ads',
      },
    };
    expect(parseUazapiReferral(content)).toEqual({
      source_url: 'https://fb.me/abc',
      source_id: '1202',
      source_type: 'ad',
      headline: 'Promoção de novembro',
      body: 'Clique e fale com a loja',
      media_type: 'image',
      thumbnail_url: 'https://scontent.xx.fbcdn.net/v/t.jpg',
      ctwa_clid: 'clid-1',
    });
  });

  it('lê a grafia do Baileys dentro de extendedTextMessage', () => {
    const message = {
      extendedTextMessage: {
        text: 'Oi',
        contextInfo: {
          externalAdReply: {
            title: 'Curso online',
            mediaType: 'VIDEO',
            thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/v.jpg',
            mediaUrl: 'https://www.instagram.com/p/xyz/',
            sourceType: 'post',
            sourceId: '99',
          },
        },
      },
    };
    expect(parseUazapiReferral(message)).toEqual({
      source_url: 'https://www.instagram.com/p/xyz/',
      source_id: '99',
      source_type: 'post',
      headline: 'Curso online',
      media_type: 'video',
      thumbnail_url: 'https://scontent.xx.fbcdn.net/v/v.jpg',
    });
  });

  it('ignora o anúncio de uma mensagem citada', () => {
    const content = {
      text: 'Respondendo',
      contextInfo: {
        stanzaId: 'ABC',
        quotedMessage: {
          extendedTextMessage: {
            contextInfo: {
              externalAdReply: { title: 'Anúncio citado', sourceUrl: 'https://fb.me/q' },
            },
          },
        },
      },
    };
    expect(parseUazapiReferral(content)).toBeNull();
  });

  it('procura em cada fonte até achar e devolve null quando não há anúncio', () => {
    expect(parseUazapiReferral(undefined, 'texto', { contextInfo: {} })).toBeNull();
    expect(
      parseUazapiReferral(
        { contextInfo: {} },
        { contextInfo: { externalAdReply: { title: 'Achou' } } }
      )
    ).toEqual({ headline: 'Achou' });
  });

  it('descarta links que não são https', () => {
    expect(
      parseUazapiReferral({
        contextInfo: {
          externalAdReply: {
            title: 'X',
            sourceUrl: 'javascript:alert(1)',
            thumbnailUrl: 'http://x/t.jpg',
          },
        },
      })
    ).toEqual({ headline: 'X' });
  });
});

describe('isMissingReferralColumnError', () => {
  it('reconhece a falta da coluna referral', () => {
    expect(
      isMissingReferralColumnError({
        code: 'PGRST204',
        message: "Could not find the 'referral' column of 'messages' in the schema cache",
      })
    ).toBe(true);
    expect(
      isMissingReferralColumnError({
        code: '42703',
        message: 'column "referral" of relation "messages" does not exist',
      })
    ).toBe(true);
  });

  it('não confunde com outros erros', () => {
    expect(isMissingReferralColumnError(null)).toBe(false);
    expect(
      isMissingReferralColumnError({ code: '23505', message: 'duplicate key' })
    ).toBe(false);
    expect(
      isMissingReferralColumnError({
        code: 'PGRST204',
        message: "Could not find the 'foo' column",
      })
    ).toBe(false);
  });
});
