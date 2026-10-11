/**
 * Atribuição de origem do lead (campanha / conjunto / anúncio).
 *
 * Como funciona:
 *  1. O anunciante coloca parâmetros no URL do anúncio. Na Meta, os valores
 *     são preenchidos automaticamente pelas macros dinâmicas:
 *     `utm_campaign={{campaign.name}}&utm_term={{adset.name}}&utm_content={{ad.name}}`
 *     (+ `campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`).
 *  2. `collectTracking()` (browser) captura esses params + click IDs
 *     (fbclid, gclid, ttclid…) + cookies fbp/fbc + referrer + landing page.
 *  3. `normalizeAttribution()` (server ou client) resume tudo num objeto
 *     `Attribution` salvo dentro do `tracking` da resposta — é dele que a
 *     UI lê "de qual campanha/anúncio veio cada lead".
 *
 * Convenção adotada (também usada pelo construtor de UTM da aba Compartilhar):
 *  - utm_campaign → campanha · utm_term → conjunto (adset) · utm_content → anúncio
 *  - campaign_id / adset_id / ad_id → IDs numéricos (quebra de empate com nomes)
 */

export type TrackingBag = Record<string, string | undefined>;

export interface Attribution {
  /** Origem canônica: meta | google | tiktok | bing | linkedin | whatsapp | referral | direct … */
  source: string;
  /** Rótulo de exibição, ex.: "Meta Ads", "Google", "Direto". */
  sourceLabel: string;
  medium?: string;
  campaign?: string;
  campaignId?: string;
  adset?: string;
  adsetId?: string;
  ad?: string;
  adId?: string;
  placement?: string;
  clickId?: string;
  clickType?: string;
  landingPage?: string;
  referrer?: string;
  /** true quando há sinal de mídia paga (click id, utm de paid ou ids de anúncio). */
  hasAds: boolean;
}

/** Parâmetros capturados da URL (query string). */
const URL_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  // IDs explícitos (macros {{campaign.id}} etc. ou montagem manual)
  'campaign_id',
  'campaign_name',
  'adset_id',
  'adset_name',
  'ad_id',
  'ad_name',
  'placement',
  'site_source_name',
  // Click IDs das plataformas
  'fbclid',
  'gclid',
  'gbraid',
  'wbraid',
  'ttclid',
  'msclkid',
  'li_fat_id',
] as const;

const MAX_LEN = 500;

function clean(v: string | null | undefined): string | undefined {
  if (v == null) return undefined;
  const s = v.trim().slice(0, MAX_LEN);
  return s ? s : undefined;
}

/** Chaves aceitas no tracking (tudo fora disso é descartado no servidor). */
const ALLOWED_TRACKING_KEYS = new Set<string>([
  ...URL_PARAMS,
  'fbp',
  'fbc',
  'referrer',
  'source_url',
]);

/**
 * Servidor: higieniza o tracking vindo do browser antes de persistir.
 * - Só chaves conhecidas (bloqueia `__proto__`, blobs e lixo);
 * - só strings, teto de 500 chars (`source_url` até 2000);
 * - nunca lança.
 */
export function sanitizeTracking(raw: unknown): TrackingBag {
  const out: TrackingBag = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALLOWED_TRACKING_KEYS.has(key) || typeof value !== 'string') continue;
    const cap = key === 'source_url' ? 2000 : MAX_LEN;
    const v = value.trim().slice(0, cap);
    if (v) out[key] = v;
  }
  return out;
}

/**
 * Browser: lê query string + cookies + referrer. Seguro para chamar no
 * cliente (retorna {} fora do browser). Mantém as chaves históricas
 * (utm_*, fbclid, fbp, fbc, source_url) para compatibilidade.
 */
export function collectTracking(search?: string): TrackingBag {
  if (typeof window === 'undefined' || typeof document === 'undefined') return {};
  const out: TrackingBag = {};
  try {
    const qs = new URLSearchParams(
      search ?? window.location.search
    );
    for (const key of URL_PARAMS) {
      const v = clean(qs.get(key));
      if (v !== undefined) out[key] = v;
    }
    const cookies: Record<string, string> = {};
    for (const part of document.cookie.split(';')) {
      const idx = part.indexOf('=');
      if (idx > 0) cookies[part.slice(0, idx).trim()] = part.slice(idx + 1);
    }
    if (cookies._fbp) out.fbp = cookies._fbp.slice(0, MAX_LEN);
    if (cookies._fbc) out.fbc = cookies._fbc.slice(0, MAX_LEN);
    const ref = clean(document.referrer);
    if (ref) out.referrer = ref;
    out.source_url = window.location.href.slice(0, 2000);
  } catch {
    /* tracking nunca pode quebrar o formulário */
  }
  return out;
}

const SOURCE_ALIASES: Record<string, { source: string; label: string }> = {
  facebook: { source: 'meta', label: 'Meta Ads' },
  fb: { source: 'meta', label: 'Meta Ads' },
  instagram: { source: 'meta', label: 'Meta Ads' },
  ig: { source: 'meta', label: 'Meta Ads' },
  meta: { source: 'meta', label: 'Meta Ads' },
  messenger: { source: 'meta', label: 'Meta Ads' },
  google: { source: 'google', label: 'Google' },
  goog: { source: 'google', label: 'Google' },
  youtube: { source: 'google', label: 'Google' },
  yt: { source: 'google', label: 'Google' },
  tiktok: { source: 'tiktok', label: 'TikTok' },
  tt: { source: 'tiktok', label: 'TikTok' },
  bing: { source: 'bing', label: 'Bing' },
  linkedin: { source: 'linkedin', label: 'LinkedIn' },
  kwai: { source: 'kwai', label: 'Kwai' },
  whatsapp: { source: 'whatsapp', label: 'WhatsApp' },
  wa: { source: 'whatsapp', label: 'WhatsApp' },
  email: { source: 'email', label: 'E-mail' },
  sms: { source: 'sms', label: 'SMS' },
};

const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'paid',
  'paid_social',
  'paidsocial',
  'social_paid',
  'cpm',
  'cpv',
  'display',
  'paid_video',
]);

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

function sourceFromReferrer(ref: string): { source: string; label: string } | null {
  const host = hostOf(ref);
  if (!host) return null;
  if (/(^|\.)(facebook|instagram|messenger)\.com$/.test(host) || host.endsWith('.facebook.com')) {
    return { source: 'meta', label: 'Meta Ads' };
  }
  if (/google\./.test(host) || host === 'youtube.com' || host.endsWith('.youtube.com')) {
    return { source: 'google', label: 'Google (orgânico)' };
  }
  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    return { source: 'tiktok', label: 'TikTok' };
  }
  if (host === 'bing.com' || host.endsWith('.bing.com')) {
    return { source: 'bing', label: 'Bing' };
  }
  if (/wa\.me$/.test(host) || host === 'whatsapp.com' || host.endsWith('.whatsapp.com')) {
    return { source: 'whatsapp', label: 'WhatsApp' };
  }
  return { source: 'referral', label: `Indicação · ${host}` };
}

/**
 * Resume o tracking bruto numa atribuição exibível. Tolerante a linhas
 * antigas (só utm_* + fbclid) e a linhas novas (com `attribution` embutida
 * ou ids explícitos).
 */
export function normalizeAttribution(tracking?: TrackingBag | null): Attribution {
  const t = tracking ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, MAX_LEN) : undefined;

  const utmSource = str(t.utm_source)?.toLowerCase();
  const alias = utmSource ? SOURCE_ALIASES[utmSource] : undefined;

  let clickType: string | undefined;
  let clickId: string | undefined;
  for (const key of ['fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid', 'li_fat_id'] as const) {
    const v = str(t[key]);
    if (v) {
      clickType = key;
      clickId = v;
      break;
    }
  }
  // fbc carrega o fbclid dentro do cookie (fb.1.<ts>.<fbclid>)
  if (!clickId && str(t.fbc)) {
    clickType = 'fbc';
    clickId = str(t.fbc);
  }

  let source = 'direct';
  let sourceLabel = 'Direto';
  if (alias) {
    source = alias.source;
    sourceLabel = alias.label;
  } else if (clickType === 'fbclid' || clickType === 'fbc') {
    source = 'meta';
    sourceLabel = 'Meta Ads';
  } else if (clickType === 'gclid' || clickType === 'gbraid' || clickType === 'wbraid') {
    source = 'google';
    sourceLabel = 'Google';
  } else if (clickType === 'ttclid') {
    source = 'tiktok';
    sourceLabel = 'TikTok';
  } else if (clickType === 'msclkid') {
    source = 'bing';
    sourceLabel = 'Bing';
  } else if (clickType === 'li_fat_id') {
    source = 'linkedin';
    sourceLabel = 'LinkedIn';
  } else if (str(t.referrer)) {
    const fromRef = sourceFromReferrer(str(t.referrer)!);
    if (fromRef) {
      source = fromRef.source;
      sourceLabel = fromRef.label;
    }
  }
  // utm_source desconhecido mas presente: exibe como está.
  if (!alias && utmSource && source === 'direct' && !str(t.referrer) && !clickId) {
    source = utmSource;
    sourceLabel = str(t.utm_source)!;
  }

  const medium = str(t.utm_medium)?.toLowerCase();
  const hasAds =
    !!clickId ||
    !!str(t.ad_id) ||
    !!str(t.campaign_id) ||
    !!str(t.adset_id) ||
    (medium ? PAID_MEDIUMS.has(medium) : false);

  return {
    source,
    sourceLabel,
    medium: str(t.utm_medium),
    campaign: str(t.utm_campaign) ?? str(t.campaign_name),
    campaignId: str(t.utm_id) ?? str(t.campaign_id),
    adset: str(t.utm_term) ?? str(t.adset_name),
    adsetId: str(t.adset_id),
    ad: str(t.utm_content) ?? str(t.ad_name),
    adId: str(t.ad_id),
    placement: str(t.placement) ?? str(t.site_source_name),
    clickId,
    clickType,
    landingPage: str(t.source_url),
    referrer: str(t.referrer),
    hasAds,
  };
}

/** Linha de exibição compacta: "Campanha · Anúncio" ou origem. */
export function attributionLabel(a: Attribution): string {
  const parts = [a.campaign, a.ad].filter(Boolean) as string[];
  if (parts.length > 0) return parts.join(' · ');
  if (a.campaignId || a.adId) {
    return [a.campaignId, a.adId].filter(Boolean).join(' · ') as string;
  }
  return a.sourceLabel;
}
