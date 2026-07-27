'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Save, ExternalLink, HelpCircle, Check } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import type { MetaAdsConfig as MetaAdsConfigType } from '@/types';
import type { PipelineStage } from '@/types';

export function MetaAdsConfig() {
  const t = useTranslations('Settings.metaAds');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<MetaAdsConfigType | null>(null);

  const [pixelId, setPixelId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [testEventCode, setTestEventCode] = useState('');
  const [triggerStageIds, setTriggerStageIds] = useState<string[]>([]);
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [pipelineNames, setPipelineNames] = useState<Record<string, string>>({});
  const [loadingStages, setLoadingStages] = useState(false);

  const fetchConfig = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const { data } = await supabase
        .from('meta_ads_config')
        .select('*')
        .eq('account_id', accountId)
        .maybeSingle();
      if (data) {
        setConfig(data as MetaAdsConfigType);
        setPixelId(data.pixel_id ?? '');
        setAccessToken(data.access_token ?? '');
        setTestEventCode(data.test_event_code ?? '');
        setTriggerStageIds(data.capi_trigger_stage_ids ?? []);
      } else {
        setConfig(null);
        setPixelId('');
        setAccessToken('');
        setTestEventCode('');
        setTriggerStageIds([]);
      }
    } finally {
      setLoading(false);
    }
  }, [accountId, supabase]);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  // Load pipeline stages for the trigger-stage picker
  useEffect(() => {
    if (!accountId) return;
    async function fetchStages() {
      setLoadingStages(true);
      try {
        const { data: pipelines } = await supabase
          .from('pipelines')
          .select('id, name')
          .eq('account_id', accountId)
          .order('created_at');
        if (!pipelines || pipelines.length === 0) {
          setStages([]);
          setPipelineNames({});
          return;
        }
        const pipelineIds = pipelines.map((p: { id: string }) => p.id);
        const nameMap: Record<string, string> = {};
        for (const p of pipelines) {
          nameMap[p.id] = p.name;
        }
        setPipelineNames(nameMap);
        const { data: stageRows } = await supabase
          .from('pipeline_stages')
          .select('*')
          .in('pipeline_id', pipelineIds)
          .order('position');
        setStages(stageRows ?? []);
      } finally {
        setLoadingStages(false);
      }
    }
    fetchStages();
  }, [accountId, supabase]);

  function toggleStage(stageId: string) {
    setTriggerStageIds((prev) =>
      prev.includes(stageId)
        ? prev.filter((id) => id !== stageId)
        : [...prev, stageId],
    );
  }

  async function handleSave() {
    if (!accountId) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        account_id: accountId,
        pixel_id: pixelId.trim() || null,
        access_token: accessToken.trim() || null,
        test_event_code: testEventCode.trim() || null,
        capi_trigger_stage_ids: triggerStageIds.length > 0 ? triggerStageIds : null,
      };

      if (config) {
        const { error } = await supabase
          .from('meta_ads_config')
          .update(payload)
          .eq('id', config.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('meta_ads_config')
          .insert(payload);
        if (error) throw error;
      }

      toast.success(t('saved'));
      await fetchConfig();
    } catch (err) {
      toast.error(t('saveError', { error: err instanceof Error ? err.message : 'Unknown' }));
    } finally {
      setSaving(false);
    }
  }

  const stagesByPipeline = stages.reduce<Record<string, PipelineStage[]>>(
    (acc, s) => {
      const key = pipelineNames[s.pipeline_id] || s.pipeline_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(s);
      return acc;
    },
    {},
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsPanelHead
        title={t('pageTitle')}
        description={t('pageDesc')}
      />

      <Alert>
        <HelpCircle className="h-4 w-4" />
        <AlertTitle>{t('howToTitle')}</AlertTitle>
        <AlertDescription>
          <p className="mb-2">{t('howToDesc')}</p>
          <ol className="list-inside list-decimal space-y-1 text-sm">
            <li>{t('howToStep1')}</li>
            <li>{t('howToStep2')}</li>
            <li>{t('howToStep3')}</li>
          </ol>
          <a
            href="https://developers.facebook.com/docs/marketing-api/conversions-api/get-started"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {t('howToLink')}
            <ExternalLink className="h-3 w-3" />
          </a>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle>{t('configTitle')}</CardTitle>
          <CardDescription>{t('configDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="pixel-id">{t('pixelId')}</Label>
            <Input
              id="pixel-id"
              value={pixelId}
              onChange={(e) => setPixelId(e.target.value)}
              placeholder="1234567890"
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="access-token">{t('accessToken')}</Label>
            <Input
              id="access-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={t('accessTokenPlaceholder')}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="test-event-code">
              {t('testEventCode')}
              <span className="ml-1 text-xs text-muted-foreground">
                ({t('optional')})
              </span>
            </Label>
            <Input
              id="test-event-code"
              value={testEventCode}
              onChange={(e) => setTestEventCode(e.target.value)}
              placeholder={t('testEventCodePlaceholder')}
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            <Save className="h-4 w-4" />
            {t('save')}
          </Button>
        </CardContent>
      </Card>

      {/* Qualified Lead Trigger — pipeline stage picker */}
      <Card>
        <CardHeader>
          <CardTitle>{t('qualifiedLeadTitle')}</CardTitle>
          <CardDescription>{t('qualifiedLeadDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          {loadingStages ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-5 w-5 animate-spin text-primary" />
            </div>
          ) : Object.keys(stagesByPipeline).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noPipelines')}</p>
          ) : (
            <div className="space-y-4">
              {Object.entries(stagesByPipeline).map(([pipelineName, pipelineStages]) => (
                <div key={pipelineName}>
                  <p className="mb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                    {pipelineName}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {pipelineStages.map((stage) => {
                      const isSelected = triggerStageIds.includes(stage.id);
                      return (
                        <button
                          key={stage.id}
                          onClick={() => toggleStage(stage.id)}
                          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
                            isSelected
                              ? 'border-primary/40 bg-primary/10 text-primary'
                              : 'border-border bg-muted text-muted-foreground hover:border-border'
                          }`}
                        >
                          {isSelected && <Check className="h-3 w-3" />}
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: stage.color }}
                          />
                          {stage.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">{t('qualifiedLeadHint')}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('trackingLinksTitle')}</CardTitle>
          <CardDescription>{t('trackingLinksDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border border-border bg-muted/50 p-4">
            <p className="mb-2 text-sm font-medium text-foreground">{t('linkExample')}</p>
            <code className="block break-all rounded bg-muted px-3 py-2 text-xs text-muted-foreground">
              https://wa.me/5511999999999?utm_source=facebook&amp;utm_campaign=promo_verao&amp;utm_content=ad_01
            </code>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('linkParams')}</p>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
              <li><code className="rounded bg-muted px-1">utm_source</code> — {t('paramSource')}</li>
              <li><code className="rounded bg-muted px-1">utm_campaign</code> — {t('paramCampaign')}</li>
              <li><code className="rounded bg-muted px-1">utm_medium</code> — {t('paramMedium')}</li>
              <li><code className="rounded bg-muted px-1">utm_content</code> — {t('paramContent')}</li>
              <li><code className="rounded bg-muted px-1">utm_term</code> — {t('paramTerm')}</li>
            </ul>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
