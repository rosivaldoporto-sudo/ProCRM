import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { canEditSettings } from '@/lib/auth/roles';
import { instanceStatus } from '@/lib/uazapi/uazapi-client';
import {
  uazapiEnvConfigured,
  uazapiEnvConfig,
  getCachedInstanceToken,
} from '@/lib/uazapi/runtime-config';

export async function GET() {
  try {
    const { accountId, userId, role } = await getCurrentAccount();
    const mayPairDevice = canEditSettings(role);

    if (!uazapiEnvConfigured()) {
      return NextResponse.json({
        connected: false,
        configured: false,
        status: 'disconnected',
        reason: 'env_missing',
        message: 'UAZAPI_SERVER_URL is not set in the environment.',
      });
    }

    const instanceToken = await getCachedInstanceToken(
      supabaseAdmin(),
      accountId
    );
    if (!instanceToken) {
      return NextResponse.json({
        connected: false,
        configured: true,
        status: 'disconnected',
        reason: 'no_instance',
        message: 'Instance not created yet — click Conectar WhatsApp.',
      });
    }

    const env = uazapiEnvConfig();
    const result = await instanceStatus({
      serverUrl: env.serverUrl,
      apiToken: instanceToken,
    });

    // Sync status to DB. The table's CHECK constraint only allows
    // disconnected/connected/qrcode — collapse `connecting` into
    // `qrcode` (a connect attempt is in flight).
    const dbStatus =
      result.status === 'connected'
        ? 'connected'
        : result.status === 'connecting' || result.qrCode
          ? 'qrcode'
          : 'disconnected';

    const { error: upsertError } = await supabaseAdmin()
      .from('uazapi_config')
      .upsert(
        {
          account_id: accountId,
          user_id: userId,
          status: dbStatus,
          qr_code: result.qrCode || null,
          connected_at:
            result.status === 'connected' ? new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'account_id' }
      );
    if (upsertError) {
      console.error(
        '[uazapi-status] state upsert failed (send will report not-connected):',
        upsertError.message
      );
    }

    return NextResponse.json({
      connected: result.status === 'connected',
      configured: true,
      status: result.status,
      // QR/pairing codes grant control of the WhatsApp account. Never
      // expose them to agents/viewers who call this route from DevTools.
      qr_code: mayPairDevice ? result.qrCode || null : null,
      pairing_code: mayPairDevice ? result.pairingCode || null : null,
      profile_name: result.profileName || null,
      instance_name: env.instanceName,
    });
  } catch (error) {
    console.error('Error in Uazapi status:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json(
      {
        connected: false,
        configured: true,
        reason: 'uazapi_error',
        message: 'Uazapi status is temporarily unavailable.',
      },
      { status: 502 }
    );
  }
}
