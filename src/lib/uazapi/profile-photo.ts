import { createClient } from '@supabase/supabase-js'
import { fetchProfilePhoto } from '@/lib/uazapi/uazapi-client'

/**
 * Best-effort enrichment of WhatsApp contacts with their profile
 * picture, fetched from the Uazapi server (POST /chat/GetNameAndImageURL
 * — the official Meta Cloud API exposes no customer avatar endpoint, so
 * this only applies to the Uazapi channel).
 *
 * The picture is downloaded and stored in the public `avatars` Storage
 * bucket so the inbox list / contact sidebar can render it via plain
 * <img> tags (same bucket as profile avatars — migration 008). Uploads
 * run with a service-role client, which bypasses the bucket's
 * user-scoped RLS write policy; the `contacts/...` path would otherwise
 * be rejected for an authenticated user.
 *
 * Skips contacts that already have an avatar (manual uploads / prior
 * enrichment win) and never throws — a failure just leaves the contact
 * without a photo and is retried on the next inbound message / sync.
 */
export async function refreshContactProfilePhoto(args: {
  accountId: string
  contactId: string
  phone: string
  serverUrl: string
  apiToken: string
  /**
   * Profile picture URL already available (e.g. `chat.image` in the
   * v2 webhook payload) — skips the GetNameAndImageURL API call.
   */
  photoUrl?: string | null
}): Promise<void> {
  const { accountId, contactId, phone, serverUrl, apiToken, photoUrl } = args
  try {
    const resolvedPhotoUrl =
      photoUrl || (await fetchProfilePhoto({ serverUrl, apiToken, number: phone }))
    if (!resolvedPhotoUrl) return

    const buffer = await downloadPhotoBytes(resolvedPhotoUrl, serverUrl, apiToken)
    if (!buffer) return

    const db = adminClient()
    const path = `contacts/${accountId}/${contactId}.jpg`
    const { error: uploadErr } = await db.storage.from('avatars').upload(
      path,
      new Blob([buffer], { type: 'image/jpeg' }),
      {
        cacheControl: '31536000',
        upsert: true,
        contentType: 'image/jpeg',
      },
    )
    if (uploadErr) {
      console.error('[uazapi] avatar upload failed:', uploadErr.message)
      return
    }

    const {
      data: { publicUrl },
    } = db.storage.from('avatars').getPublicUrl(path)
    await db
      .from('contacts')
      .update({ avatar_url: publicUrl, updated_at: new Date().toISOString() })
      .eq('id', contactId)
  } catch (err) {
    console.error('[uazapi] refreshContactProfilePhoto failed:', err)
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function adminClient() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

/**
 * Download the profile picture bytes. Uazapi photo URLs are usually
 * direct WhatsApp CDN links (no auth), but when the Uazapi server
 * proxies the file it requires the `token` header — so try both.
 * Some servers hand out `data:` URIs (base64) — decode those directly.
 */
async function downloadPhotoBytes(
  photoUrl: string,
  serverUrl: string,
  apiToken: string,
): Promise<ArrayBuffer | null> {
  if (photoUrl.startsWith('data:')) {
    try {
      const comma = photoUrl.indexOf(',')
      const base64 = comma >= 0 ? photoUrl.slice(comma + 1) : photoUrl
      const buffer = Buffer.from(base64, 'base64')
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
    } catch (err) {
      console.warn('[uazapi] profile photo data-URI decode failed:', err)
      return null
    }
  }

  const base = serverUrl.replace(/\/+$/, '')
  const isOwnServer = photoUrl.startsWith(base)
  const attempts: Record<string, string>[] = [
    isOwnServer ? { token: apiToken } : {},
    {},
  ]
  for (const headers of attempts) {
    try {
      const response = await fetch(photoUrl, {
        headers,
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) continue
      return await response.arrayBuffer()
    } catch {
      // try the next auth strategy
    }
  }
  console.warn('[uazapi] profile photo download failed:', { photoUrl })
  return null
}
