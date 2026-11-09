import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/pt-BR.json';
import type { MessageReferral } from '@/types';
import { AdReferralCard } from './ad-referral-card';

function render(referral: MessageReferral): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="pt-BR"
      messages={messages}
      timeZone="America/Sao_Paulo"
    >
      <AdReferralCard referral={referral} />
    </NextIntlClientProvider>
  );
}

describe('AdReferralCard', () => {
  it('mostra título, texto, miniatura e o link para o anúncio', () => {
    const html = render({
      source_url: 'https://fb.me/2ZHeY5pVa',
      source_type: 'ad',
      headline: 'Consultoria gratuita',
      body: 'Fale com a gente',
      media_type: 'image',
      thumbnail_url: 'https://scontent.xx.fbcdn.net/v/thumb.jpg',
    });

    expect(html).toContain('Veio de um anúncio');
    expect(html).toContain('Consultoria gratuita');
    expect(html).toContain('Fale com a gente');
    expect(html).toContain('Ver anúncio');
    expect(html).toContain('fb.me');
    expect(html).toContain('src="https://scontent.xx.fbcdn.net/v/thumb.jpg"');
    expect(html).toContain('referrerPolicy="no-referrer"');

    const links = html.match(/<a [^>]*>/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a).toContain('href="https://fb.me/2ZHeY5pVa"');
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer"');
    }
  });

  it('publicação usa os textos de publicação', () => {
    const html = render({
      source_url: 'https://www.instagram.com/p/xyz/',
      source_type: 'post',
      headline: 'Curso online',
    });

    expect(html).toContain('Veio de uma publicação');
    expect(html).toContain('Ver publicação');
    expect(html).toContain('instagram.com');
  });

  it('não cria link nem imagem com URL que não é https', () => {
    const html = render({
      source_url: 'javascript:alert(1)',
      thumbnail_url: 'http://insecure.example/t.jpg',
      headline: 'Sem link',
    });

    expect(html).toContain('Sem link');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
  });
});
