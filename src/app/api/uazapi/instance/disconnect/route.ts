import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { instanceDisconnect } from '@/lib/uazapi/uazapi-client';
import {
  uazapiEnvConfig,
  getCachedInstanceToken,
} from '@/lib/uazapi/runtime-config';

export async function POST() {
  try {
    const { accountId, userId } = await requireRole('admin');

    const env = uazapiEnvConfig();
    if (!env.serverUrl) {
      return NextResponse.json(
        { error: 'UAZAPI_SERVER_URL is not set in the environment.' },
        { status: 400 }
      );
    }

    const instanceToken = await getCachedInstanceToken(
      supabaseAdmin(),
      accountId
    );
    if (!instanceToken) {
      return NextResponse.json(
        { error: 'Uazapi instance not created yet.' },
        { status: 400 }
      );
    }

    await instanceDisconnect({
      serverUrl: env.serverUrl,
      apiToken: instanceToken,
    });

    // Reset status (the config row is only a state cache now).
    await supabaseAdmin().from('uazapi_config').upsert(
      {
        account_id: accountId,
        user_id: userId,
        status: 'disconnected',
        qr_code: null,
        connected_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'account_id' }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in Uazapi disconnect:', error);
    const authResponse = toErrorResponse(error);
    if (authResponse.status !== 500) return authResponse;
    return NextResponse.json(
      { error: 'Failed to disconnect the WhatsApp instance.' },
      { status: 502 }
    );
  }
}
