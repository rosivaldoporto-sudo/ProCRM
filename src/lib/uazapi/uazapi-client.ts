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
}

/**
 * Send a text message via Uazapi.
 * POST /send/text
 * Auth: token header
 * Body: { number: "...", text: "..." }
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, text } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/text`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({
      number: to,
      text,
    }),
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
}

/**
 * Send a media message (image, video, document, audio) via Uazapi.
 * POST /send/media
 * Auth: token header
 * Body: { number: "...", type: "...", link: "...", caption?: "..." }
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, kind, link, caption, filename } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/media`
  const body: Record<string, unknown> = {
    number: to,
    type: kind === 'document' ? 'file' : kind,
    link,
  }
  if (caption && kind !== 'audio') body.caption = caption
  if (kind === 'document' && filename) body.filename = filename

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
  id: string
  name?: string
  phone: string
  lastMessage?: string
  lastMessageAt?: string
  unreadCount?: number
}

/**
 * Try to fetch recent chats from the Uazapi server.
 * Uazapi implementations vary — we try multiple known endpoint
 * patterns and return whatever we find.
 */
export async function fetchChats(args: {
  serverUrl: string
  apiToken: string
  limit?: number
}): Promise<UazapiChat[]> {
  const { serverUrl, apiToken, limit = 50 } = args
  const base = serverUrl.replace(/\/+$/, '')

  // Try common Uazapi chat-list endpoint patterns
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

function extractChatsFromResponse(data: unknown): UazapiChat[] {
  if (!data || typeof data !== 'object') return []

  const obj = data as Record<string, unknown>
  let arr: unknown[] = Array.isArray(data) ? data : (obj.chats as unknown[]) ?? (obj.data as unknown[]) ?? []

  if (!Array.isArray(arr)) return []

  const items: (UazapiChat | null)[] = arr.map((item: unknown) => {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    const key = row.key as Record<string, unknown> | undefined
    const lastMessage = row.last_message as Record<string, unknown> | undefined
    const chatId = String(row.id ?? row.chatId ?? key?.remoteJid ?? row.jid ?? '')
    const phone = chatId.replace(/@.*$/, '').replace(/:.*$/, '')
    if (!phone) return null

    const name = String(row.name ?? row.pushName ?? row.contactName ?? '')
    const lastMsg = String(row.lastMessageText ?? lastMessage?.text ?? lastMessage?.conversation ?? row.lastMessage ?? '')
    const lastTime = String(row.lastMessageAt ?? row.last_message_at ?? row.timestamp ?? lastMessage?.timestamp ?? '')
    const unread = Number(row.unreadCount ?? row.unread_count ?? row.unread ?? 0)

    return {
      id: chatId,
      name: name || undefined,
      phone,
      lastMessage: lastMsg || undefined,
      lastMessageAt: lastTime || undefined,
      unreadCount: unread || undefined,
    }
  })

  return items.filter((c): c is UazapiChat => c !== null)
}

export async function sendMenu(
  args: SendMenuArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, to, body, title, footer, rows } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/menu`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({
      number: to,
      title: title || '',
      description: body,
      footer: footer || '',
      menu: rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description || '',
      })),
    }),
  })
  if (!response.ok) {
    await throwUazapiError(response, 'Uazapi send menu failed')
  }
  const data = await response.json()
  return { messageId: data.id || data.message_id || data.key?.id || '' }
}
