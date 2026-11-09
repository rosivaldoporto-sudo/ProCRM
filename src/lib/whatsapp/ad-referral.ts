import type { MessageReferral } from '@/types';

// ============================================================
// Anúncio de origem da mensagem (Click-to-WhatsApp)
//
// A Cloud API manda um objeto `referral` na primeira mensagem de quem
// clicou num anúncio ou numa publicação. A Uazapi (WhatsApp Web) traz os
// mesmos dados em `contextInfo.externalAdReply`, com outros nomes. Este
// módulo converte os dois formatos para `MessageReferral`, que é gravado
// em `messages.referral` (migration 064) e exibido no inbox.
//
// Tudo aqui vem de fora: só texto, com tamanho limitado, e só URLs
// `https:`. O inbox confere a URL de novo antes de usar.
// ============================================================

const MAX_TEXT = 1000;
const MAX_ID = 200;
const MAX_URL = 2048;

function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value).trim();
  if (!text) return undefined;
  return text.length > max ? text.slice(0, max) : text;
}

/** URL `https:` válida, ou null. Qualquer outro esquema é descartado. */
export function toHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = value.trim();
  if (!url || url.length > MAX_URL) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function cleanUrl(value: unknown): string | undefined {
  return toHttpsUrl(value) ?? undefined;
}

/** 'image' | 'video', aceitando o enum numérico do WhatsApp Web (1, 2). */
function cleanMediaType(value: unknown): string | undefined {
  if (value === 1 || value === '1') return 'image';
  if (value === 2 || value === '2') return 'video';
  const text = cleanText(value, 20)?.toLowerCase();
  if (text === 'image' || text === 'video') return text;
  return undefined;
}

function cleanSourceType(value: unknown): string | undefined {
  return cleanText(value, 40)?.toLowerCase();
}

/** Remove campos vazios; null quando não sobra nada. */
function compact(referral: MessageReferral): MessageReferral | null {
  const entries = Object.entries(referral).filter(
    ([, value]) => value !== undefined
  );
  if (entries.length === 0) return null;
  return Object.fromEntries(entries) as MessageReferral;
}

/**
 * Converte o `referral` da Cloud API (já no formato snake_case da Meta).
 * Null quando o objeto não existe ou não traz nenhum dado aproveitável.
 */
export function parseCloudApiReferral(raw: unknown): MessageReferral | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  return compact({
    source_url: cleanUrl(r.source_url),
    source_id: cleanText(r.source_id, MAX_ID),
    source_type: cleanSourceType(r.source_type),
    headline: cleanText(r.headline, MAX_TEXT),
    body: cleanText(r.body, MAX_TEXT),
    media_type: cleanMediaType(r.media_type),
    image_url: cleanUrl(r.image_url),
    video_url: cleanUrl(r.video_url),
    thumbnail_url: cleanUrl(r.thumbnail_url),
    ctwa_clid: cleanText(r.ctwa_clid, MAX_ID),
  });
}

/**
 * Lê uma chave sem depender da grafia: `sourceUrl`, `sourceURL`,
 * `SourceURL` e `source_url` são a mesma chave. Cada build da Uazapi
 * serializa o protobuf do WhatsApp de um jeito.
 */
function pick(obj: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase().replace(/_/g, '');
  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase().replace(/_/g, '') === wanted) return value;
  }
  return undefined;
}

/**
 * Procura `externalAdReply` dentro do conteúdo da mensagem, até poucos
 * níveis de profundidade (ex.: `contextInfo.externalAdReply` ou
 * `extendedTextMessage.contextInfo.externalAdReply`). Ignora a mensagem
 * citada (`quotedMessage`): um anúncio citado não é a origem desta.
 */
function findExternalAdReply(
  node: unknown,
  depth = 0
): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (depth > 4) return null;
  const obj = node as Record<string, unknown>;

  const direct = pick(obj, 'externalAdReply');
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) {
    return direct as Record<string, unknown>;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (key.toLowerCase() === 'quotedmessage') continue;
    if (!value || typeof value !== 'object') continue;
    const found = findExternalAdReply(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Converte o anúncio que a Uazapi traz em `contextInfo.externalAdReply`.
 * Aceita qualquer um dos objetos onde ele pode aparecer (o `content` do
 * payload v2, o `message` do formato Baileys). A miniatura em base64
 * (`thumbnail`) é ignorada: só URLs `https:` são guardadas.
 */
export function parseUazapiReferral(
  ...sources: unknown[]
): MessageReferral | null {
  for (const source of sources) {
    const ad = findExternalAdReply(source);
    if (!ad) continue;

    const mediaType = cleanMediaType(pick(ad, 'mediaType'));
    const sourceUrl = cleanUrl(pick(ad, 'sourceUrl'));
    const mediaUrl = cleanUrl(pick(ad, 'mediaUrl'));
    const originalImageUrl = cleanUrl(pick(ad, 'originalImageUrl'));

    const referral = compact({
      // Alguns anúncios só trazem o link em `mediaUrl`. No WhatsApp Web
      // ele costuma ser o link da publicação, não o arquivo do vídeo, por
      // isso não vira `video_url`.
      source_url: sourceUrl ?? mediaUrl,
      source_id: cleanText(pick(ad, 'sourceId'), MAX_ID),
      source_type: cleanSourceType(pick(ad, 'sourceType')),
      headline: cleanText(pick(ad, 'title'), MAX_TEXT),
      body: cleanText(pick(ad, 'body'), MAX_TEXT),
      media_type: mediaType,
      image_url: originalImageUrl,
      thumbnail_url: cleanUrl(pick(ad, 'thumbnailUrl')),
      ctwa_clid: cleanText(pick(ad, 'ctwaClid'), MAX_ID),
    });
    if (referral) return referral;
  }
  return null;
}

/**
 * True quando o insert falhou porque a coluna `messages.referral` ainda
 * não existe (código rodando antes da migration 064). Nesse caso o
 * webhook grava a mensagem sem o anúncio em vez de perdê-la.
 */
export function isMissingReferralColumnError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message : '';
  return (
    (code === 'PGRST204' || code === '42703') && /referral/i.test(message)
  );
}
