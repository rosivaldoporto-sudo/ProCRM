import type { AutomationTriggerType } from '@/types'

export interface TriggerMeta {
  /** Translation key suffix — use t(`triggers.${key}.label`) in UI. */
  i18nKey: string
  /** Tailwind classes for the Badge pill on the list row. */
  pillClass: string
}

export const TRIGGER_META: Record<AutomationTriggerType, TriggerMeta> = {
  new_message_received: {
    i18nKey: 'new_message_received',
    pillClass: 'border-blue-500/30 bg-blue-500/10 text-blue-300',
  },
  first_inbound_message: {
    i18nKey: 'first_inbound_message',
    pillClass: 'border-teal-500/30 bg-teal-500/10 text-teal-300',
  },
  keyword_match: {
    i18nKey: 'keyword_match',
    pillClass: 'border-purple-500/30 bg-purple-500/10 text-purple-300',
  },
  new_contact_created: {
    i18nKey: 'new_contact_created',
    pillClass: 'border-primary/30 bg-primary/10 text-primary',
  },
  conversation_assigned: {
    i18nKey: 'conversation_assigned',
    pillClass: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300',
  },
  tag_added: {
    i18nKey: 'tag_added',
    pillClass: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  },
  time_based: {
    i18nKey: 'time_based',
    pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  },
  interactive_reply: {
    i18nKey: 'interactive_reply',
    pillClass: 'border-pink-500/30 bg-pink-500/10 text-pink-300',
  },
}

export function triggerMeta(t: AutomationTriggerType | string): TriggerMeta {
  return (
    TRIGGER_META[t as AutomationTriggerType] ?? {
      i18nKey: t,
      pillClass: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
    }
  )
}

/**
 * Format a relative timestamp using translation keys.
 * Pass a `t` function from the "Automations.list" or "Automations.logs" namespace.
 */
export function formatRelative(
  iso: string | null | undefined,
  t: (key: string, params?: Record<string, string | number | Date>) => string,
): string {
  if (!iso) return t('relativeNever')
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return t('relativeNever')
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('relativeJustNow')
  if (diffSec < 3600) return t('relativeMinutesAgo', { count: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('relativeHoursAgo', { count: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('relativeDaysAgo', { count: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
