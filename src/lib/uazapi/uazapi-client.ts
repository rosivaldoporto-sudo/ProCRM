/**
 * Uazapi API client — communicates with a Uazapi server to manage
 * WhatsApp Web instances and send/receive messages.
 *
 * Authentication: Uazapi uses a `token` header (NOT Authorization Bearer).
 * All endpoints are relative to the configured server URL.
 *
 * Reference: https://docs.uazapi.com
 */

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorResponse {
  error?: string
  message?: string
  response?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    message = data.error || data.message || data.response || fallback
  } catch {
    // response body wasn't JSON
  }
  throw new Error(message)
}

function buildHeaders(apiToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    token: apiToken,
  }
}

// ============================================================
// Instance management
// ============================================================

export interface InstanceConnectResult {
  qrCode: string
  status: 'connected' | 'qrcode' | 'disconnected'
}

/**
 * Connect a Uazapi instance. Returns a QR code in base64 that must
 * be scanned with WhatsApp to establish the session.
 * POST /instance/connect
 * Auth: token header
 * Response: { "qrcode": "data:image/png;base64,...", "pairingCode": "..." }
 *   or:     { "instance": { "qrcode": "...", "state": "..." } }
 */
export async function instanceConnect(args: {
  serverUrl: string
  apiToken: string
}): Promise<InstanceConnectResult> {
  const { serverUrl, apiToken } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/connect`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Uazapi connect failed: ${response.status}`)
  }
  const data = await response.json()
  const inst = data.instance || data
  const qrCode = inst.qrcode || inst.qr_code || inst.qrCode || ''
  const rawStatus = inst.state || inst.status || ''
  return {
    qrCode,
    status: rawStatus === 'connected' ? 'connected' : qrCode ? 'qrcode' : 'disconnected',
  }
}

/**
 * Disconnect/logout a Uazapi instance.
 * POST /instance/disconnect
 * Auth: token header
 * Response: { "status": "disconnected" } or { "error": "..." }
 */
export async function instanceDisconnect(args: {
  serverUrl: string
  apiToken: string
}): Promise<void> {
  const { serverUrl, apiToken } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/disconnect`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Uazapi disconnect failed: ${response.status}`)
  }
}

export interface InstanceStatusResult {
  status: 'connected' | 'disconnected' | 'qrcode'
  qrCode?: string
}

/**
 * Get the current connection status of a Uazapi instance.
 * GET /instance/status
 * Auth: token header
 * Response: { "instance": { "state": "connected", "instanceName": "..." } }
 */
export async function instanceStatus(args: {
  serverUrl: string
  apiToken: string
}): Promise<InstanceStatusResult> {
  const { serverUrl, apiToken } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/status`
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Uazapi status failed: ${response.status}`)
  }
  const data = await response.json()
  const inst = data.instance || data
  return {
    status: inst.state || inst.status || 'disconnected',
    qrCode: inst.qrcode || inst.qr_code || data.qrcode || data.qr_code || undefined,
  }
}

// ============================================================
// Sending messages
// ============================================================

export interface SendTextMessageArgs {
  serverUrl: string
  apiToken: string
  to: string
  text: string
  /**
   * Uazapi message id of the message being quoted (reply). Sent as the
   * `quoted` body field — same shape the server stores on inbound
   * webhook messages.
   */
  quotedMessageId?: string
}

/**
 * Send a text message via Uazapi.
 * POST /send/text
 * Auth: token header
 * Body: { number: "...", text: "...", quoted?: "<messageid>" }
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, text, quotedMessageId } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/text`
  const body: Record<string, unknown> = {
    number: to,
    text,
  }
  if (quotedMessageId) body.quoted = quotedMessageId
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, 'Uazapi send text failed')
  }
  const data = await response.json()
  return { messageId: data.id || data.message_id || data.key?.id || '' }
}

export type MediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaMessageArgs {
  serverUrl: string
  apiToken: string
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
  quotedMessageId?: string
}

/**
 * Send a media message (image, video, document, audio) via Uazapi.
 * POST /send/media
 * Auth: token header
 * Body: { number: "...", type: "...", link: "...", caption?: "...", quoted?: "<messageid>" }
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, kind, link, caption, filename, quotedMessageId } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/media`
  const body: Record<string, unknown> = {
    number: to,
    type: kind === 'document' ? 'file' : kind,
    link,
  }
  if (caption && kind !== 'audio') body.caption = caption
  if (kind === 'document' && filename) body.filename = filename
  if (quotedMessageId) body.quoted = quotedMessageId

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwUazapiError(response, 'Uazapi send media failed')
  }
  const data = await response.json()
  return { messageId: data.id || data.message_id || data.key?.id || '' }
}

export interface MenuRow {
  id: string
  title: string
  description?: string
}

export interface SendMenuArgs {
  serverUrl: string
  apiToken: string
  to: string
  body: string
  title?: string
  footer?: string
  rows: MenuRow[]
  quotedMessageId?: string
}

/**
 * Send a menu (interactive list) message via Uazapi.
 * POST /send/menu
 * Auth: token header
 * Body: { number: "...", title: "...", description: "...", footer: "...", menu: [...] }
 */
// ============================================================
// Fetching existing chats (sync)
// ============================================================

export interface UazapiChat {
  /** Full JID of the chat, e.g. `5511999999999@s.whatsapp.net`. */
  id: string
  /** Alias of `id` — the JID needed by /message/find. */
  chatid?: string
  name?: string
  /** Raw phone as reported by the server (`+55 41 ...` or digits). */
  phone: string
  lastMessage?: string
  lastMessageAt?: string
  unreadCount?: number
  isGroup?: boolean
  /**
   * Profile picture URL of the chat/contact, when the server provides
   * it on /chat/find rows (`image` / `imagePreview` on Uazapi v2).
   */
  image?: string
}

/**
 * Fetch recent individual chats from the Uazapi server.
 * Uazapi v2: POST /chat/find (the real chat-list endpoint). Falls back
 * to legacy GET patterns for older implementations.
 */
export async function fetchChats(args: {
  serverUrl: string
  apiToken: string
  limit?: number
  offset?: number
}): Promise<UazapiChat[]> {
  const { serverUrl, apiToken, limit = 50, offset = 0 } = args
  const base = serverUrl.replace(/\/+$/, '')

  // Uazapi v2: POST /chat/find — body-sorted, individual chats only.
  try {
    const response = await fetch(`${base}/chat/find`, {
      method: 'POST',
      headers: buildHeaders(apiToken),
      body: JSON.stringify({
        limit,
        offset,
        sort: '-wa_lastMsgTimestamp',
        wa_isGroup: false,
        operator: 'AND',
      }),
      signal: AbortSignal.timeout(15000),
    })
    if (response.ok) {
      const data = await response.json()
      const chats = extractChatsFromResponse(data)
      if (chats.length > 0) return chats
    }
  } catch {
    // fall through to legacy patterns
  }

  // Legacy: try common GET chat-list endpoint patterns
  const patterns = ['/chats', '/chat/find', '/conversations']

  for (const path of patterns) {
    try {
      const url = `${base}${path}?limit=${limit}`
      const response = await fetch(url, {
        method: 'GET',
        headers: buildHeaders(apiToken),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) continue

      const data = await response.json()
      const chats = extractChatsFromResponse(data)
      if (chats.length > 0) return chats
    } catch {
      continue
    }
  }

  return []
}

export interface UazapiStoredMessage {
  messageid?: string
  fromMe?: boolean
  isGroup?: boolean
  messageType?: string
  mediaType?: string
  text?: string
  content?: unknown
  messageTimestamp?: number | string
  status?: string
  fileURL?: string
  wasSentByApi?: boolean
  senderName?: string
  /**
   * Uazapi message id of the message this one replies to (quoted).
   * String on Uazapi v2; some servers expose the Baileys contextInfo
   * inside `content` instead.
   */
  quoted?: string
}

/**
 * Fetch stored messages of a chat (message history).
 * Uazapi v2: POST /message/find — response `{ messages: [...], hasMore, nextOffset }`.
 *
 * Unlike the old behaviour (which turned every failure into an empty
 * array), errors are reported back so callers can distinguish "no more
 * messages" from "fetch failed" instead of silently losing history.
 */
export async function fetchMessages(args: {
  serverUrl: string
  apiToken: string
  chatid: string
  limit?: number
  offset?: number
}): Promise<{ messages: UazapiStoredMessage[]; error?: string }> {
  const { serverUrl, apiToken, chatid, limit = 100, offset = 0 } = args
  const base = serverUrl.replace(/\/+$/, '')
  try {
    const response = await fetch(`${base}/message/find`, {
      method: 'POST',
      headers: buildHeaders(apiToken),
      body: JSON.stringify({ chatid, limit, offset }),
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) {
      return { messages: [], error: `HTTP ${response.status}` }
    }
    const data = await response.json()
    const messages: unknown[] = Array.isArray(data)
      ? data
      : (data.messages as unknown[]) ?? []
    return {
      messages: messages.filter(
        (m): m is UazapiStoredMessage => !!m && typeof m === 'object',
      ),
    }
  } catch (err) {
    return {
      messages: [],
      error: err instanceof Error ? err.message : 'network error',
    }
  }
}

function extractChatsFromResponse(data: unknown): UazapiChat[] {
  if (!data || typeof data !== 'object') return []

  const obj = data as Record<string, unknown>
  const arr: unknown[] = Array.isArray(data)
    ? data
    : (obj.chats as unknown[]) ?? (obj.data as unknown[]) ?? []

  if (!Array.isArray(arr)) return []

  const items: (UazapiChat | null)[] = arr.map((item: unknown) => {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const key = row.key as Record<string, unknown> | undefined
    const lastMessage = row.last_message as Record<string, unknown> | undefined

    // v2 chats carry wa_chatid (full JID); legacy shapes use id/chatId/jid.
    const chatId = String(
      row.wa_chatid ?? row.chatid ?? row.id ?? key?.remoteJid ?? row.jid ?? '',
    )
    const rawPhone = String(row.phone ?? '')
    const phone = rawPhone
      ? rawPhone.replace(/@.*$/, '')
      : chatId.replace(/@.*$/, '').replace(/:.*$/, '')
    if (!phone) return null

    const name = String(
      row.name ?? row.wa_name ?? row.wa_contactName ?? row.pushName ?? row.contactName ?? '',
    )
    const lastMsg = String(
      row.wa_lastMessageTextVote ??
        row.wa_lastMessageText ??
        row.lastMessageText ??
        lastMessage?.text ??
        lastMessage?.conversation ??
        row.lastMessage ??
        '',
    ).replace(/^undefined$/, '')
    const rawTs =
      row.wa_lastMsgTimestamp ?? row.lastMessageAt ?? row.last_message_at ?? row.timestamp ?? lastMessage?.timestamp ?? ''
    let lastMessageAt: string | undefined
    if (typeof rawTs === 'number' && rawTs > 0) {
      lastMessageAt = new Date(rawTs > 1e12 ? rawTs : rawTs * 1000).toISOString()
    } else if (typeof rawTs === 'string' && !isNaN(Date.parse(rawTs))) {
      lastMessageAt = new Date(rawTs).toISOString()
    }
    const unread = Number(row.wa_unreadCount ?? row.unreadCount ?? row.unread_count ?? row.unread ?? 0)
    const isGroup = row.wa_isGroup === true || /@g\.us$/.test(chatId)
    const image = String(row.image ?? row.imagePreview ?? '')

    return {
      id: chatId,
      chatid: chatId,
      name: name || undefined,
      phone,
      lastMessage: lastMsg || undefined,
      lastMessageAt: lastMessageAt || undefined,
      unreadCount: unread || undefined,
      isGroup: isGroup || undefined,
      image: image || undefined,
    }
  })

  return items.filter((c): c is UazapiChat => c !== null)
}

export async function sendMenu(
  args: SendMenuArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, body, title, footer, rows, quotedMessageId } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/menu`
  const payload: Record<string, unknown> = {
    number: to,
    title: title || '',
    description: body,
    footer: footer || '',
    menu: rows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description || '',
    })),
  }
  if (quotedMessageId) payload.quoted = quotedMessageId
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    await throwUazapiError(response, 'Uazapi send menu failed')
  }
  const data = await response.json()
  return { messageId: data.id || data.message_id || data.key?.id || '' }
}

/**
 * Resolve a download URL for a received media message.
 * POST /message/download with return_link=true
 * Auth: token header
 * Body: { id: "<messageid>", return_link: true }
 * Response: { url: "https://...", mimetype: "..." }
 *
 * `attempts` retries transient failures (server hiccups / short
 * disconnects) before giving up.
 */
export async function downloadMessageUrl(
  args: {
    serverUrl: string
    apiToken: string
    messageId: string
  },
  attempts = 1,
): Promise<{ url?: string; mimetype?: string } | null> {
  const { serverUrl, apiToken, messageId } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/message/download`
  let lastError: unknown = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(apiToken),
        body: JSON.stringify({ id: messageId, return_link: true }),
        signal: AbortSignal.timeout(15000),
      })
      if (response.ok) {
        const data = await response.json()
        return { url: data.url || data.fileURL || undefined, mimetype: data.mimetype || undefined }
      }
      lastError = new Error(`HTTP ${response.status}`)
    } catch (err) {
      lastError = err
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 2000 * attempt))
  }
  console.warn('[uazapi] downloadMessageUrl failed:', { messageId, attempts, error: lastError })
  return null
}

/**
 * Download the raw bytes of a media message from the Uazapi server.
 * First resolves the link via /message/download, then fetches it —
 * retrying with the `token` header (and a Bearer fallback) because most
 * Uazapi file endpoints require auth beyond the plain link.
 */
export async function downloadMessageFile(args: {
  serverUrl: string
  apiToken: string
  messageId: string
}): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const { serverUrl, apiToken, messageId } = args
  const file = await downloadMessageUrl({ serverUrl, apiToken, messageId }, 3)
  if (!file?.url) return null

  const base = serverUrl.replace(/\/+$/, '')
  const isOwnServer = file.url.startsWith(base)
  const headers: Record<string, string> = isOwnServer ? buildHeaders(apiToken) : {}
  const attempts: Record<string, string>[] = [
    headers,
    isOwnServer ? { ...headers, Authorization: `Bearer ${apiToken}` } : {},
    {},
  ]

  for (const attemptHeaders of attempts) {
    try {
      const response = await fetch(file.url, {
        headers: attemptHeaders,
        signal: AbortSignal.timeout(20000),
      })
      if (!response.ok) continue
      const contentType = response.headers.get('content-type') || file.mimetype || 'application/octet-stream'
      const buffer = await response.arrayBuffer()
      return { buffer, contentType }
    } catch {
      // try the next auth strategy
    }
  }

  console.warn('[uazapi] downloadMessageFile failed to fetch bytes:', { messageId })
  return null
}

/**
 * Fetch a WhatsApp contact's profile picture URL.
 * POST /chat/GetNameAndImageURL
 * Auth: token header
 * Body: { number: "<phone>", preview: false, returnMoreNames: true }
 *
 * Returns the profile image URL or null when the contact has no
 * picture / the server rejects the lookup. The response shape differs
 * across Uazapi versions (some nest under `data.<number>`), so the
 * parse is defensive. Never throws.
 */
export async function fetchProfilePhoto(args: {
  serverUrl: string
  apiToken: string
  number: string
}): Promise<string | null> {
  const { serverUrl, apiToken, number } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/chat/GetNameAndImageURL`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiToken),
      body: JSON.stringify({ number, preview: false, returnMoreNames: true }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return null
    const data = await response.json()
    if (data && data.status === false) return null
    const nested = typeof data?.data === 'object' && data.data !== null
    const entry = nested
      ? (data.data[number] ?? data.data)
      : data
    const candidate =
      entry?.photoURL ||
      entry?.photoUrl ||
      entry?.profilePicUrl ||
      entry?.profile_picture_url ||
      entry?.imgUrl ||
      entry?.imageUrl ||
      entry?.picture ||
      entry?.url
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch (err) {
    console.warn('[uazapi] fetchProfilePhoto failed:', { number, error: err })
    return null
  }
}
