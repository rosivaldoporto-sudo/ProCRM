'use client';

import { Suspense, useMemo, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { useTheme } from '@/hooks/use-theme';
import { SettingsRail } from '@/components/settings/settings-rail';
import { SettingsOverview } from '@/components/settings/settings-overview';
import {
  resolveSection,
  SECTION_SLUGS,
  SECTION_META,
  type SettingsSection,
} from '@/components/settings/settings-sections';

// Só a seção aberta é renderizada, então cada uma carrega sob demanda em vez
// de todas (template manager, WhatsApp, chaves de API...) no primeiro acesso.
function PanelLoading() {
  return <div className="h-40 animate-pulse rounded-lg bg-muted/40" />;
}

const ProfileForm = dynamic(() => import('@/components/settings/profile-form').then((m) => m.ProfileForm), { loading: PanelLoading });
const SecurityPanel = dynamic(() => import('@/components/settings/security-panel').then((m) => m.SecurityPanel), { loading: PanelLoading });
const AppearancePanel = dynamic(() => import('@/components/settings/appearance-panel').then((m) => m.AppearancePanel), { loading: PanelLoading });
const NotificationsPanel = dynamic(() => import('@/components/settings/notifications-panel').then((m) => m.NotificationsPanel), { loading: PanelLoading });
const WhatsAppConfig = dynamic(() => import('@/components/settings/whatsapp-config').then((m) => m.WhatsAppConfig), { loading: PanelLoading });
const WhatsAppQrConnect = dynamic(() => import('@/components/settings/whatsapp-qr-connect').then((m) => m.WhatsAppQrConnect), { loading: PanelLoading });
const MetaAdsConfig = dynamic(() => import('@/components/settings/meta-ads-config').then((m) => m.MetaAdsConfig), { loading: PanelLoading });
const TemplateManager = dynamic(() => import('@/components/settings/template-manager').then((m) => m.TemplateManager), { loading: PanelLoading });
const QuickRepliesManager = dynamic(() => import('@/components/settings/quick-replies-manager').then((m) => m.QuickRepliesManager), { loading: PanelLoading });
const FieldsAndTagsPanel = dynamic(() => import('@/components/settings/fields-and-tags-panel').then((m) => m.FieldsAndTagsPanel), { loading: PanelLoading });
const DealsSettings = dynamic(() => import('@/components/settings/deals-settings').then((m) => m.DealsSettings), { loading: PanelLoading });
const MembersTab = dynamic(() => import('@/components/settings/members-tab').then((m) => m.MembersTab), { loading: PanelLoading });
const ApiKeysSettings = dynamic(() => import('@/components/settings/api-keys-settings').then((m) => m.ApiKeysSettings), { loading: PanelLoading });
const ErrorLogsPanel = dynamic(() => import('@/components/settings/error-logs-panel').then((m) => m.ErrorLogsPanel), { loading: PanelLoading });

// `useSearchParams` opts this page out of static prerendering unless it
// sits under a Suspense boundary. Without one, the production build hits
// the "missing Suspense with CSR bailout" error and the whole page bails
// to client-side rendering — shipping a settings screen whose rail never
// wires up its click handlers. You land on the section the URL carried
// (the account-menu Settings link points at `?aba=whatsapp`) and can't
// navigate away. Mirror the login/signup split: a thin wrapper supplies
// the boundary; the inner component reads the query string.
export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsPageInner />
    </Suspense>
  );
}

function SettingsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { defaultCurrency, canEditSettings } = useAuth();
  const { mode } = useTheme();
  const t = useTranslations('Settings');

  // The URL (`?aba=`) is the single source of truth for the active
  // section — deep-linkable, and it keeps the existing links in the
  // app sidebar/header working. Legacy tab values (tags, custom-fields)
  // resolve onto their new home; unknown/empty → the Overview landing.
  const requestedSection = resolveSection(searchParams.get('aba') ?? searchParams.get('tab'));
  const section =
    SECTION_META[requestedSection].adminOnly && !canEditSettings
      ? 'overview'
      : requestedSection;

  const go = (next: SettingsSection) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('tab');
    params.set('aba', SECTION_SLUGS[next]);
    router.replace(`/configuracoes?${params.toString()}`, { scroll: false });
  };

  // Cheap, fetch-free rail hints. The Overview landing carries the
  // full live status/counts; the rail just surfaces the two that are
  // already in context.
  const hints: Partial<Record<SettingsSection, ReactNode>> = useMemo(
    () => ({
      appearance: mode.charAt(0).toUpperCase() + mode.slice(1),
      deals: defaultCurrency,
    }),
    [mode, defaultCurrency],
  );

  const panel: Record<SettingsSection, ReactNode> = {
    overview: <SettingsOverview onSelect={go} />,
    profile: <ProfileForm />,
    security: <SecurityPanel />,
    appearance: <AppearancePanel />,
    notifications: <NotificationsPanel />,
    whatsapp: <WhatsAppConfig />,
    'whatsapp-qr': <WhatsAppQrConnect />,
    'meta-ads': <MetaAdsConfig />,
    templates: <TemplateManager />,
    'quick-replies': <QuickRepliesManager />,
    fields: <FieldsAndTagsPanel />,
    deals: <DealsSettings />,
    members: <MembersTab />,
    api: <ApiKeysSettings />,
    logs: <ErrorLogsPanel />,
  };

  return (
    <div>
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {t('pageTitle')}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('pageDesc')}
        </p>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[236px_minmax(0,1fr)] lg:items-start">
        <SettingsRail active={section} onSelect={go} hints={hints} />
        <div className="min-w-0">{panel[section]}</div>
      </div>
    </div>
  );
}
