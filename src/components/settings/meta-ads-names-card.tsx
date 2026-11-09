'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ExternalLink, Loader2, Save, Search, Tags, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

interface TokenStatus {
  has_token: boolean;
  has_capi_token: boolean;
  migration_missing: boolean;
}

interface AdNames {
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
}

/** Status do token. Só informativo: o formulário funciona sem ele. */
async function fetchTokenStatus(): Promise<TokenStatus | null> {
  try {
    const res = await fetch('/api/meta-ads/marketing-token', {
      cache: 'no-store',
    });
    return res.ok ? ((await res.json()) as TokenStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Token com ads_read para o CRM ler na Meta os nomes da campanha, do
 * conjunto e do anúncio de cada lead que chega por anúncio. O token só
 * vai para o servidor; o navegador recebe apenas se ele existe.
 */
export function MetaAdsNamesCard() {
  const t = useTranslations('Settings.metaAds.adNames');
  const [status, setStatus] = useState<TokenStatus | null>(null);
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [accounts, setAccounts] = useState<{ id: string; name: string }[] | null>(
    null
  );
  const [accountsWarning, setAccountsWarning] = useState<string | null>(null);
  const [adId, setAdId] = useState('');
  const [testing, setTesting] = useState(false);
  const [testNames, setTestNames] = useState<AdNames | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const next = await fetchTokenStatus();
    if (next) setStatus(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchTokenStatus().then((next) => {
      if (!cancelled && next) setStatus(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSave() {
    if (!token.trim()) return;
    setSaving(true);
    setAccounts(null);
    setAccountsWarning(null);
    try {
      const res = await fetch('/api/meta-ads/marketing-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        ad_accounts?: { id: string; name: string }[];
        ad_accounts_error?: string;
      };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setToken('');
      setAccounts(j.ad_accounts ?? []);
      setAccountsWarning(j.ad_accounts_error ?? null);
      toast.success(t('saved'));
      await loadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch('/api/meta-ads/marketing-token', {
        method: 'DELETE',
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setAccounts(null);
      setAccountsWarning(null);
      toast.success(t('removed'));
      await loadStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('saveError'));
    } finally {
      setRemoving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestNames(null);
    setTestError(null);
    try {
      const res = await fetch('/api/meta-ads/marketing-token/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ad_id: adId.trim() }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        names?: AdNames;
      };
      if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setTestNames(j.names ?? {});
    } catch (err) {
      setTestError(err instanceof Error ? err.message : t('testError'));
    } finally {
      setTesting(false);
    }
  }

  const canTest = !!(status?.has_token || status?.has_capi_token);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="h-4 w-4" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status && (
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant={status.has_token ? 'default' : 'outline'}>
              {status.has_token
                ? t('statusSaved')
                : status.has_capi_token
                  ? t('statusCapiFallback')
                  : t('statusNone')}
            </Badge>
          </div>
        )}

        {status?.migration_missing && (
          <Alert variant="destructive">
            <AlertDescription>{t('migrationMissing')}</AlertDescription>
          </Alert>
        )}

        <div className="text-muted-foreground space-y-1 text-sm">
          <ol className="list-inside list-decimal space-y-1">
            <li>{t('step1')}</li>
            <li>{t('step2')}</li>
            <li>{t('step3')}</li>
          </ol>
          <a
            href="https://business.facebook.com/settings/system-users"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary inline-flex items-center gap-1 text-sm hover:underline"
          >
            {t('systemUsersLink')} <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        <div className="space-y-2">
          <Label htmlFor="marketing-token">{t('tokenLabel')}</Label>
          <Input
            id="marketing-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              status?.has_token ? '••••••••••••••••' : t('tokenPlaceholder')
            }
            autoComplete="new-password"
            className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={handleSave} disabled={saving || !token.trim()}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t('save')}
          </Button>
          {status?.has_token && (
            <Button
              variant="outline"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          )}
        </div>

        {accounts && accounts.length > 0 && (
          <div className="border-border rounded-lg border p-3 text-sm">
            <p className="font-medium">
              {t('accountsFound', { count: accounts.length })}
            </p>
            <ul className="text-muted-foreground mt-1 list-inside list-disc text-xs">
              {accounts.map((a) => (
                <li key={a.id}>
                  {a.name || a.id}{' '}
                  <span className="font-mono opacity-70">({a.id})</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {accountsWarning && (
          <Alert>
            <AlertDescription>
              {t('accountsWarning', { error: accountsWarning })}
            </AlertDescription>
          </Alert>
        )}

        <div className="border-border space-y-2 border-t pt-4">
          <Label htmlFor="test-ad-id">{t('testLabel')}</Label>
          <p className="text-muted-foreground text-xs">{t('testHint')}</p>
          <div className="flex flex-wrap gap-2">
            <Input
              id="test-ad-id"
              inputMode="numeric"
              value={adId}
              onChange={(e) => setAdId(e.target.value)}
              placeholder="120210000000000000"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground max-w-xs font-mono"
            />
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={testing || !adId.trim() || !canTest}
            >
              {testing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              {t('testButton')}
            </Button>
          </div>

          {testError && (
            <p className="text-destructive text-sm">{testError}</p>
          )}
          {testNames && (
            <dl className="border-border grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
              <dt className="text-muted-foreground">{t('campaign')}</dt>
              <dd className="truncate">{testNames.campaign_name ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('adset')}</dt>
              <dd className="truncate">{testNames.adset_name ?? '—'}</dd>
              <dt className="text-muted-foreground">{t('ad')}</dt>
              <dd className="truncate">{testNames.ad_name ?? '—'}</dd>
            </dl>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
