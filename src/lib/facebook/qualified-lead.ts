/**
 * Qualified Lead Events — Meta Conversions API
 *
 * Fires a CAPI "Lead" event when a deal enters a pipeline stage
 * that the admin configured as a "qualified lead" trigger. This
 * lets the Meta pixel optimize for leads that were actually
 * qualified by an agent, not every raw inbound WhatsApp message.
 *
 * The trigger stages are stored in meta_ads_config.capi_trigger_stage_ids
 * (migration 038) and configured in the Meta Ads settings panel.
 */

import { sendCapiEvents } from './conversions-api';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { supabaseAdmin as createAdminClient } from '@/lib/flows/admin-client';

interface AdsConfigRow {
  id: string;
  pixel_id: string | null;
  access_token: string | null;
  test_event_code: string | null;
  capi_trigger_stage_ids: string[] | null;
}

interface ContactRow {
  phone: string | null;
  name: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
}

/**
 * Check whether a deal moving to `newStageId` should trigger a
 * qualified-lead CAPI event, and fire it if so.
 *
 * Safe to call on every stage change — early-returns when:
 *  - the account has no meta_ads_config
 *  - the config has no pixel_id / access_token
 *  - `newStageId` is NOT in `capi_trigger_stage_ids`
 *
 * Designed to be fire-and-forget (no await needed in the caller).
 */
export async function fireQualifiedLeadEvent(
  supabaseAdmin: ReturnType<typeof createAdminClient>,
  accountId: string,
  dealId: string,
  contactId: string | null,
  newStageId: string,
  stageName?: string
): Promise<void> {
  if (!contactId) return;

  const { data: rawConfig } = await supabaseAdmin
    .from('meta_ads_config')
    .select(
      'id, pixel_id, access_token, test_event_code, capi_trigger_stage_ids'
    )
    .eq('account_id', accountId)
    .maybeSingle();

  const adsConfig = rawConfig as AdsConfigRow | null;
  if (!adsConfig?.pixel_id || !adsConfig?.access_token) return;
  if (!adsConfig.capi_trigger_stage_ids?.includes(newStageId)) return;

  let accessToken: string;
  if (!adsConfig.access_token.includes(':')) {
    // Compatibility for rows saved before this column was encrypted.
    accessToken = adsConfig.access_token;
    const { error: upgradeError } = await supabaseAdmin
      .from('meta_ads_config')
      .update({ access_token: encrypt(accessToken) })
      .eq('id', adsConfig.id);
    if (upgradeError) {
      console.error('[capi] failed to encrypt legacy Meta token', {
        code: upgradeError.code,
      });
      return;
    }
  } else {
    try {
      accessToken = decrypt(adsConfig.access_token);
    } catch {
      console.error('[capi] stored Meta token could not be decrypted');
      return;
    }
  }

  const { data: rawContact } = await supabaseAdmin
    .from('contacts')
    .select('phone, name, utm_campaign, utm_content')
    .eq('id', contactId)
    .single();

  const contactRow = rawContact as ContactRow | null;
  if (!contactRow?.phone) return;

  await sendCapiEvents(
    {
      pixelId: adsConfig.pixel_id,
      accessToken,
      testEventCode: adsConfig.test_event_code ?? undefined,
    },
    [
      {
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        action_source: 'whatsapp',
        event_id: `qualified_${accountId}_${dealId}_${Date.now()}`,
        user_data: {
          phones: [contactRow.phone],
          ...(contactRow.name ? { firstName: contactRow.name } : {}),
        },
        custom_data: {
          lead_source: 'WhatsApp',
          lead_quality: 'qualified',
          pipeline_stage: stageName ?? newStageId,
          campaign_name: contactRow.utm_campaign ?? undefined,
          ad_name: contactRow.utm_content ?? undefined,
        },
      },
    ]
  );
}
