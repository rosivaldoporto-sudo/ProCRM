import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { getVapidPublicKey, isPushConfigured } from "@/lib/push/send";

export const runtime = "nodejs";

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_KEY_LENGTH = 512;

interface SubscriptionBody {
  subscription?: {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
}

function parseSubscription(body: SubscriptionBody) {
  const subscription = body?.subscription;
  const endpoint =
    typeof subscription?.endpoint === "string"
      ? subscription.endpoint.trim()
      : "";
  const p256dh =
    typeof subscription?.keys?.p256dh === "string"
      ? subscription.keys.p256dh.trim()
      : "";
  const auth =
    typeof subscription?.keys?.auth === "string"
      ? subscription.keys.auth.trim()
      : "";

  if (
    !endpoint.startsWith("https://") ||
    endpoint.length > MAX_ENDPOINT_LENGTH ||
    !p256dh ||
    p256dh.length > MAX_KEY_LENGTH ||
    !auth ||
    auth.length > MAX_KEY_LENGTH
  ) {
    return null;
  }

  return { endpoint, p256dh, auth };
}

/**
 * GET /api/push/subscribe
 *
 * Returns the VAPID public key the browser needs to create a push
 * subscription. Fetching it at runtime (instead of inlining a
 * NEXT_PUBLIC_* value) means operators can rotate / add keys without
 * rebuilding the app.
 */
export async function GET() {
  try {
    await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
  });
}

/**
 * POST /api/push/subscribe
 *
 * Persists / refreshes the caller's browser subscription. Upserting on
 * `endpoint` makes repeated calls idempotent (every dashboard load can
 * self-heal a subscription without creating duplicates).
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request.json().catch(() => null)) as
    | SubscriptionBody
    | null;
  const subscription = parseSubscription(body ?? {});
  if (!subscription) {
    return NextResponse.json(
      { error: "Invalid push subscription" },
      { status: 400 },
    );
  }

  const userAgent = request.headers.get("user-agent")?.slice(0, 512) ?? null;
  const db = supabaseAdmin();

  const { error } = await db.from("push_subscriptions").upsert(
    {
      user_id: ctx.userId,
      account_id: ctx.accountId,
      endpoint: subscription.endpoint,
      p256dh: subscription.p256dh,
      auth: subscription.auth,
      user_agent: userAgent,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "endpoint" },
  );

  if (error) {
    console.error("[push] failed to save subscription:", error.message);
    return NextResponse.json(
      { error: "Could not save push subscription" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/push/subscribe
 *
 * Removes this device from the caller's subscriptions. Scoped to the
 * authenticated user so one member cannot unsubscribe another.
 */
export async function DELETE(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = (await request.json().catch(() => null)) as {
    endpoint?: unknown;
  } | null;
  const endpoint =
    typeof body?.endpoint === "string" ? body.endpoint.trim() : "";

  if (!endpoint || endpoint.length > MAX_ENDPOINT_LENGTH) {
    return NextResponse.json({ error: "Invalid endpoint" }, { status: 400 });
  }

  const { error } = await supabaseAdmin()
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", endpoint)
    .eq("user_id", ctx.userId);

  if (error) {
    console.error("[push] failed to remove subscription:", error.message);
    return NextResponse.json(
      { error: "Could not remove push subscription" },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true });
}
