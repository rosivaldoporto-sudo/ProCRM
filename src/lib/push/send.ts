import webpush from "web-push";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side Web Push delivery.
 *
 * VAPID keys are read from the environment at call time (never at
 * module load) so a deployment without keys still boots normally — the
 * settings UI simply reports push as unconfigured instead of crashing
 * every route that imports a webhook handler.
 *
 * Generate a pair once and keep it stable:
 *   npm run vapid
 * Rotating the keys invalidates every existing subscription (browsers
 * bind the subscription to the applicationServerKey).
 */

export interface PushPayload {
  /** Notification title — the contact's name for inbox alerts. */
  title: string;
  /** One-line preview. Truncated by the caller. */
  body: string;
  /** Deep link opened when the notification is tapped. */
  url?: string;
  /** Collapses repeated alerts for the same conversation. */
  tag?: string;
}

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

let vapidReady = false;

export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null;
}

export function isPushConfigured(): boolean {
  return Boolean(
    getVapidPublicKey() && process.env.VAPID_PRIVATE_KEY?.trim(),
  );
}

function ensureVapid(): boolean {
  if (vapidReady) return true;
  if (!isPushConfigured()) return false;

  const subject =
    process.env.VAPID_SUBJECT?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    "mailto:noreply@localhost";

  try {
    webpush.setVapidDetails(
      subject,
      getVapidPublicKey()!,
      process.env.VAPID_PRIVATE_KEY!.trim(),
    );
    vapidReady = true;
    return true;
  } catch (err) {
    console.error("[push] invalid VAPID configuration:", err);
    return false;
  }
}

function previewText(text: string | null): string {
  const trimmed = (text ?? "").trim().replace(/\s+/g, " ");
  if (trimmed.length <= 180) return trimmed;
  return `${trimmed.slice(0, 177)}…`;
}

/**
 * Human-friendly preview for media messages. Language-neutral on
 * purpose — the notification is shown to every member of the account
 * regardless of their app locale.
 */
export function messagePreview(
  contentType: string | null | undefined,
  contentText: string | null | undefined,
): string {
  const text = previewText(contentText ?? null);
  if (text) return text;

  switch (contentType) {
    case "image":
      return "📷 Imagem";
    case "audio":
      return "🎤 Áudio";
    case "video":
      return "🎥 Vídeo";
    case "document":
      return "📄 Documento";
    case "location":
      return "📍 Localização";
    case "interactive":
      return "💬 Resposta";
    default:
      return "💬 Nova mensagem";
  }
}

async function deliver(
  db: SupabaseClient,
  rows: PushSubscriptionRow[],
  payload: PushPayload,
): Promise<void> {
  if (rows.length === 0) return;

  const body = JSON.stringify(payload);
  const staleIds: string[] = [];

  await Promise.allSettled(
    rows.map(async (row) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { p256dh: row.p256dh, auth: row.auth },
          },
          body,
          { TTL: 60 * 60 * 12, urgency: "high" },
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        // 404 / 410 mean the browser subscription no longer exists
        // (app uninstalled, permission revoked, push service rotated
        // it). Prune it so we stop paying for dead endpoints.
        if (statusCode === 404 || statusCode === 410) {
          staleIds.push(row.id);
          return;
        }
        console.error("[push] delivery failed:", {
          statusCode,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  if (staleIds.length > 0) {
    const { error } = await db
      .from("push_subscriptions")
      .delete()
      .in("id", staleIds);
    if (error) {
      console.warn("[push] failed to prune stale subscriptions:", error.message);
    }
  }
}

/**
 * Send an arbitrary payload to every device registered by one user.
 * Used by the "send test notification" button.
 */
export async function sendPushToUser(
  db: SupabaseClient,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  if (!ensureVapid()) return 0;

  const { data, error } = await db
    .from("push_subscriptions")
    .select("id, user_id, endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) {
    console.error("[push] subscription lookup failed:", error.message);
    return 0;
  }

  const rows = (data ?? []) as PushSubscriptionRow[];
  await deliver(db, rows, payload);
  return rows.length;
}

/**
 * Fan out an alert for a newly received inbox message.
 *
 * Routing rule: when the conversation has an assigned agent, only that
 * agent's devices are notified. Unassigned conversations go to every
 * member of the account who enabled notifications — everyone shares the
 * inbox and someone needs to pick the thread up.
 *
 * Never throws: a push failure must never break webhook processing.
 */
export async function notifyInboundMessage(args: {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
  assignedAgentId?: string | null;
  contactName?: string | null;
  preview: string;
}): Promise<void> {
  try {
    if (!ensureVapid()) return;

    const { data, error } = await args.db
      .from("push_subscriptions")
      .select("id, user_id, endpoint, p256dh, auth")
      .eq("account_id", args.accountId);

    if (error) {
      console.error("[push] subscription lookup failed:", error.message);
      return;
    }

    let rows = (data ?? []) as PushSubscriptionRow[];
    if (args.assignedAgentId) {
      rows = rows.filter((row) => row.user_id === args.assignedAgentId);
    }
    if (rows.length === 0) return;

    await deliver(args.db, rows, {
      title: args.contactName?.trim() || "Nova mensagem",
      body: args.preview,
      url: `/inbox?c=${args.conversationId}`,
      tag: `conversation-${args.conversationId}`,
    });
  } catch (err) {
    console.error("[push] notifyInboundMessage failed:", err);
  }
}
