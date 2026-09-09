'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';
import { dedupeByPhone } from '@/lib/contacts/dedupe';
import { toast } from 'sonner';
import type { Tag } from '@/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2,
  AlertTriangle,
  CheckCircle,
  Trash2,
  List,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ParsedContact {
  phone: string;
  name?: string;
  normalized: string;
}

interface ExistingContactInfo {
  phone: string;
  name?: string;
  normalized: string;
}

interface BulkAddModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

export function BulkAddContactsModal({
  open,
  onOpenChange,
  onImported,
}: BulkAddModalProps) {
  const t = useTranslations('Contacts.bulkAdd');
  const supabase = createClient();
  const { accountId } = useAuth();

  const [pasteText, setPasteText] = useState('');
  const [parsedContacts, setParsedContacts] = useState<ParsedContact[]>([]);
  const [existingContacts, setExistingContacts] = useState<ExistingContactInfo[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [result, setResult] = useState<{
    imported: number;
    skipped: number;
    failed: number;
  } | null>(null);

  // Tags
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);

  useEffect(() => {
    if (open) {
      setPasteText('');
      setParsedContacts([]);
      setExistingContacts([]);
      setResult(null);
      setSelectedTagIds([]);
      fetchTags();
    }
  }, [open]);

  async function fetchTags() {
    setLoadingTags(true);
    const { data } = await supabase
      .from('tags')
      .select('*')
      .order('name');
    if (data) setTags(data);
    setLoadingTags(false);
  }

  function parsePastedText(text: string) {
    const lines = text.split('\n').filter((l) => l.trim());
    const contacts: ParsedContact[] = [];
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length >= 2 && parts[1]) {
        const phone = parts[1];
        const normalized = normalizePhone(phone);
        if (normalized) {
          contacts.push({
            name: parts[0] || undefined,
            phone,
            normalized,
          });
        }
      } else if (parts.length === 1 && parts[0]) {
        const phone = parts[0];
        const normalized = normalizePhone(phone);
        if (normalized) {
          contacts.push({ phone, normalized });
        }
      }
    }

    // Deduplicate within the pasted list
    const { unique } = dedupeByPhone(contacts);
    setParsedContacts(unique);
    setExistingContacts([]);
    setResult(null);
  }

  // Check for duplicates when parsedContacts change
  const checkDuplicates = useCallback(async () => {
    if (parsedContacts.length === 0 || !accountId) {
      setExistingContacts([]);
      return;
    }

    setIsChecking(true);
    try {
      const LOOKUP_CHUNK = 200;
      const found: ExistingContactInfo[] = [];
      const normalizedPhones = parsedContacts.map((c) => c.normalized);

      for (let i = 0; i < normalizedPhones.length; i += LOOKUP_CHUNK) {
        const chunk = normalizedPhones.slice(i, i + LOOKUP_CHUNK);

        const { data } = await supabase
          .from('contacts')
          .select('phone, name, phone_normalized')
          .eq('account_id', accountId)
          .in('phone_normalized', chunk);

        for (const row of data ?? []) {
          const normalized = (row as { phone_normalized: string | null }).phone_normalized;
          if (normalized) {
            const csvRow = parsedContacts.find(
              (c) => c.normalized === normalized
            );
            if (csvRow) {
              found.push({
                phone: csvRow.phone,
                name: csvRow.name ?? (row as { name?: string }).name ?? undefined,
                normalized,
              });
            }
          }
        }
      }

      // Deduplicate by normalized phone
      const seen = new Set<string>();
      const unique = found.filter((c) => {
        if (seen.has(c.normalized)) return false;
        seen.add(c.normalized);
        return true;
      });
      setExistingContacts(unique);
    } finally {
      setIsChecking(false);
    }
  }, [parsedContacts, accountId, supabase]);

  useEffect(() => {
    checkDuplicates();
  }, [checkDuplicates]);

  function discardExisting(normalized: string) {
    setExistingContacts((prev) => prev.filter((c) => c.normalized !== normalized));
  }

  function discardAllExisting() {
    setExistingContacts([]);
  }

  async function handleImport() {
    // Filter out existing contacts
    const existingNormalized = new Set(existingContacts.map((c) => c.normalized));
    const toImport = parsedContacts.filter(
      (c) => !existingNormalized.has(c.normalized)
    );

    if (toImport.length === 0) {
      toast.info(t('toastNothingToImport'));
      return;
    }

    setIsImporting(true);
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');
      if (!accountId) throw new Error('Your profile is not linked to an account.');

      let imported = 0;
      let skipped = 0;
      let failed = 0;

      // Insert contacts in chunks
      const chunkSize = 50;
      for (let i = 0; i < toImport.length; i += chunkSize) {
        const chunk = toImport.slice(i, i + chunkSize);
        const rows = chunk.map((c) => ({
          user_id: user.id,
          account_id: accountId,
          phone: c.phone,
          name: c.name || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id');

        if (error) {
          // Retry individually
          for (let j = 0; j < rows.length; j++) {
            const { data: singleData, error: singleErr } = await supabase
              .from('contacts')
              .insert(rows[j])
              .select('id')
              .single();

            if (!singleErr && singleData) {
              imported++;
              // Assign tags
              if (selectedTagIds.length > 0) {
                const tagRows = selectedTagIds.map((tagId) => ({
                  contact_id: singleData.id,
                  tag_id: tagId,
                }));
                await supabase.from('contact_tags').upsert(tagRows, {
                  onConflict: 'contact_id,tag_id',
                  ignoreDuplicates: true,
                });
              }
            } else if (
              singleErr &&
              (singleErr as { code?: string }).code === '23505'
            ) {
              skipped++;
            } else {
              failed++;
            }
          }
        } else {
          const inserted = data ?? [];
          imported += inserted.length;

          // Assign tags to all inserted contacts
          if (selectedTagIds.length > 0 && inserted.length > 0) {
            const tagRows = inserted.flatMap((c) =>
              selectedTagIds.map((tagId) => ({
                contact_id: c.id,
                tag_id: tagId,
              }))
            );
            await supabase.from('contact_tags').upsert(tagRows, {
              onConflict: 'contact_id,tag_id',
              ignoreDuplicates: true,
            });
          }
        }
      }

      setResult({ imported, skipped, failed });

      if (imported > 0) {
        toast.success(t('toastImported', { count: imported }));
        onImported();
      }
      if (skipped > 0) {
        toast.info(t('toastSkipped', { count: skipped }));
      }
      if (failed > 0) {
        toast.error(t('toastFailed', { count: failed }));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('toastError');
      toast.error(message);
    } finally {
      setIsImporting(false);
    }
  }

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
  }

  const newContactsCount = parsedContacts.length - existingContacts.length;
  const hasNewContacts = newContactsCount > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,720px)] flex-col gap-0 overflow-hidden border-border/80 bg-popover p-0 text-popover-foreground sm:max-w-2xl">
        <div className="shrink-0 space-y-4 border-b border-border/80 px-6 pt-6 pb-5">
          <DialogHeader className="gap-1.5">
            <DialogTitle className="text-lg text-popover-foreground">
              {t('title')}
            </DialogTitle>
            <DialogDescription className="leading-relaxed text-muted-foreground">
              {t('desc')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label className="text-muted-foreground">{t('pasteLabel')}</Label>
            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={t('pastePlaceholder')}
              rows={5}
              className="w-full rounded-lg border border-border bg-muted p-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
            />
            <Button
              size="sm"
              onClick={() => parsePastedText(pasteText)}
              disabled={!pasteText.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <List className="h-4 w-4" />
              {t('parseBtn')}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
          {parsedContacts.length > 0 && !result && (
            <div className="space-y-4">
              {/* Tags selection */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('tagsLabel')}</Label>
                {loadingTags ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Loader2 className="size-3 animate-spin" />
                    {t('loadingTags')}
                  </div>
                ) : tags.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('noTags')}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => {
                      const selected = selectedTagIds.includes(tag.id);
                      return (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => toggleTag(tag.id)}
                          className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors cursor-pointer ${
                            selected
                              ? 'ring-2 ring-primary ring-offset-1 ring-offset-border'
                              : 'opacity-60 hover:opacity-100'
                          }`}
                          style={{
                            backgroundColor: tag.color + '20',
                            color: tag.color,
                            borderColor: tag.color,
                          }}
                        >
                          {tag.name}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Existing contacts warning */}
              {existingContacts.length > 0 && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-400" />
                      <p className="text-sm font-medium text-foreground">
                        {t('existingContactsTitle', {
                          count: existingContacts.length,
                        })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={discardAllExisting}
                      className="border-amber-500/30 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
                    >
                      {t('discardAllExisting')}
                    </Button>
                  </div>
                  <p className="mb-2 text-xs text-muted-foreground">
                    {t('existingContactsDesc')}
                  </p>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {existingContacts.map((contact) => (
                      <div
                        key={contact.normalized}
                        className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-1.5"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-foreground">
                            {contact.name || '(sem nome)'}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {contact.phone}
                          </p>
                        </div>
                        <button
                          onClick={() => discardExisting(contact.normalized)}
                          className="ml-2 shrink-0 rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400"
                          title={t('discardExisting')}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Checking indicator */}
              {isChecking && (
                <div className="flex items-center gap-2 rounded-xl border border-border bg-card/50 p-3">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-xs text-muted-foreground">
                    {t('checkingDuplicates')}
                  </span>
                </div>
              )}

              {/* New contacts preview */}
              {newContactsCount > 0 && (
                <div className="rounded-xl border border-border bg-card/50 p-4">
                  <div className="mb-2 flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-400" />
                    <p className="text-sm font-medium text-foreground">
                      {t('newContactsTitle', { count: newContactsCount })}
                    </p>
                  </div>
                  <div className="max-h-32 space-y-1 overflow-y-auto">
                    {parsedContacts
                      .filter(
                        (c) =>
                          !existingContacts.some(
                            (e) => e.normalized === c.normalized
                          )
                      )
                      .slice(0, 20)
                      .map((contact) => (
                        <div
                          key={contact.normalized}
                          className="flex items-center rounded-lg border border-border bg-muted/50 px-3 py-1.5"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm text-foreground">
                              {contact.name || '(sem nome)'}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {contact.phone}
                            </p>
                          </div>
                        </div>
                      ))}
                    {newContactsCount > 20 && (
                      <p className="text-center text-xs text-muted-foreground">
                        +{newContactsCount - 20} {t('moreContacts')}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-xl border border-border bg-background/50 p-4">
              <p className="text-sm font-medium text-popover-foreground">
                {t('importComplete')}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                {result.imported > 0 && (
                  <div className="text-primary flex items-center gap-1.5 text-sm">
                    <CheckCircle className="size-4 shrink-0" />
                    {t('resultImported', { count: result.imported })}
                  </div>
                )}
                {result.skipped > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultSkipped', { count: result.skipped })}
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-sm text-red-400">
                    <AlertTriangle className="size-4 shrink-0" />
                    {t('resultFailed', { count: result.failed })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-0 shrink-0 gap-2 border-t border-border/80 bg-background/50 px-6 py-4 sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {result ? t('close') : t('cancel')}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={!hasNewContacts || isImporting || isChecking}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {isImporting && <Loader2 className="size-4 animate-spin" />}
              {t('importBtn', { count: newContactsCount })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
