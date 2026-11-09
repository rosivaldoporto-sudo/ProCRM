import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/whatsapp/encryption';
import type { MessageReferral } from '@/types';

// ============================================================
// Anúncios Click-to-WhatsApp: atribuição no contato e nomes da
// campanha, do conjunto e do anúncio.
//
// A mensagem do anúncio só traz o ID do anúncio (`referral.source_id`).
// Os nomes vêm da API de Marketing:
//   GET /{ad_id}?fields=name,adset{id,name},campaign{id,name}
// com um token que tenha `ads_read` na conta de anúncios (configurado em
// Configurações → Meta Ads; sem ele, tenta o token da Conversions API).
//
// Vários leads chegam do mesmo anúncio, então o resultado fica em
// `meta_ad_lookups` (migration 065): acerto por 7 dias, falha por 1 hora.
// Nada aqui lança erro: a busca roda depois do webhook responder e uma
// falha só deixa o cartão sem os nomes.
// ============================================================

/** Mesma versão da Conversions API (conversions-api.ts). */
const GRAPH_BASE = 'https://graph.facebook.com/v26.0';
const AD_FIELDS = 'name,adset{id,name},campaign{id,name}';
const REQUEST_TIMEOUT_MS = 8000;
export const SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILURE_TTL_MS = 60 * 60 * 1000;
const MAX_NAME = 500;
const MAX_ERROR = 300;

export interface AdNames {
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
}

export type AdNamesResult =
  | { ok: true; names: AdNames }
  | { ok: false; error: string };

type FetchLike = typeof fetch;

/** IDs da Meta são numéricos. Barra qualquer outra coisa na URL. */
export function isValidAdId(id: unknown): id is string {
  return typeof id === 'string' && /^\d{1,32}$/.test(id);
}

function cleanName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > MAX_NAME ? text.slice(0, MAX_NAME) : text;
}

function cleanId(value: unknown): string | undefined {
  return isValidAdId(value) ? value : undefined;
}

function compactNames(names: AdNames): AdNames {
  return Object.fromEntries(
    Object.entries(names).filter(([, v]) => v !== undefined)
  ) as AdNames;
}

function hasNames(names: AdNames): boolean {
  return Object.keys(names).length > 0;
}

/** Mensagem curta do erro da Graph API: "(#100) Unsupported get request…". */
function graphError(body: unknown, status: number): string {
  const err = (body as { error?: { message?: unknown; code?: unknown } })
    ?.error;
  const message =
    typeof err?.message === 'string' ? err.message : `HTTP ${status}`;
  const code = typeof err?.code === 'number' ? `(#${err.code}) ` : '';
  return `${code}${message}`.slice(0, MAX_ERROR);
}

/**
 * Lê os nomes de um anúncio na API de Marketing. Não usa cache: é a
 * chamada crua, usada pela busca com cache e pelo teste da configuração.
 */
export async function fetchAdNames(args: {
  adId: string;
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<AdNamesResult> {
  const { adId, accessToken, fetchImpl = fetch } = args;
  if (!isValidAdId(adId)) return { ok: false, error: 'ID de anúncio inválido' };

  try {
    const res = await fetchImpl(
      `${GRAPH_BASE}/${adId}?fields=${encodeURIComponent(AD_FIELDS)}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok || !body || body.error) {
      return { ok: false, error: graphError(body, res.status) };
    }
    const adset = body.adset as { id?: unknown; name?: unknown } | undefined;
    const campaign = body.campaign as
      | { id?: unknown; name?: unknown }
      | undefined;
    return {
      ok: true,
      names: compactNames({
        ad_name: cleanName(body.name),
        adset_id: cleanId(adset?.id),
        adset_name: cleanName(adset?.name),
        campaign_id: cleanId(campaign?.id),
        campaign_name: cleanName(campaign?.name),
      }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, MAX_ERROR) };
  }
}

export interface AdAccountInfo {
  id: string;
  name: string;
}

export type TokenCheckResult =
  | { ok: false; error: string }
  | { ok: true; adAccounts: AdAccountInfo[]; adAccountsError?: string };

/**
 * Confere um token antes de salvar: precisa ser aceito pela Meta
 * (`/me`). As contas de anúncios que ele enxerga são só informativas —
 * token de usuário do sistema pode não listar contas e ainda ler os
 * anúncios —, então uma falha nessa lista vira aviso, não erro.
 */
export async function checkMarketingToken(args: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): Promise<TokenCheckResult> {
  const { accessToken, fetchImpl = fetch } = args;
  const get = async (path: string) => {
    const res = await fetchImpl(`${GRAPH_BASE}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return { res, body };
  };

  try {
    const me = await get('/me?fields=id');
    if (!me.res.ok || !me.body || me.body.error) {
      return { ok: false, error: graphError(me.body, me.res.status) };
    }

    const accounts = await get('/me/adaccounts?fields=name,account_id&limit=50');
    if (!accounts.res.ok || !accounts.body || accounts.body.error) {
      return {
        ok: true,
        adAccounts: [],
        adAccountsError: graphError(accounts.body, accounts.res.status),
      };
    }
    const list = Array.isArray(accounts.body.data) ? accounts.body.data : [];
    return {
      ok: true,
      adAccounts: list
        .map((a) => a as { account_id?: unknown; id?: unknown; name?: unknown })
        .map((a) => ({
          id: String(a.account_id ?? a.id ?? '').slice(0, 64),
          name: cleanName(a.name) ?? '',
        }))
        .filter((a) => a.id),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, MAX_ERROR) };
  }
}

/**
 * Token salvo em meta_ads_config: criptografado (`iv:tag:dados`) ou, em
 * linhas antigas, em texto puro. Null quando vazio ou ilegível.
 */
export function readStoredToken(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (!value.includes(':')) return value;
  try {
    return decrypt(value) || null;
  } catch {
    return null;
  }
}

/**
 * Token para ler anúncios: o de Marketing (ads_read) e, sem ele, o da
 * Conversions API. `select('*')` para não quebrar antes da migration 065.
 */
export async function getAdsReadToken(
  db: SupabaseClient,
  accountId: string
): Promise<string | null> {
  const { data, error } = await db
    .from('meta_ads_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return (
    readStoredToken(row.marketing_access_token) ??
    readStoredToken(row.access_token)
  );
}

interface LookupRow {
  ad_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  error: string | null;
  fetched_at: string;
}

function namesFromRow(row: LookupRow): AdNames {
  return compactNames({
    ad_name: row.ad_name ?? undefined,
    adset_id: row.adset_id ?? undefined,
    adset_name: row.adset_name ?? undefined,
    campaign_id: row.campaign_id ?? undefined,
    campaign_name: row.campaign_name ?? undefined,
  });
}

/**
 * Nomes do anúncio, com cache por conta. Null quando não há token, a
 * Meta recusou (e não há nomes antigos) ou o ID é inválido.
 */
export async function resolveAdNames(args: {
  db: SupabaseClient;
  accountId: string;
  adId: string;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<AdNames | null> {
  const { db, accountId, adId, fetchImpl } = args;
  const now = args.now ?? Date.now();
  if (!isValidAdId(adId)) return null;

  // Cache. Sem a tabela (migration 065 pendente) segue sem cache.
  let cached: LookupRow | null = null;
  const { data: cacheRow, error: cacheError } = await db
    .from('meta_ad_lookups')
    .select('*')
    .eq('account_id', accountId)
    .eq('ad_id', adId)
    .maybeSingle();
  if (!cacheError && cacheRow) cached = cacheRow as LookupRow;

  const cachedNames = cached && !cached.error ? namesFromRow(cached) : null;
  if (cached) {
    const age = now - new Date(cached.fetched_at).getTime();
    if (!cached.error && age < SUCCESS_TTL_MS) {
      return cachedNames && hasNames(cachedNames) ? cachedNames : null;
    }
    if (cached.error && age < FAILURE_TTL_MS) return null;
  }

  const accessToken = await getAdsReadToken(db, accountId);
  if (!accessToken) {
    return cachedNames && hasNames(cachedNames) ? cachedNames : null;
  }

  const result = await fetchAdNames({ adId, accessToken, fetchImpl });
  if (!result.ok) {
    console.warn(
      `[ctwa-ads] Meta recusou a leitura do anúncio ${adId}:`,
      result.error
    );
  }

  if (!cacheError) {
    const names = result.ok ? result.names : {};
    const { error: upsertError } = await db.from('meta_ad_lookups').upsert(
      {
        account_id: accountId,
        ad_id: adId,
        ad_name: names.ad_name ?? null,
        adset_id: names.adset_id ?? null,
        adset_name: names.adset_name ?? null,
        campaign_id: names.campaign_id ?? null,
        campaign_name: names.campaign_name ?? null,
        error: result.ok ? null : result.error,
        fetched_at: new Date(now).toISOString(),
      },
      { onConflict: 'account_id,ad_id' }
    );
    if (upsertError) {
      console.warn('[ctwa-ads] cache não gravado:', upsertError.message);
    }
  }

  if (result.ok) return hasNames(result.names) ? result.names : null;
  // Falhou agora, mas havia nomes de antes: melhor que nada.
  return cachedNames && hasNames(cachedNames) ? cachedNames : null;
}

/**
 * Grava no contato o anúncio que trouxe o lead. O primeiro anúncio
 * vale: se o contato já tem clique ou anúncio, nada muda.
 */
export async function captureAdsAttribution(args: {
  db: SupabaseClient;
  contactId: string;
  conversationId: string;
  ctwaClid?: string;
  adId?: string;
  sourceType?: string;
}): Promise<void> {
  const { db, contactId, conversationId, ctwaClid, adId, sourceType } = args;
  if (!ctwaClid && !adId) return;

  const { data: existing } = await db
    .from('contacts')
    .select('ctwa_clid, ad_id')
    .eq('id', contactId)
    .maybeSingle();
  if (existing?.ctwa_clid || existing?.ad_id) return;

  await db
    .from('contacts')
    .update({
      ctwa_clid: ctwaClid,
      ad_id: adId ?? null,
      ad_source_type: sourceType ?? 'ctwa',
      // Mirror onto the UTM columns so the CAPI lead event (and any
      // UTM-based reporting) carries a consistent campaign/ad label.
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: ctwaClid ? 'click_to_whatsapp' : undefined,
    })
    .eq('id', contactId);

  await db
    .from('conversations')
    .update({ utm_source: 'facebook', utm_medium: 'cpc' })
    .eq('id', conversationId);
}

function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'PGRST204' || code === '42703';
}

/**
 * Busca os nomes do anúncio e grava no `referral` da mensagem e no
 * contato. No contato só grava quando o anúncio dele é este (o primeiro
 * anúncio vale). Publicação impulsionada (`source_type: post`) traz o ID
 * da publicação, não do anúncio, e é ignorada.
 */
export async function enrichAdReferral(args: {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  referral: MessageReferral;
  /** Linha da mensagem: pelo id interno ou pelo id do WhatsApp. */
  message:
    | { id: string }
    | { conversationId: string; whatsappMessageId: string };
  /** False quando a mensagem foi gravada sem a coluna referral. */
  saveOnMessage?: boolean;
  fetchImpl?: FetchLike;
}): Promise<AdNames | null> {
  const { db, accountId, contactId, referral, message, fetchImpl } = args;
  const adId = referral.source_id;
  if (!isValidAdId(adId) || referral.source_type === 'post') return null;

  try {
    const names = await resolveAdNames({ db, accountId, adId, fetchImpl });
    if (!names) return null;

    if (args.saveOnMessage !== false) {
      let update = db
        .from('messages')
        .update({ referral: { ...referral, ...names } });
      update =
        'id' in message
          ? update.eq('id', message.id)
          : update
              .eq('conversation_id', message.conversationId)
              .eq('message_id', message.whatsappMessageId);
      const { error } = await update;
      if (error) {
        console.warn('[ctwa-ads] nomes não gravados na mensagem:', error.message);
      }
    }

    const contactUpdate: Record<string, string> = {};
    if (names.ad_name) contactUpdate.ad_name = names.ad_name;
    if (names.campaign_id) contactUpdate.campaign_id = names.campaign_id;
    if (names.campaign_name) {
      contactUpdate.campaign_name = names.campaign_name;
      contactUpdate.utm_campaign = names.campaign_name;
    }
    if (names.adset_id) contactUpdate.adset_id = names.adset_id;
    if (names.adset_name) contactUpdate.adset_name = names.adset_name;
    if (Object.keys(contactUpdate).length > 0) {
      const run = (values: Record<string, string>) =>
        db
          .from('contacts')
          .update(values)
          .eq('id', contactId)
          .eq('ad_id', adId);
      let { error } = await run(contactUpdate);
      // Sem a migration 065 o contato não tem as colunas do conjunto.
      if (error && isMissingColumn(error)) {
        const { adset_id: _id, adset_name: _name, ...rest } = contactUpdate;
        void _id;
        void _name;
        ({ error } = Object.keys(rest).length
          ? await run(rest)
          : { error: null });
      }
      if (error) {
        console.warn('[ctwa-ads] nomes não gravados no contato:', error.message);
      }
    }

    return names;
  } catch (err) {
    console.warn('[ctwa-ads] busca dos nomes do anúncio falhou:', err);
    return null;
  }
}
