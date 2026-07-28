/**
 * Uazapi API client — communicates with a Uazapi server to manage
 * WhatsApp Web instances and send/receive messages.
 *
 * Every function takes named parameters for clarity and consistency.
 */

export interface UazapiSendResult {
  messageId: string
}

interface UazapiErrorResponse {
  error?: string
  message?: string
}

async function throwUazapiError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as UazapiErrorResponse
    message = data.error || data.message || fallback
  } catch {
    // response body wasn't JSON
  }
  throw new Error(message)
}

function buildHeaders(apiToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiToken}`,
  }
}

// ============================================================
// Instance management
// ============================================================

export interface InstanceConnectResult {
  qrCode: string
  status: 'connected' | 'qrcode'
}

/**
 * Connect/start a Uazapi instance. Returns a QR code that must
 * be scanned with WhatsApp to establish the session.
 */
export async function instanceConnect(args: {
  serverUrl: string
  apiToken: string
  instanceName: string
}): Promise<InstanceConnectResult> {
  const { serverUrl, apiToken, instanceName } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/connect`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({ instance: instanceName }),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Uazapi connect failed: ${response.status}`)
  }
  const data = await response.json()
  return {
    qrCode: data.qrcode || data.qr_code || '',
    status: data.status === 'connected' ? 'connected' : 'qrcode',
  }
}

/**
 * Disconnect/logout a Uazapi instance.
 */
export async function instanceDisconnect(args: {
  serverUrl: string
  apiToken: string
  instanceName: string
}): Promise<void> {
  const { serverUrl, apiToken, instanceName } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/disconnect`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({ instance: instanceName }),
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
 */
export async function instanceStatus(args: {
  serverUrl: string
  apiToken: string
  instanceName: string
}): Promise<InstanceStatusResult> {
  const { serverUrl, apiToken, instanceName } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/instance/status?instance=${encodeURIComponent(instanceName)}`
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiToken),
  })
  if (!response.ok) {
    await throwUazapiError(response, `Uazapi status failed: ${response.status}`)
  }
  const data = await response.json()
  return {
    status: data.status || 'disconnected',
    qrCode: data.qrcode || data.qr_code || undefined,
  }
}

// ============================================================
// Sending messages
// ============================================================

export interface SendTextMessageArgs {
  serverUrl: string
  apiToken: string
  instanceName: string
  to: string
  text: string
}

/**
 * Send a text message via Uazapi.
 */
export async function sendTextMessage(
  args: SendTextMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, instanceName, to, text } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/text`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({
      instance: instanceName,
      to,
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
  instanceName: string
  to: string
  kind: MediaKind
  link: string
  caption?: string
  filename?: string
}

/**
 * Send a media message (image, video, document, audio) via Uazapi.
 */
export async function sendMediaMessage(
  args: SendMediaMessageArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, instanceName, to, kind, link, caption, filename } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/media`
  const body: Record<string, unknown> = {
    instance: instanceName,
    to,
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
  instanceName: string
  to: string
  body: string
  title?: string
  footer?: string
  rows: MenuRow[]
}

/**
 * Send a menu (interactive list) message via Uazapi.
 */
export async function sendMenu(
  args: SendMenuArgs
): Promise<UazapiSendResult> {
  const { serverUrl, apiToken, instanceName, to, body, title, footer, rows } = args
  const url = `${serverUrl.replace(/\/+$/, '')}/send/menu`
  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(apiToken),
    body: JSON.stringify({
      instance: instanceName,
      to,
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
