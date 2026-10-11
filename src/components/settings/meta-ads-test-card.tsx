'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Send,
  ExternalLink,
  CheckCircle2,
  XCircle,
  FlaskConical,
} from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

interface Props {
  pixelId: string;
  testEventCode: string;
  hasToken: boolean;
}

interface TestResult {
  success: boolean;
  events_received?: number;
  fbtrace_id?: string | null;
  messages?: string[];
  event_id?: string;
  event_name?: string;
  pixel_id?: string;
  test_mode?: boolean;
  test_event_code?: string | null;
  error?: string;
}

export function MetaAdsTestCard({ pixelId, testEventCode, hasToken }: Props) {
  const [eventName, setEventName] = useState('Lead');
  const [email, setEmail] = useState('teste@example.com');
  const [phone, setPhone] = useState('5511999999999');
  const [name, setName] = useState('Lead Teste');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const canTest = !!pixelId.trim() && hasToken;

  async function handleSend() {
    setSending(true);
    setResult(null);
    try {
      const res = await fetch('/api/meta-ads/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event_name: eventName,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          full_name: name.trim() || undefined,
          event_source_url:
            typeof window !== 'undefined' ? window.location.href : undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as TestResult & {
        error?: string;
      };
      if (!res.ok) {
        setResult({ success: false, error: j.error ?? 'Falha no envio' });
        toast.error(j.error ?? 'Falha no envio de teste');
        return;
      }
      setResult({ ...j, success: true });
      toast.success(
        j.test_mode
          ? 'Evento de teste enviado — confira a aba Test Events'
          : 'Evento enviado em modo produção'
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Falha no envio';
      setResult({ success: false, error: msg });
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="border-dashed">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <FlaskConical className="h-4 w-4" /> Enviar evento de teste
            </CardTitle>
            <CardDescription>
              Salve as credenciais acima e envie um evento CAPI de teste. Com
              código de teste, ele aparece em Events Manager → Test Events sem
              sujar os dados de produção.
            </CardDescription>
          </div>
          <a
            href="https://business.facebook.com/events_manager2"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
          >
            Abrir Events Manager <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge variant="outline">Pixel: {pixelId.trim() || '—'}</Badge>
          <Badge variant="outline">
            Código de teste: {testEventCode.trim() || '—'}
          </Badge>
          <Badge variant="outline">
            {hasToken ? 'Token: configurado' : 'Token: ausente'}
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Evento</Label>
            <Select value={eventName} onValueChange={(v) => setEventName(v ?? "Lead")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Lead">Lead</SelectItem>
                <SelectItem value="CompleteRegistration">
                  CompleteRegistration
                </SelectItem>
                <SelectItem value="Schedule">Schedule</SelectItem>
                <SelectItem value="ViewContent">ViewContent</SelectItem>
                <SelectItem value="Contact">Contact</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Nome</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Lead Teste"
            />
          </div>
          <div className="space-y-2">
            <Label>E-mail de teste</Label>
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teste@example.com"
            />
          </div>
          <div className="space-y-2">
            <Label>Telefone de teste (com DDI)</Label>
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="5511999999999"
            />
          </div>
        </div>

        {!canTest && (
          <p className="text-xs text-amber-400">
            Salve o Pixel ID e o token acima antes de enviar o teste.
          </p>
        )}

        <Button onClick={handleSend} disabled={sending || !canTest}>
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          {sending ? 'Enviando…' : 'Enviar evento de teste'}
        </Button>

        {result && (
          <div
            className={`rounded border p-3 text-sm ${
              result.success
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-red-500/30 bg-red-500/10'
            }`}
          >
            {result.success ? (
              <div className="space-y-1">
                <p className="flex items-center gap-2 font-medium text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Evento {result.event_name} recebido pela Meta
                  {result.test_mode ? ' (modo teste)' : ' (modo produção)'}
                </p>
                <p className="font-mono text-xs break-all">
                  fbtrace_id: {result.fbtrace_id ?? '—'} · event_id:{' '}
                  {result.event_id ?? '—'}
                </p>
                <p className="text-muted-foreground text-xs">
                  Confira em Events Manager → Test Events
                  {result.test_event_code
                    ? ` com o código ${result.test_event_code}`
                    : ''}
                  .
                </p>
              </div>
            ) : (
              <p className="flex items-start gap-2 text-red-300">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{result.error ?? 'Falha no envio'}</span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
