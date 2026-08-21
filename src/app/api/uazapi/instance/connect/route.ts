import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  instanceConnect,
  setInstanceWebhook,
  normalizeQrCode,
} from '@/lib/uazapi/uazapi-client';
import {
  uazapiEnvConfig,
  resolveUazapiInstance,
} from '@/lib/uazapi/runtime-config';
import { buildUazapiWebhookUrl } from '@/lib/uazapi/webhook-auth';

/**
 * POST /api/uazapi/instance/connect
 *
 * Bootstraps + connects the Uazapi instance and returns the QR code
 * the user must scan with WhatsApp. Credentials come from the
 * environment (UAZAPI_SERVER_URL / UAZAPI_ADMIN_TOKEN /
 * UAZAPI_INSTANCE_TOKEN); the instance token is created on the server
 * via /instance/init when needed and cached per account:
 *
 *   1. resolveUazapiInstance() — env token → cached token → /instance/init.
 *   2. POST /instance/connect (token header) → QR code (base64) or,
 *      when UAZAPI_PAIRING_PHONE is set, a 6-digit pairing code.
 *   3. Best-effort: configure the per-account webhook via
 *      /webhook/set so inbound messages start flowing.
 *
 * The QR code is normalized to a `data:image/png;base64,` URL (UAZAPI
 * returns raw base64) and persisted so a reload still shows it while
 * it's valid.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin');

    const env = uazapiEnvConfig();
    const { serverUrl, instanceToken } = await resolveUazapiInstance(
      supabaseAdmin(),
      accountId,
      userId
    );

    let result = await instanceConnect({
      serverUrl,
      apiToken: instanceToken,
      phone: env.pairingPhone || undefined,
    });

    // Some servers fail the first connect right after init; retry once.
    if (
      result.status === 'disconnected' &&
      !result.qrCode &&
      !result.pairingCode
    ) {
      result = await instanceConnect({
        serverUrl,
        apiToken: instanceToken,
        phone: env.pairingPhone || undefined,
      });
    }

    const qrCode = result.qrCode ? normalizeQrCode(result.qrCode) : null;

    // Persist QR + status so a page reload still shows the pending QR.
    // Written via the admin client: RLS on uazapi_config blocks
    // INSERTs for user-scoped clients (only UPDATE/USING was covered
    // by the original policy), and this state cache must survive.
    const { error: upsertError } = await supabaseAdmin()
      .from('uazapi_config')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          instance_name: env.instanceName,
          server_url: serverUrl,
          status:
            result.status === 'connected'
              ? 'connected'
              : result.status === 'connecting' || result.qrCode
                ? 'qrcode'
                : 'disconnected',
          qr_code: qrCode,
          connected_at:
            result.status === 'connected' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' }
      );
    if (upsertError) {
      console.error(
        '[uazapi-connect] state upsert failed (send will report not-connected):',
        upsertError.message
      );
    }

    // Best-effort webhook registration — never fails the connect.
    if (result.status === 'connected' || result.qrCode || result.pairingCode) {
      try {
        const origin =
          process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
          new URL(request.url).origin;
        const webhookUrl = buildUazapiWebhookUrl(
          origin,
          accountId,
          env.webhookSecret
        );
        await setInstanceWebhook({
          serverUrl,
          apiToken: instanceToken,
          url: webhookUrl,
          events: ['messages', 'messages_update', 'connection'],
          excludeMessages: ['wasSentByApi'],
        });
      } catch (err) {
        console.warn(
          '[uazapi-connect] webhook setup skipped (configure manually if needed):',
          err instanceof Error ? err.message : err
        );
      }
    }

    return NextResponse.json({
      success: true,
      qr_code: qrCode,
      pairing_code: result.pairingCode || null,
      status: result.status,
      profile_name: result.profileName || null,
      instance_name: env.instanceName,
    });
  } catch (error) {
    console.error('[uazapi-connect] Error:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json(
      { error: 'Failed to connect the WhatsApp instance.' },
      { status: 502 }
    );
  }
}
