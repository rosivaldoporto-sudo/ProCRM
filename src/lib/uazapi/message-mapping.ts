/**
 * Shared mapping helpers for Uazapi inbound/history payloads, used by
 * both the webhook route and the conversation-history sync route so the
 * two paths always agree on how a Uazapi message becomes a
 * `messages` row.
 */

/**
 * Map a Uazapi messageType/mediaType onto our messages.content_type
 * values. `conversation` is Uazapi's name for plain text; Baileys proto
 * names (`extendedTextMessage`, `imageMessage`, ...) are handled too.
 * Falls back to `text` when the message carries a text body but the
 * type is unknown to us — better to persist it than to drop it.
 * Type matching is case-insensitive (Uazapi sends `Conversation`,
 * `ExtendedTextMessage`, ...).
 */
export function mapUazapiContentType(
  messageType: string,
  mediaType: string,
): string | null {
  const type = (messageType || '').toLowerCase()
  const media = (mediaType || '').toLowerCase()

  // Media — unambiguous, match both `imageMessage`-style and plain names.
  if (type.includes('image') || type.includes('sticker') || media === 'image' || media === 'sticker') return 'image'
  if (type.includes('video') || media === 'video') return 'video'
  if (type.includes('audio') || type.includes('ptt') || media === 'audio' || media === 'ptt') return 'audio'
  if (type.includes('document') || type.includes('file') || type.includes('pdf') || media === 'document') return 'document'
  if (type.includes('location')) return 'location'

  // Text-like messages. `ephemeralMessage` wraps disappearing messages
  // (the real proto is nested inside); interactive/list/button replies
  // carry their answer in the text body.
  if (
    type === 'conversation' ||
    type === 'text' ||
    type.includes('textmessage') ||
    type === 'ephemeralmessage' ||
    type.includes('response') ||
    type === 'interactive'
  ) {
    return 'text'
  }

  // Unknown type — let the caller decide whether the body has text.
  return null
}

/**
 * Convert a Uazapi message timestamp to an ISO string. Uazapi sends
 * epoch milliseconds on most endpoints (v2 `/message/find`) and seconds
 * on some legacy webhook shapes — both are handled. Returns undefined
 * when the value isn't a usable timestamp.
 */
export function uazapiTimestampToIso(
  ts: number | string | undefined,
): string | undefined {
  if (typeof ts === 'number' && ts > 0) {
    return new Date(ts > 1e12 ? ts : ts * 1000).toISOString()
  }
  if (typeof ts === 'string' && !isNaN(Date.parse(ts))) {
    return new Date(ts).toISOString()
  }
  return undefined
}

/**
 * Map a Uazapi message lifecycle status onto our messages.status values.
 * Empty/unknown statuses default to `delivered` (the row exists — that's
 * what matters for history import).
 */
export function mapUazapiStatus(status: string): string {
  const s = (status || '').toLowerCase()
  if (s === 'queued' || s === 'pending') return 'sending'
  if (s === 'sent') return 'sent'
  if (s === 'delivered') return 'delivered'
  if (s === 'read') return 'read'
  if (s === 'failed' || s === 'canceled' || s === 'cancelled') return 'failed'
  return 'delivered'
}
