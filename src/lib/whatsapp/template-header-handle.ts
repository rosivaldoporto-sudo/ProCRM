import { readBodyWithLimit } from '@/lib/uazapi/safe-fetch'
import { uploadResumableMedia } from '@/lib/whatsapp/meta-api'
import type { TemplatePayload } from '@/lib/whatsapp/template-validators'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

/**
 * Meta requires an `example.header_handle` (from the Resumable Upload
 * API) to create/edit a template with an IMAGE header — a plain public
 * URL is not accepted at creation time. This helper turns the template's
 * `header_media_url` (whether the user uploaded a file or pasted a link)
 * into a handle and writes it onto the payload, so both the upload path
 * and the legacy URL path actually succeed.
 *
 * No-op unless the header is an image that has a URL but no handle yet.
 * Image-only for now (the #230 scope); video/document handles can follow
 * the same shape.
 */

// Meta's image-header sample limits.
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png']
const HEADER_FETCH_TIMEOUT_MS = 15_000

export async function ensureImageHeaderHandle(
  payload: TemplatePayload,
  accessToken: string,
): Promise<void> {
  if (payload.header_type !== 'image') return
  if (payload.header_handle) return // already have one
  if (!payload.header_media_url) return // validator already requires url-or-handle

  const appId = process.env.META_APP_ID
  if (!appId) {
    throw new Error(
      'Modelos com imagem no cabeçalho precisam de META_APP_ID definida no ambiente. Defina a variável ou remova a imagem do cabeçalho.',
    )
  }

  // The URL is typed by the user and our server makes the request, so
  // guard against SSRF: public destinations only, no redirects (a 3xx could
  // bounce to an internal address after this check), bounded in time and size.
  if (!(await isDeliverableUrl(payload.header_media_url))) {
    throw new Error('Não foi possível baixar a imagem do cabeçalho. Confirme que a URL é pública.')
  }

  // Fetch the sample image bytes (works for our uploaded chat-media URL
  // and for a manually-pasted public link).
  let res: Response
  try {
    res = await fetch(payload.header_media_url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(HEADER_FETCH_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Não foi possível baixar a imagem do cabeçalho. Confirme que a URL é pública.')
  }
  if (!res.ok) {
    throw new Error(`A URL da imagem do cabeçalho retornou ${res.status}. Ela precisa ser pública.`)
  }

  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
  if (contentType && !ALLOWED_IMAGE_TYPES.includes(contentType)) {
    throw new Error(`A imagem do cabeçalho deve ser JPEG ou PNG (recebido: ${contentType}).`)
  }

  const body = await readBodyWithLimit(res, IMAGE_MAX_BYTES)
  if (!body) {
    throw new Error("A imagem do cabeçalho passa do limite de 5 MB da Meta.")
  }
  const bytes = new Uint8Array(body)
  if (bytes.byteLength === 0) {
    throw new Error('A imagem do cabeçalho está vazia.')
  }

  const mimeType = ALLOWED_IMAGE_TYPES.includes(contentType) ? contentType : 'image/jpeg'
  const fileName = mimeType === 'image/png' ? 'header.png' : 'header.jpg'

  const { handle } = await uploadResumableMedia({
    appId,
    accessToken,
    fileName,
    mimeType,
    bytes,
  })
  payload.header_handle = handle
}
