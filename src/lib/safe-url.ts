/**
 * URLs seguras para `href`/`src`/`window.open` com dados não-confiáveis
 * (ex.: `media_url` vinda de webhook/sync externo e persistida no banco).
 *
 * Permite: paths same-origin (`/api/…`, nunca `//evil`), `https:`, `http:`
 * e `blob:` (object URLs locais). Bloqueia por allow-list de protocolo —
 * blocklist (`javascript:` etc.) é burlável com caracteres de controle que
 * o parser de URL normaliza (`java\tscript:` vira `javascript:` no parse,
 * mas o `.protocol` resultante denuncia).
 */
export function isSafeLinkUrl(url: string | null | undefined): boolean {
  if (typeof url !== 'string') return false;
  const s = url.trim();
  if (!s) return false;
  if (s.startsWith('/')) return !s.startsWith('//');
  let protocol: string;
  try {
    protocol = new URL(s).protocol;
  } catch {
    return false;
  }
  return protocol === 'https:' || protocol === 'http:' || protocol === 'blob:';
}
