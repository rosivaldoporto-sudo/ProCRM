/**
 * Texto de prévia de uma mensagem para alertas (push e avisos na tela).
 *
 * Fica separado de `send.ts` porque aquele módulo importa `web-push`
 * (só Node); a prévia também é usada no navegador.
 */

function previewText(text: string | null): string {
  const trimmed = (text ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 177)}…`;
}

/**
 * Prévia legível para mensagens de mídia. O mesmo texto vai para todos
 * os membros da conta, por isso não depende do idioma de quem recebe.
 */
export function messagePreview(
  contentType: string | null | undefined,
  contentText: string | null | undefined
): string {
  const text = previewText(contentText ?? null);
  if (text) return text;

  switch (contentType) {
    case 'image':
      return '📷 Imagem';
    case 'audio':
      return '🎤 Áudio';
    case 'video':
      return '🎥 Vídeo';
    case 'document':
      return '📄 Documento';
    case 'location':
      return '📍 Localização';
    case 'interactive':
      return '💬 Resposta';
    default:
      return '💬 Nova mensagem';
  }
}
