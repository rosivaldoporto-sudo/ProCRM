'use client';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Users,
  Tags,
  Filter,
  Upload,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
  List,
  Plus,
  Trash2,
  FileText,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';


type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv' | 'manual_list';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const t = useTranslations('Broadcasts.wizard');

  const OPERATOR_OPTIONS = useMemo<{ value: CustomFieldOperator; label: string }[]>(() => [
    { value: 'is', label: t('selectAudience.operatorIs') },
    { value: 'is_not', label: t('selectAudience.operatorIsNot') },
    { value: 'contains', label: t('selectAudience.operatorContains') },
  ], [t]);

  const audienceOptions = useMemo<{
    type: AudienceType;
    label: string;
    description: string;
    icon: typeof Users;
  }[]>(() => [
    {
      type: 'all',
      label: t('selectAudience.method.all'),
      description: t('selectAudience.allDescLoading'),
      icon: Users,
    },
    {
      type: 'tags',
      label: t('selectAudience.method.tags'),
      description: t('selectAudience.tagDesc'),
      icon: Tags,
    },
    {
      type: 'custom_field',
      label: t('selectAudience.method.customField'),
      description: t('selectAudience.customFieldDesc'),
      icon: Filter,
    },
    {
      type: 'csv',
      label: t('selectAudience.method.csv'),
      description: t('selectAudience.csvDesc'),
      icon: Upload,
    },
    {
      type: 'manual_list',
      label: t('selectAudience.method.manualList'),
      description: t('selectAudience.manualListDesc'),
      icon: List,
    },
  ], [t]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [manualPasteText, setManualPasteText] = useState('');
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        const supabase = createClient();
        const { data } = await supabase.from('tags').select('*').order('name');
        setTags(data ?? []);
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from('custom_fields')
          .select('*')
          .order('field_name');
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      const supabase = createClient();

      // Base query — produces the superset before exclude is applied.
      let baseIds: Set<string> | null = null; // null means "all contacts"

      if (audience.type === 'all') {
        // Handled below — full-table count adjusted by excludes.
      } else if (
        audience.type === 'tags' &&
        audience.tagIds &&
        audience.tagIds.length > 0
      ) {
        const { data } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.tagIds);
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'custom_field' &&
        audience.customField?.fieldId &&
        audience.customField.value
      ) {
        const { fieldId, operator, value } = audience.customField;
        let q = supabase
          .from('contact_custom_values')
          .select('contact_id')
          .eq('custom_field_id', fieldId);
        if (operator === 'is') q = q.eq('value', value);
        else if (operator === 'is_not') q = q.neq('value', value);
        else q = q.ilike('value', `%${value}%`);
        const { data } = await q;
        baseIds = new Set((data ?? []).map((r) => r.contact_id));
      } else if (
        audience.type === 'csv' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else if (
        audience.type === 'manual_list' &&
        audience.csvContacts &&
        audience.csvContacts.length > 0
      ) {
        setEstimatedCount(audience.csvContacts.length);
        return;
      } else {
        // Partially-configured audience — wait for the user to finish.
        setEstimatedCount(null);
        return;
      }

      // Apply exclude tags
      let excludeSet: Set<string> | null = null;
      if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
        const { data: excludeRows } = await supabase
          .from('contact_tags')
          .select('contact_id')
          .in('tag_id', audience.excludeTagIds);
        excludeSet = new Set((excludeRows ?? []).map((r) => r.contact_id));
      }

      if (baseIds) {
        const effective = [...baseIds].filter(
          (id) => !excludeSet?.has(id),
        );
        setEstimatedCount(effective.length);
      } else {
        // "All" — fetch the total, then subtract exclude set if any.
        const { count } = await supabase
          .from('contacts')
          .select('*', { count: 'exact', head: true });
        const total = count ?? 0;
        setEstimatedCount(excludeSet ? Math.max(0, total - excludeSet.size) : total);
      }
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  function addManualContact(name: string, phone: string) {
    if (!phone.trim()) return;
    const current = audience.csvContacts ?? [];
    onUpdate({
      ...audience,
      csvContacts: [...current, { name: name.trim() || undefined, phone: phone.trim() }],
    });
  }

  function removeManualContact(index: number) {
    const current = audience.csvContacts ?? [];
    onUpdate({
      ...audience,
      csvContacts: current.filter((_, i) => i !== index),
    });
  }

  function parsePastedText(text: string) {
    const lines = text.split('\n').filter((l) => l.trim());
    const contacts: { phone: string; name?: string }[] = [];
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length >= 2 && parts[1]) {
        contacts.push({ name: parts[0] || undefined, phone: parts[1] });
      } else if (parts.length === 1 && parts[0]) {
        contacts.push({ phone: parts[0] });
      }
    }
    const current = audience.csvContacts ?? [];
    onUpdate({
      ...audience,
      csvContacts: [...current, ...contacts],
    });
    setManualPasteText('');
  }

  function parseBroadcastCsv(text: string): { phone: string; name?: string }[] {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];

    const rawHeaders = lines[0];
    const delimiter = rawHeaders.includes(';') ? ';' : ',';
    const headers = rawHeaders
      .split(delimiter)
      .map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

    const phoneKeywords = ['phone', 'telefone', 'celular', 'whatsapp', 'mobile', 'cell'];
    const nameKeywords = ['name', 'nome', 'contact', 'contato', 'full_name', 'nome_completo'];

    const phoneIdx = headers.findIndex((h) => phoneKeywords.some((kw) => h.includes(kw)));
    const nameIdx = headers.findIndex((h) => nameKeywords.some((kw) => h.includes(kw)));

    if (phoneIdx === -1) {
      // No phone column found — try treating each line as a bare phone number
      return lines
        .slice(1)
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map((phone) => ({ phone }));
    }

    const contacts: { phone: string; name?: string }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const values = parseCsvLineGeneric(line, delimiter);
      const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
      if (!phone) continue;

      contacts.push({
        phone,
        name:
          nameIdx >= 0
            ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
            : undefined,
      });
    }

    return contacts;
  }

  function parseCsvLineGeneric(line: string, delimiter: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === delimiter && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  }

  function handleCsvFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;

    setCsvFileName(selected.name);
    setCsvError(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text !== 'string') return;

      const contacts = parseBroadcastCsv(text);
      if (contacts.length === 0) {
        setCsvError(t('selectAudience.errorCsvParse'));
        return;
      }

      onUpdate({ ...audience, csvContacts: contacts });
    };
    reader.onerror = () => {
      setCsvError(t('selectAudience.errorCsvParse'));
    };
    reader.readAsText(selected);
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0) ||
    (audience.type === 'manual_list' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('selectAudience.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('selectAudience.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option: { type: AudienceType; label: string; description: string; icon: typeof Users }) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' || option.type === 'manual_list'
                      ? audience.csvContacts
                      : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card/50 hover:border-border'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">{t('selectAudience.selectTags')}</p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.noTagsFound')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">{t('selectAudience.method.customField')}</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t('selectAudience.errorLoadFields')}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">{t('selectAudience.selectField')}</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op: { value: CustomFieldOperator; label: string }) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder={t('selectAudience.valuePlaceholder')}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {audience.type === 'manual_list' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">{t('selectAudience.manualListTitle')}</p>
            <Dialog open={manualDialogOpen} onOpenChange={setManualDialogOpen}>
              <DialogTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-border text-muted-foreground"
                  />
                }
              >
                <Plus className="h-4 w-4" />
                {t('selectAudience.manualListAddBtn')}
              </DialogTrigger>
              <DialogContent className="border-border bg-popover sm:max-w-lg">
                <DialogHeader>
                  <DialogTitle className="text-popover-foreground">{t('selectAudience.manualListTitle')}</DialogTitle>
                  <DialogDescription className="text-muted-foreground">
                    {t('selectAudience.manualListPasteHint')}
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-foreground">{t('selectAudience.manualListPasteHint')}</p>
                    <textarea
                      value={manualPasteText}
                      onChange={(e) => setManualPasteText(e.target.value)}
                      placeholder={t('selectAudience.manualListPastePlaceholder')}
                      rows={4}
                      className="w-full rounded-lg border border-border bg-muted p-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
                    />
                    <Button
                      size="sm"
                      onClick={() => parsePastedText(manualPasteText)}
                      disabled={!manualPasteText.trim()}
                      className="mt-2 bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      {t('selectAudience.manualListAddToList')}
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted-foreground">ou</span>
                    <div className="h-px flex-1 bg-border" />
                  </div>
                  <div className="flex items-end gap-2">
                    <div className="flex-1 space-y-1">
                      <label className="text-xs text-muted-foreground">{t('selectAudience.manualListNamePlaceholder')}</label>
                      <Input
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                        placeholder={t('selectAudience.manualListNamePlaceholder')}
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <label className="text-xs text-muted-foreground">{t('selectAudience.manualListPhonePlaceholder')}</label>
                      <Input
                        value={manualPhone}
                        onChange={(e) => setManualPhone(e.target.value)}
                        placeholder={t('selectAudience.manualListPhonePlaceholder')}
                        className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                      />
                    </div>
                    <Button
                      size="sm"
                      onClick={() => {
                        addManualContact(manualName, manualPhone);
                        setManualName('');
                        setManualPhone('');
                      }}
                      disabled={!manualPhone.trim()}
                      className="bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>

          {audience.csvContacts && audience.csvContacts.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('selectAudience.manualListCount', { count: audience.csvContacts.length })}
              </p>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {audience.csvContacts.map((contact, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-foreground truncate">
                        {contact.name || '(sem nome)'}
                      </p>
                      <p className="text-xs text-muted-foreground">{contact.phone}</p>
                    </div>
                    <button
                      onClick={() => removeManualContact(index)}
                      className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              {audience.csvContacts.length > 0 && (
                <button
                  onClick={() => onUpdate({ ...audience, csvContacts: [] })}
                  className="text-xs text-red-400 hover:text-red-300"
                >
                  {t('selectAudience.manualListClear')}
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('selectAudience.manualListEmpty')}</p>
          )}
        </div>
      )}

      {audience.type === 'csv' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium text-foreground">{t('selectAudience.method.csv')}</p>
            {audience.csvContacts && audience.csvContacts.length > 0 && (
              <button
                onClick={() => {
                  onUpdate({ ...audience, csvContacts: [] });
                  setCsvFileName(null);
                  setCsvError(null);
                  if (fileInputRef.current) fileInputRef.current.value = '';
                }}
                className="text-xs text-red-400 hover:text-red-300"
              >
                {t('selectAudience.manualListClear')}
              </button>
            )}
          </div>

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ')
                fileInputRef.current?.click();
            }}
            className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-background/40 p-5 transition-all hover:border-primary/40 hover:bg-background/70"
          >
            {csvFileName ? (
              <>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/25">
                  <FileText className="h-5 w-5 text-primary" />
                </div>
                <p className="max-w-full truncate px-2 text-sm font-medium text-foreground" title={csvFileName}>
                  {csvFileName}
                </p>
              </>
            ) : (
              <>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/80 ring-1 ring-border/80 transition-colors">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">{t('selectAudience.uploadCsv')}</p>
                <p className="text-[11px] text-muted-foreground">{t('selectAudience.csvFormatDesc')}</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleCsvFileUpload}
            className="hidden"
          />

          {csvError && (
            <p className="mt-2 text-xs text-red-400">{csvError}</p>
          )}

          {audience.csvContacts && audience.csvContacts.length > 0 && (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-muted-foreground">
                {t('selectAudience.csvContactsFound', { count: audience.csvContacts.length })}
              </p>
              <div className="max-h-48 space-y-1 overflow-y-auto">
                {audience.csvContacts.slice(0, 50).map((contact, index) => (
                  <div
                    key={index}
                    className="flex items-center justify-between rounded-lg border border-border bg-muted/50 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">
                        {contact.name || '(sem nome)'}
                      </p>
                      <p className="text-xs text-muted-foreground">{contact.phone}</p>
                    </div>
                    <button
                      onClick={() => {
                        const updated = audience.csvContacts?.filter((_, i) => i !== index) ?? [];
                        onUpdate({ ...audience, csvContacts: updated });
                      }}
                      className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
              {audience.csvContacts.length > 50 && (
                <p className="text-center text-xs text-muted-foreground">
                  +{audience.csvContacts.length - 50} more
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-sm font-medium text-foreground">
            {t('selectAudience.excludeTags')}
          </p>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('selectAudience.noTagsFound')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Audience Summary */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2 text-sm font-medium text-foreground">{t('selectAudience.audienceSummary')}</p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">{t('selectAudience.calculating')}</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm text-foreground">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">{t('selectAudience.estimatedRecipients')}</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('selectAudience.selectAudienceToEstimate')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
