'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Loader2, Send, Phone, User, MessageSquare, Smartphone } from 'lucide-react';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConversationCreated: (conversationId: string) => void;
}

type ChannelSource = 'whatsapp' | 'uazapi';

export function NewConversationDialog({
  open,
  onOpenChange,
  onConversationCreated,
}: NewConversationDialogProps) {
  const t = useTranslations('Inbox.newConversation');

  const [channelSource, setChannelSource] = useState<ChannelSource>('whatsapp');
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setChannelSource('whatsapp');
      setLoadingTemplates(true);
      setSelectedTemplate(null);
      setParams([]);
      setPhone('');
      setName('');
      const supabase = createClient();
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .eq('status', 'APPROVED')
        .order('name');
      if (!cancelled) {
        setTemplates(data ?? []);
        setLoadingTemplates(false);
      }
    })();

    return () => { cancelled = true; };
  }, [open]);

  function getBodyVars(template: MessageTemplate): number[] {
    const indices = extractVariableIndices(template.body_text);
    if (template.header_type === 'text' && template.header_content) {
      const headerVars = extractVariableIndices(template.header_content);
      return [...headerVars, ...indices];
    }
    return indices;
  }

  function handleTemplateSelect(template: MessageTemplate) {
    setSelectedTemplate(template);
    setParams(new Array(getBodyVars(template).length).fill(''));
  }

  async function handleStart() {
    if (!phone.trim()) return;
    if (channelSource === 'whatsapp' && !selectedTemplate) return;

    setSending(true);
    try {
      const body: Record<string, unknown> = {
        phone: phone.trim(),
        name: name.trim() || undefined,
        source: channelSource,
      };

      if (channelSource === 'whatsapp' && selectedTemplate) {
        body.template_name = selectedTemplate.name;
        body.template_language = selectedTemplate.language;
        body.template_params = params;
      }

      const res = await fetch('/api/inbox/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to start conversation');
        return;
      }

      toast.success(t('started'));
      onOpenChange(false);
      onConversationCreated(data.conversation_id);
    } catch {
      toast.error('Network error');
    } finally {
      setSending(false);
    }
  }

  const canStart = phone.trim() && (channelSource === 'uazapi' || (channelSource === 'whatsapp' && selectedTemplate));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t('description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Channel selector */}
          <div className="space-y-2">
            <Label className="text-foreground">{t('channelLabel')}</Label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setChannelSource('whatsapp'); setSelectedTemplate(null); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm transition-all",
                  channelSource === 'whatsapp'
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <MessageSquare className="h-4 w-4" />
                WhatsApp
              </button>
              <button
                type="button"
                onClick={() => { setChannelSource('uazapi'); setSelectedTemplate(null); }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-2 rounded-lg border px-4 py-3 text-sm transition-all",
                  channelSource === 'uazapi'
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                <Smartphone className="h-4 w-4" />
                Uazapi
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <Label className="text-foreground">{t('phoneLabel')}</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+5511999999999"
                className="border-border bg-muted pl-9 text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Label className="text-foreground">{t('nameLabel')}</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                className="border-border bg-muted pl-9 text-foreground placeholder:text-muted-foreground"
              />
            </div>
          </div>

          {channelSource === 'whatsapp' && (
            <div className="space-y-2">
              <Label className="text-foreground">{t('templateLabel')}</Label>
              {loadingTemplates ? (
                <div className="flex items-center gap-2 py-4">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">{t('loadingTemplates')}</span>
                </div>
              ) : templates.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4">{t('noTemplates')}</p>
              ) : (
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      onClick={() => handleTemplateSelect(template)}
                      className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-all ${
                        selectedTemplate?.id === template.id
                          ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                          : 'text-foreground hover:bg-muted'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium truncate">{template.name}</span>
                        <Badge variant="outline" className="shrink-0 ml-2 text-[10px] border-border text-muted-foreground">
                          {template.language}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
                        {template.body_text?.replace(/\{\{\d+\}\}/g, '…')}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {channelSource === 'whatsapp' && selectedTemplate && getBodyVars(selectedTemplate).length > 0 && (
            <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
              <p className="text-sm font-medium text-foreground">{t('fillVariables')}</p>
              {selectedTemplate.header_type === 'text' && selectedTemplate.header_content && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('headerVariable')}</Label>
                  <Input
                    value={params[0] || ''}
                    onChange={(e) => {
                      const next = [...params];
                      next[0] = e.target.value;
                      setParams(next);
                    }}
                    placeholder={t('variablePlaceholder')}
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              )}
              {getBodyVars(selectedTemplate).map((_, i) => {
                const actualIndex = selectedTemplate.header_type === 'text' && selectedTemplate.header_content ? i + 1 : i;
                return (
                  <div key={i} className="space-y-1">
                    <Label className="text-xs text-muted-foreground">
                      {t('variable')} {actualIndex + 1}
                    </Label>
                    <Input
                      value={params[actualIndex] || ''}
                      onChange={(e) => {
                        const next = [...params];
                        next[actualIndex] = e.target.value;
                        setParams(next);
                      }}
                      placeholder={t('variablePlaceholder')}
                      className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
            className="border-border text-muted-foreground"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={handleStart}
            disabled={!canStart || sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {t('start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
