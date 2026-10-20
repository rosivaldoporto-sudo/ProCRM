import { NextResponse } from "next/server";

import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { isPushConfigured, sendPushToUser } from "@/lib/push/send";

export const runtime = "nodejs";

/**
 * POST /api/push/test
 *
 * Sends a notification to the caller's own registered devices so they
 * can verify the whole chain (permission → service worker → OS) without
 * waiting for a real WhatsApp message.
 */
export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await getCurrentAccount();
  } catch (err) {
    return toErrorResponse(err);
  }

  if (!isPushConfigured()) {
    return NextResponse.json(
      { error: "Push notifications are not configured on the server" },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    title?: unknown;
    body?: unknown;
  } | null;

  const sent = await sendPushToUser(supabaseAdmin(), ctx.userId, {
    title:
      typeof body?.title === "string" && body.title.trim()
        ? body.title.trim()
        : "ProCRM",
    body:
      typeof body?.body === "string" && body.body.trim()
        ? body.body.trim()
        : "Notificações ativadas neste dispositivo.",
    url: "/inbox",
    tag: "push-test",
  });

  return NextResponse.json({ sent });
}
