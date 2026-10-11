"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Save,
  Send,
  ExternalLink,
  CheckCircle2,
  XCircle,
  FlaskConical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type { LeadFormMeta } from "@/lib/lead-forms/types";

interface Props {
  formId: string;
  meta: LeadFormMeta;
  onChange: (meta: LeadFormMeta) => void;
  onSaveForm: () => Promise<void> | void;
  savingForm: boolean;
}

interface GlobalConfig {
  configured?: boolean;
  pixel_id?: string | null;
  test_event_code?: string | null;
  has_access_token?: boolean;
  capi_trigger_stage_ids?: string[];
}

const TEST_EVENTS = [
  { value: "Lead", label: "Lead — resposta completa" },
  { value: "CompleteRegistration", label: "CompleteRegistration — qualificado" },
  { value: "Schedule", label: "Schedule — reunião agendada" },
  { value: "ViewContent", label: "ViewContent — visualização" },
  { value: "Contact", label: "Contact — contato" },
] as const;

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

const EVENT_TOGGLES = [
  ["fire_view_content", "ViewContent — visualização", "Dispara no browser quando o formulário é exibido."],
  ["fire_lead", "Lead — resposta completa", "Browser + CAPI com o mesmo event_id (deduplicado pela Meta)."],
  ["fire_complete_registration", "CompleteRegistration — qualificado", "CAPI quando o lead atinge o score de qualificação."],
  ["fire_schedule", "Schedule — reunião agendada", "Browser + CAPI quando o lead agenda."],
  ["fire_qualified", "QualifiedLead (Lead + lead_quality=qualified)", "CAPI extra para otimizar campanhas para leads qualificados."],
] as const;

export function LeadFormMetaTab({ formId, meta, onChange, onSaveForm, savingForm }: Props) {
  void formId;
  // ---- Global (CAPI server-side) ----
  const [loadingGlobal, setLoadingGlobal] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [globalPixel, setGlobalPixel] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState("");
  const [testCode, setTestCode] = useState("");
  const [stageIds, setStageIds] = useState<string[]>([]);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- Test send ----
  const [testEvent, setTestEvent] = useState<string>("Lead");
  const [testEmail, setTestEmail] = useState("teste@example.com");
  const [testPhone, setTestPhone] = useState("5511999999999");
  const [testName, setTestName] = useState("Lead Teste");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const res = await fetch("/api/meta-ads/config", { cache: "no-store" });
        if (res.status === 403) {
          if (!cancelled) setForbidden(true);
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const j = (await res.json()) as GlobalConfig;
        if (!cancelled) {
          setGlobalPixel(j.pixel_id ?? "");
          setTestCode(j.test_event_code ?? "");
          setHasToken(!!j.has_access_token);
          setStageIds(j.capi_trigger_stage_ids ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Falha ao carregar config Meta";
          setLoadError(msg);
        }
      } finally {
        if (!cancelled) setLoadingGlobal(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function retryLoad() {
    setLoadingGlobal(true);
    setLoadError(null);
    setForbidden(false);
    (async () => {
      try {
        const res = await fetch("/api/meta-ads/config", { cache: "no-store" });
        if (res.status === 403) {
          setForbidden(true);
          return;
        }
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        const j = (await res.json()) as GlobalConfig;
        setGlobalPixel(j.pixel_id ?? "");
        setTestCode(j.test_event_code ?? "");
        setHasToken(!!j.has_access_token);
        setStageIds(j.capi_trigger_stage_ids ?? []);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Falha ao carregar config Meta");
      } finally {
        setLoadingGlobal(false);
      }
    })();
  }

  async function handleSaveGlobal() {
    setSavingGlobal(true);
    try {
      const res = await fetch("/api/meta-ads/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pixel_id: globalPixel.trim() || null,
          ...(token.trim() ? { access_token: token.trim() } : {}),
          test_event_code: testCode.trim() || null,
          // Preserva o gatilho de lead qualificado — o endpoint zeraria se omitido.
          capi_trigger_stage_ids: stageIds.length > 0 ? stageIds : [],
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? "save failed");
      setToken("");
      setHasToken(true);
      toast.success("Configuração Meta salva");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSavingGlobal(false);
    }
  }

  async function handleSendTest() {
    setSending(true);
    setResult(null);
    try {
      // Pixel efetivo: override do formulário vence o global.
      const effectivePixel = (meta.pixel_id?.trim() || globalPixel.trim()) ?? "";
      const res = await fetch("/api/meta-ads/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: testEvent,
          email: testEmail.trim() || undefined,
          phone: testPhone.trim() || undefined,
          full_name: testName.trim() || undefined,
          pixel_id: meta.pixel_id?.trim() || undefined,
          event_source_url:
            typeof window !== "undefined" ? window.location.href : undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as TestResult & { error?: string };
      if (!res.ok) {
        setResult({ success: false, error: j.error ?? "Falha no envio", pixel_id: effectivePixel });
        toast.error(j.error ?? "Falha no envio de teste");
        return;
      }
      setResult({ ...j, success: true });
      toast.success(
        j.test_mode
          ? "Evento de teste enviado — confira a aba Test Events"
          : "Evento enviado em modo produção"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Falha no envio";
      setResult({ success: false, error: msg });
      toast.error(msg);
    } finally {
      setSending(false);
    }
  }

  const effectivePixel = meta.pixel_id?.trim() || globalPixel.trim() || "—";
  const effectiveTestCode = testCode.trim() || "—";
  const canTest = !loadingGlobal && !forbidden && !!globalPixel.trim() && hasToken;

  return (
    <div className="space-y-3">
      {/* ---------- 1. Conexão global ---------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>1 · Conexão Meta (CAPI server-side)</CardTitle>
              <CardDescription>
                Token de acesso do app Meta para a Conversions API. Onde gerar:
                Events Manager → Configurações do conjunto de dados → API de
                Conversões → Gerar token. Sem token, só o pixel browser dispara;
                o CAPI é pulado em silêncio.
              </CardDescription>
            </div>
            {!loadingGlobal && !forbidden && (
              <Badge variant="outline">
                {hasToken && globalPixel.trim() ? "Conectado" : "Pendente"}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingGlobal ? (
            <div className="flex items-center justify-center p-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : forbidden ? (
            <p className="text-sm text-muted-foreground">
              Requer papel admin — peça a um admin ou vá em Configurações →
              Meta Ads.
            </p>
          ) : loadError ? (
            <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm">
              <p className="flex items-start gap-2 text-red-300">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Falha ao carregar config Meta: {loadError}. Verifique se as
                  migrations do Supabase estão aplicadas e tente de novo.
                </span>
              </p>
              <Button variant="outline" size="sm" className="mt-2" onClick={retryLoad}>
                Tentar novamente
              </Button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Pixel ID global</Label>
                  <Input
                    value={globalPixel}
                    onChange={(e) => setGlobalPixel(e.target.value)}
                    placeholder="123456789012345"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                    Código de evento de teste{" "}
                    <span className="text-muted-foreground">(aba Test Events)</span>
                  </Label>
                  <Input
                    value={testCode}
                    onChange={(e) => setTestCode(e.target.value)}
                    placeholder="TEST12345"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label>
                  Token de acesso{" "}
                  {hasToken && (
                    <span className="text-emerald-400">
                      (salvo — preencha só para trocar)
                    </span>
                  )}
                </Label>
                <Input
                  type="password"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={hasToken ? "••••••••••••••••" : "EAA..."}
                  autoComplete="new-password"
                />
              </div>
              <Button onClick={handleSaveGlobal} disabled={savingGlobal}>
                {savingGlobal && <Loader2 className="h-4 w-4 animate-spin" />}
                <Save className="h-4 w-4" /> Salvar conexão
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* ---------- 2. Pixel do formulário ---------- */}
      <Card>
        <CardHeader>
          <CardTitle>2 · Pixel deste formulário + eventos do funil</CardTitle>
          <CardDescription>
            Funil: ViewContent (browser) → Lead (browser + CAPI com mesmo
            event_id, deduplicado) → CompleteRegistration + QualifiedLead (CAPI)
            → Schedule (browser + CAPI). PII é normalizada + SHA-256 no
            servidor; fbp/fbc/ip/ua vão em user_data, conforme a doc oficial.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-2">
            <Label>Pixel ID (sobrescreve o global neste formulário)</Label>
            <Input
              value={meta.pixel_id ?? ""}
              onChange={(e) =>
                onChange({ ...meta, pixel_id: e.target.value || null })
              }
              placeholder={`Global: ${globalPixel || "não configurado"}`}
            />
          </div>
          <div className="space-y-2">
            {EVENT_TOGGLES.map(([key, label, hint]) => (
              <label
                key={key}
                className="flex items-start gap-2 rounded border border-border p-2 text-sm"
              >
                <Switch
                  checked={(meta[key] as boolean) ?? true}
                  onCheckedChange={(v) => onChange({ ...meta, [key]: v })}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </div>
          <Button onClick={onSaveForm} disabled={savingForm}>
            {savingForm && <Loader2 className="h-4 w-4 animate-spin" />}
            <Save className="h-4 w-4" /> Salvar config do formulário
          </Button>
        </CardContent>
      </Card>

      {/* ---------- 3. Envio de teste ---------- */}
      <Card className="border-dashed">
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FlaskConical className="h-4 w-4" /> 3 · Enviar evento de teste
              </CardTitle>
              <CardDescription>
                Envia um evento CAPI de teste com os dados abaixo usando o pixel
                e o token salvos. Se houver código de teste, o evento aparece
                na aba <strong>Test Events</strong> do Events Manager sem sujar
                os dados de produção.
              </CardDescription>
            </div>
            <a
              href="https://business.facebook.com/events_manager2"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              Abrir Events Manager <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge variant="outline">Pixel em uso: {effectivePixel}</Badge>
            <Badge variant="outline">Código de teste: {effectiveTestCode}</Badge>
            <Badge variant="outline">
              {hasToken ? "Token: configurado" : "Token: ausente"}
            </Badge>
          </div>

          {forbidden ? (
            <p className="text-sm text-muted-foreground">
              O envio de teste requer papel admin.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Evento</Label>
                  <Select value={testEvent} onValueChange={(v) => setTestEvent(v ?? "Lead")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TEST_EVENTS.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          {e.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Nome</Label>
                  <Input
                    value={testName}
                    onChange={(e) => setTestName(e.target.value)}
                    placeholder="Lead Teste"
                  />
                </div>
                <div className="space-y-2">
                  <Label>E-mail de teste</Label>
                  <Input
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="teste@example.com"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Telefone de teste (com DDI)</Label>
                  <Input
                    value={testPhone}
                    onChange={(e) => setTestPhone(e.target.value)}
                    placeholder="5511999999999"
                  />
                </div>
              </div>

              {!canTest && (
                <p className="text-xs text-amber-400">
                  Configure o Pixel ID global e o token acima antes de enviar o
                  teste.
                </p>
              )}

              <Button onClick={handleSendTest} disabled={sending || !canTest}>
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {sending ? "Enviando…" : "Enviar evento de teste"}
              </Button>

              {result && (
                <div
                  className={`rounded border p-3 text-sm ${
                    result.success
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : "border-red-500/30 bg-red-500/10"
                  }`}
                >
                  {result.success ? (
                    <div className="space-y-1">
                      <p className="flex items-center gap-2 font-medium text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        Evento {result.event_name} recebido pela Meta
                        {result.test_mode ? " (modo teste)" : " (modo produção)"}
                      </p>
                      <dl className="grid grid-cols-1 gap-1 text-xs text-muted-foreground md:grid-cols-2">
                        <div>
                          <dt className="uppercase tracking-wide">events_received</dt>
                          <dd className="font-mono text-foreground">
                            {result.events_received ?? 1}
                          </dd>
                        </div>
                        <div>
                          <dt className="uppercase tracking-wide">fbtrace_id</dt>
                          <dd className="font-mono break-all text-foreground">
                            {result.fbtrace_id ?? "—"}
                          </dd>
                        </div>
                        <div>
                          <dt className="uppercase tracking-wide">event_id</dt>
                          <dd className="font-mono break-all text-foreground">
                            {result.event_id ?? "—"}
                          </dd>
                        </div>
                        <div>
                          <dt className="uppercase tracking-wide">pixel</dt>
                          <dd className="font-mono text-foreground">
                            {result.pixel_id ?? effectivePixel}
                          </dd>
                        </div>
                      </dl>
                      {result.messages && result.messages.length > 0 && (
                        <pre className="mt-2 max-h-24 overflow-auto rounded bg-muted p-2 text-[11px]">
                          {JSON.stringify(result.messages, null, 2)}
                        </pre>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Confira em Events Manager → Test Events
                        {result.test_event_code
                          ? ` com o código ${result.test_event_code}`
                          : ""}
                        .
                      </p>
                    </div>
                  ) : (
                    <p className="flex items-start gap-2 text-red-300">
                      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{result.error ?? "Falha no envio"}</span>
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
