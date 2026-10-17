// ============================================================
// Meta media-id resolver for outbound media sends.
//
// Sending a template with an image/video/document header by public
// `link` makes Meta download the file from our storage on EVERY send —
// file size × recipient count of Storage egress for a single campaign.
// Meta's documented alternative is to upload the file once to
// /{phone_number_id}/media and reference the returned id
// (`{ header: { id } }`) on every send.
//
// `resolveMetaMediaId` performs that upload behind a DB-backed cache:
//
//   1. Cache hit for (phone_number_id, source_url) that hasn't expired
//      → reuse the id. No storage traffic at all.
//   2. Miss → download the URL ONCE (SSRF-guarded, size + MIME checked),
//      upload it to Meta, and memoize the id.
//   3. ANY failure → return null; callers fall back to sending by link
//      exactly as before. A resolver failure must never drop a message.
//
// Source URLs are user-supplied (template header_media_url / campaign
// upload), so the download reuses the same SSRF guard as webhook
// delivery (`isDeliverableUrl` inside fetchRemoteBytes).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { fetchRemoteBytes } from '@/lib/uazapi/safe-fetch';
import { uploadMediaToMeta, type MediaKind } from '@/lib/whatsapp/meta-api';

/** Meta media ids expire after 30 days; refresh a few days early. */
const CACHE_TTL_MS = 25 * 24 * 60 * 60 * 1000;

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Per-kind download caps + accepted MIME types, mirroring Meta's
 * media-reference limits (image 5 MB, video/audio 16 MB, document
 * 100 MB). Enforced during the ONE download, so an oversized file
 * simply falls back to the link path.
 */
const MEDIA_KIND_SPECS: Record<
  MediaKind,
  { maxBytes: number; mimeTypes: readonly string[] }
> = {
  image: {
    maxBytes: 5 * 1024 * 1024,
    mimeTypes: ['image/jpeg', 'image/png'],
  },
  video: {
    maxBytes: 16 * 1024 * 1024,
    mimeTypes: ['video/mp4', 'video/3gpp'],
  },
  document: {
    maxBytes: 100 * 1024 * 1024,
    mimeTypes: [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.ms-excel',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  audio: {
    maxBytes: 16 * 1024 * 1024,
    mimeTypes: [
      'audio/aac',
      'audio/amr',
      'audio/mpeg',
      'audio/mp4',
      'audio/ogg',
    ],
  },
};

export interface ResolveMetaMediaIdArgs {
  /** Supabase client used for the cache table (service-role). */
  db: SupabaseClient;
  accountId: string;
  /** The sending phone number — media ids are scoped to it. */
  phoneNumberId: string;
  accessToken: string;
  /** Public https URL of the media (our storage or any CDN). */
  sourceUrl: string;
  kind: MediaKind;
}

/**
 * In-flight uploads, shared by concurrent callers for the same
 * (phone number, URL) pair so parallel broadcast batches never upload
 * the same file twice.
 */
const inflightResolutions = new Map<string, Promise<string | null>>();

/**
 * Resolve a public media URL to a Meta media id, uploading + caching on
 * a miss. Returns null on ANY failure so the caller can fall back to
 * the link-based send.
 */
export async function resolveMetaMediaId(
  args: ResolveMetaMediaIdArgs
): Promise<string | null> {
  const rawUrl = args.sourceUrl?.trim();
  if (!rawUrl) return null;

  let normalizedUrl: string;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return null;
    normalizedUrl = parsed.toString();
  } catch {
    return null;
  }

  const key = `${args.phoneNumberId}\n${normalizedUrl}`;
  const inflight = inflightResolutions.get(key);
  if (inflight) return inflight;

  const task = resolveOnce({ ...args, sourceUrl: normalizedUrl }).finally(
    () => {
      inflightResolutions.delete(key);
    }
  );
  inflightResolutions.set(key, task);
  return task;
}

/** Single attempt — never throws; every failure logs + returns null. */
async function resolveOnce(
  args: ResolveMetaMediaIdArgs
): Promise<string | null> {
  const { db, accountId, phoneNumberId, accessToken, sourceUrl, kind } = args;
  const context = `${phoneNumberId} ${sourceUrl}`;

  // 1. Reuse a cached id while it hasn't expired.
  try {
    const { data, error } = await db
      .from('meta_media_cache')
      .select('media_id, expires_at')
      .eq('phone_number_id', phoneNumberId)
      .eq('source_url', sourceUrl)
      .maybeSingle();
    if (error) {
      // Non-fatal — we just upload again and overwrite the row.
      console.warn('[meta-media] cache lookup failed:', error.message);
    } else if (data && Date.parse(String(data.expires_at)) > Date.now()) {
      return String(data.media_id);
    }
  } catch (err) {
    console.warn('[meta-media] cache lookup threw:', describeError(err));
  }

  // 2. Download the file ONCE. fetchRemoteBytes enforces https, the
  //    SSRF guard, the per-kind byte cap, and the accepted MIME types.
  const spec = MEDIA_KIND_SPECS[kind];
  let downloaded: { buffer: ArrayBuffer; contentType: string } | null;
  try {
    downloaded = await fetchRemoteBytes({
      url: sourceUrl,
      maxBytes: spec.maxBytes,
      allowedContentTypes: spec.mimeTypes,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
  } catch (err) {
    console.warn(
      '[meta-media] download rejected:',
      context,
      describeError(err)
    );
    return null;
  }
  if (!downloaded) {
    console.warn(
      '[meta-media] download failed (size, type, or network):',
      context
    );
    return null;
  }

  // 3. Upload to Meta and return the id.
  let mediaId: string;
  try {
    const uploaded = await uploadMediaToMeta({
      phoneNumberId,
      accessToken,
      mimeType: downloaded.contentType,
      fileName: fileNameFromUrl(sourceUrl),
      bytes: new Uint8Array(downloaded.buffer),
    });
    mediaId = uploaded.mediaId;
  } catch (err) {
    console.warn('[meta-media] upload failed:', context, describeError(err));
    return null;
  }

  // 4. Memoize — best-effort: a failed write only costs one extra
  //    upload on the next campaign.
  const now = Date.now();
  try {
    const { error } = await db.from('meta_media_cache').upsert(
      {
        account_id: accountId,
        phone_number_id: phoneNumberId,
        source_url: sourceUrl,
        media_id: mediaId,
        mime_type: downloaded.contentType,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + CACHE_TTL_MS).toISOString(),
      },
      { onConflict: 'phone_number_id,source_url' }
    );
    if (error) {
      console.warn('[meta-media] cache write failed:', error.message);
    }
  } catch (err) {
    console.warn('[meta-media] cache write threw:', describeError(err));
  }

  return mediaId;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Best-effort file name for Meta's upload record. */
function fileNameFromUrl(rawUrl: string): string {
  try {
    const name = decodeURIComponent(
      new URL(rawUrl).pathname.split('/').pop() ?? ''
    );
    if (name && name.length <= 200) return name;
  } catch {
    // fall through to a generic name
  }
  return 'media';
}
