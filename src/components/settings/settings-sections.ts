import {
  BellRing,
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  QrCode,
  ScrollText,
  Shield,
  Tags,
  Target,
  User,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'notifications',
  'whatsapp',
  'whatsapp-qr',
  'meta-ads',
  'templates',
  'quick-replies',
  'fields',
  'deals',
  'members',
  'api',
  'logs',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
  adminOnly?: boolean;
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Seu perfil', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login e segurança', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Aparência', icon: Palette, group: 'account' },
  notifications: { id: 'notifications', label: 'Notificações', icon: BellRing, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'WhatsApp', icon: PlugZap, group: 'workspace', adminOnly: true },
  'whatsapp-qr': { id: 'whatsapp-qr', label: 'QR Code do WhatsApp', icon: QrCode, group: 'workspace', adminOnly: true },
  'meta-ads': { id: 'meta-ads', label: 'Meta Ads', icon: Target, group: 'workspace', adminOnly: true },
  templates: { id: 'templates', label: 'Modelos', icon: FileText, group: 'workspace', adminOnly: true },
  'quick-replies': { id: 'quick-replies', label: 'Respostas rápidas', icon: Zap, group: 'workspace' },
  fields: { id: 'fields', label: 'Campos e etiquetas', icon: Tags, group: 'workspace', adminOnly: true },
  deals: { id: 'deals', label: 'Negócios e moeda', icon: Coins, group: 'workspace', adminOnly: true },
  members: { id: 'members', label: 'Membros da equipe', icon: UsersRound, group: 'workspace', adminOnly: true },
  api: { id: 'api', label: 'Chaves de API', icon: KeyRound, group: 'workspace', adminOnly: true },
  logs: { id: 'logs', label: 'Registros de erro', icon: ScrollText, group: 'workspace', adminOnly: true },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'Conta', group: 'account' },
  { label: 'Espaço de trabalho', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
