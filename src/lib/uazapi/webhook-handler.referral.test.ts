import { describe, expect, it } from 'vitest';
import { extractMessages } from './webhook-handler';

// Formato do anúncio na Uazapi: não há um payload real de anúncio
// documentado, então os testes cobrem as grafias do WhatsApp Web que o
// extrator aceita (whatsmeow e Baileys).

const AD = {
  title: 'Promoção de novembro',
  body: 'Clique e fale com a loja',
  mediaType: 1,
  thumbnailURL: 'https://scontent.xx.fbcdn.net/v/t.jpg',
  sourceType: 'ad',
  sourceID: '1202',
  sourceURL: 'https://fb.me/abc',
  ctwaClid: 'clid-1',
};

const EXPECTED = {
  source_url: 'https://fb.me/abc',
  source_id: '1202',
  source_type: 'ad',
  headline: 'Promoção de novembro',
  body: 'Clique e fale com a loja',
  media_type: 'image',
  thumbnail_url: 'https://scontent.xx.fbcdn.net/v/t.jpg',
  ctwa_clid: 'clid-1',
};

describe('extractMessages (Uazapi) — anúncio de origem', () => {
  it('payload v2: lê content.contextInfo.externalAdReply', () => {
    const [msg] = extractMessages({
      EventType: 'messages',
      message: {
        messageid: 'U1',
        chatid: '5511999990000@s.whatsapp.net',
        sender: '5511999990000@s.whatsapp.net',
        senderName: 'Ana',
        messageType: 'ExtendedTextMessage',
        text: 'Olá! Posso ter mais informações sobre isso?',
        content: {
          text: 'Olá! Posso ter mais informações sobre isso?',
          contextInfo: { externalAdReply: AD, conversionSource: 'FB_Ads' },
        },
        fromMe: false,
        messageTimestamp: 1760000000000,
      },
    });

    expect(msg.contentText).toBe('Olá! Posso ter mais informações sobre isso?');
    expect(msg.referral).toEqual(EXPECTED);
  });

  it('formato Baileys (data.msg): lê extendedTextMessage.contextInfo', () => {
    const [msg] = extractMessages({
      data: {
        msg: {
          key: { id: 'B1', remoteJid: '5511999990000@s.whatsapp.net' },
          pushName: 'Ana',
          message: {
            extendedTextMessage: {
              text: 'Oi',
              contextInfo: {
                externalAdReply: {
                  title: 'Curso online',
                  sourceUrl: 'https://www.instagram.com/p/xyz/',
                  thumbnailUrl: 'https://scontent.xx.fbcdn.net/v/v.jpg',
                  sourceType: 'post',
                },
              } as never,
            },
          },
        },
      },
    });

    expect(msg.referral).toEqual({
      source_url: 'https://www.instagram.com/p/xyz/',
      source_type: 'post',
      headline: 'Curso online',
      thumbnail_url: 'https://scontent.xx.fbcdn.net/v/v.jpg',
    });
  });

  it('mensagem comum fica sem referral', () => {
    const [msg] = extractMessages({
      message: {
        messageid: 'U2',
        chatid: '5511999990000@s.whatsapp.net',
        messageType: 'Conversation',
        text: 'Bom dia',
        content: 'Bom dia',
        fromMe: false,
      },
    });

    expect(msg.referral).toBeNull();
  });

  it('mensagem enviada pelo celular não ganha cartão de anúncio', () => {
    const [msg] = extractMessages({
      message: {
        messageid: 'U3',
        chatid: '5511999990000@s.whatsapp.net',
        messageType: 'ExtendedTextMessage',
        text: 'Segue o link',
        content: { text: 'Segue o link', contextInfo: { externalAdReply: AD } },
        fromMe: true,
      },
    });

    expect(msg.referral).toBeNull();
  });
});
