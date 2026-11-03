"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import {
  Loader2,
  ArrowRight,
  ArrowLeft,
  Check,
  Star,
  CalendarDays,
  Clock,
  Globe,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { trackFormPixel } from "@/lib/lead-forms/meta-pixel";
import { collectTracking } from "@/lib/lead-forms/attribution";
import { zonedDayKey } from "@/lib/lead-forms/timezone";

/**
 * Meta Pixel via <Script nonce> — o padrão do guia oficial de CSP
 * (third-party scripts). O snippet inline carrega o fbevents.js por
 * inserção dinâmica de <script>, que herda a confiança via
 * 'strict-dynamic' a partir deste script com nonce. A injeção manual
 * via `document.createElement('script')` + innerHTML NÃO tem nonce e
 * era bloqueada ("Loading the script violates ... script-src").
 */
function MetaPixelSnippet({ pixelId, nonce }: { pixelId: string; nonce?: string }) {
  // pixel_id vem do banco (admin) — restringe a dígitos para não virar
  // vetor de injeção de JS no snippet inline.
  if (!/^\d{5,30}$/.test(pixelId)) return null;
  const init = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixelId}');fbq('track','PageView');`;
  return (
    <Script
      id="meta-pixel-leadform"
      strategy="afterInteractive"
      nonce={nonce}
      dangerouslySetInnerHTML={{ __html: init }}
    />
  );
}

interface PublicBlock {
  key: string;
  type: string;
  config: { label: string; placeholder?: string; help_text?: string; required?: boolean; options?: Array<{ value: string; label: string }>; min?: number; max?: number };
  position: number;
}

export interface PublicFormData {
  form: {
    id: string; name: string;
    theme: { primary_color: string; background: string; font: string; avatar_url: string | null; logo_url: string | null; welcome_title: string; welcome_subtitle: string; button_text: string; show_branding: boolean; bubble_user: string; bubble_bot: string };
    scheduling: { enabled: boolean; duration_min: number; timezone: string; meeting_title: string; meeting_link?: string | null };
    pixel_id: string | null;
    pixel_events?: { view_content: boolean; lead: boolean; complete_registration: boolean; schedule: boolean };
  };
  blocks: PublicBlock[];
}

function getTracking() {
  // Captura ampliada (UTMs + macros de campanha/anúncio + click IDs +
  // cookies + referrer). Ver `lib/lead-forms/attribution.ts`.
  return collectTracking();
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

/** Chave por formulário: sobrevive a reload na mesma aba. */
function partialStorageKey(slug: string): string {
  return `wacrm:lead-form:${slug}:response_id`;
}

/** Rascunho na aba: quem sai para o app do anúncio e volta não recomeça. */
function draftStorageKey(slug: string): string {
  return `wacrm:lead-form:${slug}:draft`;
}

/** Texto legível sobre a cor de destaque escolhida no editor. */
function contrastOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? "#1c1917" : "#ffffff";
}

/** Máscara de telefone BR; número iniciado por + fica livre (internacional). */
function formatPhone(raw: string): string {
  if (raw.trim().startsWith("+")) return raw;
  const d = raw.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d ? `(${d}` : "";
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  const split = d.length === 11 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, split)}-${d.slice(split)}`;
}

/** Permite o preenchimento automático do navegador/celular. */
function autoCompleteFor(block: PublicBlock): string {
  if (block.type === "email") return "email";
  if (block.type === "phone") return "tel";
  if (/^(nome|name|nome_completo|full_name)$/i.test(block.key)) return "name";
  if (/^(empresa|company)$/i.test(block.key)) return "organization";
  return "off";
}

function friendlyError(err: unknown, fallback: string): string {
  if (err instanceof TypeError) return "Sem conexão no momento. Verifique a internet e tente de novo.";
  return err instanceof Error && err.message ? err.message : fallback;
}

function googleCalendarUrl(title: string, startsAt: string, endsAt: string): string {
  const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const params = new URLSearchParams({ action: "TEMPLATE", text: title, dates: `${stamp(startsAt)}/${stamp(endsAt)}` });
  return `https://calendar.google.com/calendar/render?${params}`;
}

/** Bloco que representa o WhatsApp/telefone do lead. */
function isPhoneBlock(block: { key: string; type: string }, value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  return block.type === "phone" || /^(whatsapp|phone|telefone|celular)$/i.test(block.key);
}

export function PublicForm({ slug, nonce, preview }: {
  slug: string;
  nonce?: string;
  /** Pré-visualização do editor: usa estes dados, sem rede, pixel nem envio real. */
  preview?: PublicFormData;
}) {
  const [loaded, setData] = useState<PublicFormData | null>(null);
  const data = preview ?? loaded;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawStep, setStep] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [choosing, setChoosing] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [done, setDone] = useState<{ is_qualified: boolean; message: string; response_id: string } | null>(null);
  const [slots, setSlots] = useState<Array<{ start: string; end: string }>>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);
  const [booking, setBooking] = useState<{
    starts_at: string;
    ends_at: string;
    meeting_title?: string | null;
    attendee_name?: string | null;
    meeting_link?: string | null;
  } | null>(null);
  // Dia selecionado no calendário (yyyy-mm-dd) + mês em exibição.
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [viewMonth, setViewMonth] = useState<{ y: number; m: number } | null>(null);
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  // Guarda síncrona contra duplo envio (toque duplo na última pergunta):
  // setState é assíncrono e não barra o segundo toque a tempo.
  const submittingRef = useRef(false);
  // Anti-bot: honeypot invisível + instante de abertura (tempo de preenchimento).
  const [honeypot, setHoneypot] = useState("");
  const openedAt = useRef(0);
  if (openedAt.current === 0) openedAt.current = Date.now();
  // Salvamento parcial: id da resposta criada quando o WhatsApp é
  // respondido + promise em voo (o envio final aguarda e reaproveita).
  const partialResponseId = useRef<string | null>(null);
  const partialRequest = useRef<Promise<string | null> | null>(null);

  const blocks = useMemo(() => (data?.blocks ?? []).filter((b) => b.type !== "meeting"), [data]);
  // O editor pode remover perguntas enquanto a prévia está numa delas.
  const step = Math.min(rawStep, Math.max(blocks.length - 1, 0));
  const theme = data?.form.theme;
  const pixelId = preview ? null : data?.form.pixel_id;
  const pixelEvents = data?.form.pixel_events;
  const accent = theme?.primary_color && /^#[0-9a-fA-F]{6}$/.test(theme.primary_color)
    ? theme.primary_color
    : "#4f46e5";
  const onAccent = contrastOn(accent);
  // Fuso em que a agenda foi configurada. Todas as datas/horas da tela
  // são formatadas nele, não no fuso do visitante.
  const scheduleTz = data?.form.scheduling?.timezone || "America/Sao_Paulo";

  useEffect(() => {
    if (preview) return;
    (async () => {
      try {
        const res = await fetch(`/api/public/forms/${slug}`, { cache: "no-store" });
        if (!res.ok) throw new Error("Formulário não encontrado");
        const json = (await res.json()) as PublicFormData;
        try {
          const draft = JSON.parse(sessionStorage.getItem(draftStorageKey(slug)) ?? "null") as { answers?: Record<string, unknown>; step?: number } | null;
          if (draft?.answers && typeof draft.step === "number") {
            setAnswers(draft.answers);
            setStep(draft.step);
          }
        } catch {
          // Rascunho é conveniência: sem ele, o formulário começa do início.
        }
        setData(json);
      } catch {
        setError("Formulário não encontrado ou fora do ar.");
      }
    })();
    // `preview` só decide se busca; trocá-lo não recarrega o formulário.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // ViewContent no funil assim que o formulário carrega (o PageView
  // já é disparado pelo próprio snippet do pixel acima).
  useEffect(() => {
    if (!pixelId || pixelEvents?.view_content === false) return;
    const t = setTimeout(() => trackFormPixel(pixelId, "ViewContent", { content_name: slug }), 800);
    return () => clearTimeout(t);
  }, [pixelId, pixelEvents, slug]);

  // Recupera o id do salvamento parcial após um reload (mesma aba), para
  // que o envio final atualize a mesma resposta em vez de duplicar.
  useEffect(() => {
    try {
      partialResponseId.current = sessionStorage.getItem(partialStorageKey(slug));
    } catch {
      partialResponseId.current = null;
    }
    partialRequest.current = null;
  }, [slug]);

  const current = blocks[step];

  // Ao trocar de pergunta, restaura resposta anterior e foca o campo.
  useEffect(() => {
    if (!current) return;
    const prev = answers[current.key];
    if (current.type === "choice_multi") {
      setMulti(Array.isArray(prev) ? prev.map(String) : []);
    } else if (typeof prev === "string" || typeof prev === "number") {
      setInput(String(prev));
    } else {
      setInput("");
    }
    setFieldError(null);
    // Autofoco só em desktop (pointer fino): no mobile o teclado abriria
    // sozinho a cada pergunta, empurrando o layout e piorando o UX.
    const t = setTimeout(() => {
      if (
        !preview &&
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: fine)").matches
      ) {
        inputRef.current?.focus({ preventScroll: true });
      }
    }, 120);
    return () => clearTimeout(t);
    // `current` entra nas dependências para focar o primeiro campo assim
    // que as perguntas chegam da API (step ainda é 0 nesse momento).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, current]);

  function validateCurrent(value: unknown): string | null {
    const b = blocks[step];
    if (!b) return null;
    if (b.config.required && (value === "" || value === undefined || (Array.isArray(value) && value.length === 0))) {
      return "Essa resposta é necessária para continuar.";
    }
    if (b.type === "email" && value) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(value))) return "Digite um e-mail válido.";
    }
    if (b.type === "phone" && value) {
      const digits = String(value).replace(/\D/g, "");
      if (digits.length < 10 || digits.length > 15) return "Digite um WhatsApp válido com DDD.";
    }
    if (b.type === "number" && value !== "" && value !== undefined) {
      const n = Number(value);
      if (b.config.min !== undefined && n < b.config.min) return `O valor mínimo é ${b.config.min}.`;
      if (b.config.max !== undefined && n > b.config.max) return `O valor máximo é ${b.config.max}.`;
    }
    return null;
  }

  const advance = useCallback((value: unknown) => {
    const b = blocks[step];
    if (!b || busy || submittingRef.current) return;
    const err = validateCurrent(value);
    if (err) {
      setFieldError(err);
      return;
    }
    setFieldError(null);
    const next = { ...answers, [b.key]: value };
    setAnswers(next);
    setInput("");
    setMulti([]);
    if (!preview) {
      try {
        sessionStorage.setItem(draftStorageKey(slug), JSON.stringify({ answers: next, step: step + 1 }));
      } catch {
        // Storage indisponível: segue sem rascunho.
      }
    }
    // Assim que o WhatsApp é respondido (e ainda restam perguntas),
    // envia o lead para o CRM. Não bloqueia o avanço; o envio final
    // aguarda esta requisição e reaproveita a mesma resposta.
    if (!preview && step + 1 < blocks.length && isPhoneBlock(b, value)) {
      void savePartialLead(next);
    }
    if (step + 1 < blocks.length) {
      setStep(step + 1);
    } else {
      submittingRef.current = true;
      void submit(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, step, busy, answers]);

  /** Mostra a opção marcada por um instante antes de trocar de pergunta. */
  function chooseOption(value: string) {
    if (choosing) return;
    setChoosing(value);
    setTimeout(() => {
      setChoosing(null);
      advance(value);
    }, 160);
  }

  function goBack() {
    if (busy || step === 0) return;
    setFieldError(null);
    setStep(step - 1);
  }

  function newClientEventId(): string {
    try {
      if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
      }
    } catch { /* fallback abaixo */ }
    return `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function rememberPartialResponse(id: string) {
    partialResponseId.current = id;
    try {
      sessionStorage.setItem(partialStorageKey(slug), id);
    } catch {
      // Storage indisponível (modo privado): mantém só em memória.
    }
  }

  function forgetPartialResponse() {
    partialResponseId.current = null;
    try {
      sessionStorage.removeItem(partialStorageKey(slug));
    } catch {
      // Best-effort.
    }
  }

  /**
   * Salva o lead no CRM antes do fim do formulário. Idempotente: uma
   * única requisição por visita — respostas seguintes apenas atualizam
   * o mesmo `response_id` no envio final.
   */
  function savePartialLead(answersSoFar: Record<string, unknown>): Promise<string | null> {
    if (partialRequest.current) return partialRequest.current;

    const request = (async () => {
      // Timeout próprio: se a rede travar, o envio final não fica preso.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const res = await fetch(`/api/public/forms/${slug}/submit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            answers: answersSoFar,
            tracking: getTracking(),
            partial: true,
            response_id: partialResponseId.current ?? undefined,
            website: honeypot || undefined,
            started_at: openedAt.current,
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { response_id?: string };
        if (!json.response_id) return null;
        rememberPartialResponse(json.response_id);
        return json.response_id;
      } catch {
        // Best-effort: o envio final ainda salva o lead completo.
        return null;
      } finally {
        clearTimeout(timer);
      }
    })();

    partialRequest.current = request;
    return request;
  }

  async function submit(finalAnswers: Record<string, unknown>) {
    if (preview) {
      submittingRef.current = false;
      setDone({ is_qualified: false, message: "Fim da pré-visualização. Nenhuma resposta foi salva.", response_id: "preview" });
      return;
    }
    setBusy(true);
    setSending(true);
    // Mesmo event_id no browser e no CAPI → a Meta deduplica
    // (redundant setup recomendado na doc do Conversions API).
    const clientEventId = newClientEventId();
    try {
      // Espera o salvamento parcial (se houver) para atualizar a mesma
      // resposta em vez de criar um segundo lead/negócio.
      if (partialRequest.current) {
        try {
          await partialRequest.current;
        } catch {
          // Best-effort.
        }
      }
      const res = await fetch(`/api/public/forms/${slug}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: finalAnswers,
          tracking: getTracking(),
          event_id: clientEventId,
          website: honeypot || undefined,
          started_at: openedAt.current,
          response_id: partialResponseId.current ?? undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(
          res.status === 429
            ? "Muitas tentativas seguidas. Aguarde um minuto e tente de novo."
            : (json as { error?: string }).error ?? "Não foi possível enviar. Tente de novo."
        );
      }
      const r = json as { is_qualified: boolean; message: string; response_id: string; scheduling_enabled: boolean; redirect_url?: string | null };
      forgetPartialResponse();
      try {
        sessionStorage.removeItem(draftStorageKey(slug));
      } catch {
        // Best-effort.
      }
      partialRequest.current = null;
      setDone({ is_qualified: r.is_qualified, message: r.message, response_id: r.response_id });
      if (pixelId) {
        if (pixelEvents?.lead !== false) trackFormPixel(pixelId, "Lead", { content_name: slug }, clientEventId);
        // Sufixo igual ao do CAPI: sem ele a Meta contava o evento duas vezes.
        if (r.is_qualified && pixelEvents?.complete_registration !== false) {
          trackFormPixel(pixelId, "CompleteRegistration", { content_name: slug }, `${clientEventId}_complete`);
        }
      }
      // Com agenda, o redirecionamento atrapalharia a escolha do horário.
      if (r.redirect_url && !(r.is_qualified && r.scheduling_enabled)) {
        setRedirecting(true);
        // Dá tempo de o pixel sair antes de trocar de página.
        setTimeout(() => window.location.assign(r.redirect_url!), 900);
      }
      if (r.is_qualified && r.scheduling_enabled) {
        void loadSlots();
      }
    } catch (err) {
      setFieldError(friendlyError(err, "Ops, tente novamente."));
    } finally {
      submittingRef.current = false;
      setSending(false);
      setBusy(false);
    }
  }

  async function loadSlots() {
    setSlotsLoading(true);
    try {
      const res = await fetch(`/api/public/forms/${slug}/slots`, { cache: "no-store" });
      if (res.ok) {
        const json = await res.json() as { slots: Array<{ start: string; end: string }> };
        const list = json.slots ?? [];
        setSlots(list);
        // Depois de um refresh, um dia/horário pode ter sido ocupado.
        setPicked((prev) => (prev && list.some((s) => s.start === prev) ? prev : null));
        // Pré-seleciona o primeiro dia com disponibilidade.
        if (list.length > 0) {
          const firstDay = zonedDayKey(list[0].start, scheduleTz);
          setSelectedDay((prev) => {
            if (prev && list.some((s) => zonedDayKey(s.start, scheduleTz) === prev)) return prev;
            return firstDay || null;
          });
          setViewMonth((prev) => {
            if (prev) return prev;
            return monthFromDayKey(firstDay);
          });
        } else {
          setSelectedDay(null);
        }
      }
    } finally {
      setSlotsLoading(false);
    }
  }

  async function book() {
    if (!picked || !done) return;
    setBusy(true);
    try {
      // Pelo tipo do bloco, não pela chave: a chave é editável e, com outro
      // nome, o agendamento era recusado por falta do nome.
      const answerOf = (test: (b: PublicBlock) => boolean) => {
        const value = answers[blocks.find(test)?.key ?? ""];
        return typeof value === "string" && value ? value : undefined;
      };
      const name =
        answerOf((b) => autoCompleteFor(b) === "name") ?? answerOf((b) => b.type === "short_text") ?? "Visitante";
      const email = answerOf((b) => b.type === "email");
      const phone = answerOf((b) => isPhoneBlock(b, answers[b.key]));
      const res = await fetch(`/api/public/forms/${slug}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_id: done.response_id, starts_at: picked, name, email, phone }),
      });
      const json = (await res.json()) as {
        booking?: { id: string; starts_at: string; ends_at: string; meeting_title?: string | null; attendee_name?: string | null; meeting_link?: string | null };
        error?: string;
      };
      if (!res.ok) throw new Error(json.error ?? "Falha ao agendar");
      setBooking({
        starts_at: json.booking!.starts_at,
        ends_at: json.booking!.ends_at,
        meeting_title: json.booking?.meeting_title ?? null,
        attendee_name: json.booking?.attendee_name ?? name,
        meeting_link: json.booking?.meeting_link ?? null,
      });
      setBooked(true);
      // event_id idêntico ao do CAPI (`booking_<id>`) para deduplicar.
      if (pixelId && json.booking?.id && pixelEvents?.schedule !== false) trackFormPixel(pixelId, "Schedule", { content_name: slug }, `booking_${json.booking.id}`);
    } catch (err) {
      setFieldError(friendlyError(err, "Horário indisponível."));
      setPicked(null);
      void loadSlots();
    } finally {
      setBusy(false);
    }
  }

  // Atalhos de teclado: Enter avança (texto), A–C escolhem opção.
  useEffect(() => {
    if (done || !current) return;
    function onKey(e: KeyboardEvent) {
      // Na prévia, o teclado do editor não pode responder o formulário.
      if (preview && !rootRef.current?.contains(e.target as Node)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (document.activeElement?.tagName ?? "").toLowerCase();
      if (e.key === "Enter" && !busy) {
        if (tag === "button" || tag === "a") return;
        if (current.type === "statement") {
          e.preventDefault();
          advance("seen");
          return;
        }
        if (current.type === "choice_single") return;
        if (current.type === "choice_multi") {
          if (tag !== "input" && tag !== "textarea") {
            e.preventDefault();
            advance(multi);
          }
          return;
        }
        if (current.type === "rating" || current.type === "nps") return;
        e.preventDefault();
        advance(input.trim());
      }
      if (current.type === "rating" && /^[1-5]$/.test(e.key)) advance(Number(e.key));
      if ((current.type === "choice_single" || current.type === "choice_multi") && tag !== "input" && tag !== "textarea" && /^[a-lA-L]$/.test(e.key)) {
        const idx = e.key.toLowerCase().charCodeAt(0) - 97;
        const opt = current.config.options?.[idx];
        if (!opt) return;
        if (current.type === "choice_single") {
          chooseOption(opt.value);
        } else {
          setMulti((m) => (m.includes(opt.value) ? m.filter((x) => x !== opt.value) : [...m, opt.value]));
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // chooseOption e preview não mudam o que o atalho faz entre renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, current, busy, input, multi, advance]);

  const grouped = useMemo(() => groupByDay(slots, scheduleTz), [slots, scheduleTz]);
  const availDays = useMemo(() => new Set(grouped.map((g) => g.day)), [grouped]);
  const selectedDaySlots = useMemo(
    () => grouped.find((g) => g.day === selectedDay)?.slots ?? [],
    [grouped, selectedDay]
  );
  const monthRange = useMemo(() => {
    const keys = [...availDays].map((d) => d.slice(0, 7)).sort();
    return { min: keys[0] ?? null, max: keys[keys.length - 1] ?? null };
  }, [availDays]);
  const todayKey = zonedDayKey(new Date(), scheduleTz);
  const activeView = viewMonth ?? monthFromDayKey(todayKey);
  const scheduling = data?.form.scheduling;

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#fafaf9] p-6 text-center">
        <p className="max-w-sm text-lg text-stone-500">{error}</p>
      </div>
    );
  }
  if (!data || !theme) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#fafaf9] px-6" aria-busy="true" aria-label="Carregando formulário">
        <div className="w-full max-w-2xl animate-pulse space-y-4">
          <div className="h-4 w-16 rounded bg-stone-200" />
          <div className="h-9 w-4/5 rounded bg-stone-200" />
          <div className="h-14 w-full rounded-xl bg-stone-200" />
        </div>
      </div>
    );
  }

  const progress = blocks.length
    ? Math.round(((done || sending ? blocks.length : step) / blocks.length) * 100)
    : 0;
  const fontStack = `${theme.font}, Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
  const meetingLink = booking?.meeting_link ?? scheduling?.meeting_link;

  return (
    <div
      ref={rootRef}
      className={`relative flex flex-col bg-[#fafaf9] text-stone-800 antialiased ${preview ? "min-h-full" : "min-h-dvh"}`}
      style={{ fontFamily: fontStack, "--pf-accent": accent } as React.CSSProperties}
    >
      <style>{`
        @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        .animate-rise { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .animate-rise-d1 { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both; }
        .animate-rise-d2 { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both; }
        @media (prefers-reduced-motion: reduce) { .animate-rise, .animate-rise-d1, .animate-rise-d2 { animation: none; } }
        button:focus-visible, a:focus-visible { outline: 2px solid var(--pf-accent); outline-offset: 2px; }
      `}</style>
      {pixelId && <MetaPixelSnippet pixelId={pixelId} nonce={nonce} />}

      {/* Barra de progresso fina */}
      <div
        className={`${preview ? "absolute" : "fixed"} inset-x-0 top-0 z-10 h-1 bg-stone-200/70`}
        role="progressbar"
        aria-label="Progresso do formulário"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
      >
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{ width: `${progress}%`, background: accent }}
        />
      </div>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16 sm:px-10">
        {theme.avatar_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={theme.avatar_url} alt="" className="mb-6 h-14 w-14 self-start rounded-full object-cover" />
        )}
        {theme.logo_url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={theme.logo_url}
            alt=""
            className="mb-10 h-9 w-auto self-start object-contain object-left"
          />
        )}
        {/* Honeypot anti-bot: campo invisível que humanos nunca preenchem. */}
        <div aria-hidden="true" style={{ position: "absolute", left: "-9999px", top: 0, height: 1, width: 1, overflow: "hidden" }}>
          <input
            type="text"
            name="website"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
            autoComplete="off"
            tabIndex={-1}
          />
        </div>
        {done ? (
          <div key="done" className="animate-rise">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{ background: `${accent}14`, color: accent }}
            >
              <Check className="h-6 w-6" />
            </div>
            {booked && booking ? (
              <>
                <h2 className="mt-6 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
                  Sua reunião está agendada
                </h2>
                <p className="mt-4 max-w-lg text-lg leading-relaxed text-stone-500">
                  Está tudo certo{booking.attendee_name ? `, ${booking.attendee_name.split(" ")[0]}` : ""}. Anote os detalhes abaixo.
                </p>
                <div className="mt-8 max-w-lg rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
                  <p className="text-xs font-medium uppercase tracking-widest text-stone-500">
                    {booking.meeting_title || scheduling?.meeting_title || "Reunião"}
                  </p>
                  <p className="mt-2 text-xl font-medium text-stone-900">
                    {fmtLongDay(booking.starts_at, scheduleTz)}
                  </p>
                  <div className="mt-4 space-y-2 text-base text-stone-600">
                    <p className="flex items-center gap-2.5">
                      <Clock className="h-4 w-4 shrink-0" style={{ color: accent }} />
                      {fmtTime(booking.starts_at, scheduleTz)} às {fmtTime(booking.ends_at, scheduleTz)}
                    </p>
                    <p className="flex items-center gap-2.5">
                      <Globe className="h-4 w-4 shrink-0" style={{ color: accent }} />
                      {tzLabel(scheduling?.timezone)}
                    </p>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <a
                      href={googleCalendarUrl(booking.meeting_title || scheduling?.meeting_title || "Reunião", booking.starts_at, booking.ends_at)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-stone-200 px-4 text-sm font-medium text-stone-700 hover:bg-stone-50"
                    >
                      <CalendarDays className="h-4 w-4" /> Adicionar à agenda
                    </a>
                    {meetingLink && /^https?:\/\//.test(meetingLink) && (
                      <a
                        href={meetingLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-[44px] items-center rounded-lg px-4 text-sm font-medium"
                        style={{ background: accent, color: onAccent }}
                      >
                        Abrir link da reunião
                      </a>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <>
                <h2 className="mt-6 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
                  Obrigado!
                </h2>
                <p className="mt-4 max-w-lg text-lg leading-relaxed text-stone-500">
                  {done.message}
                </p>
                {redirecting && (
                  <p className="mt-3 flex items-center gap-2 text-sm text-stone-500" role="status">
                    <Loader2 className="h-4 w-4 animate-spin" /> Redirecionando…
                  </p>
                )}

                {done.is_qualified && (
                  <div className="animate-rise-d1 mt-10 overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-sm">
                    {/* Detalhes do evento */}
                    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-stone-200 px-5 py-4 sm:px-6">
                      <p className="flex items-center gap-2 text-base font-medium text-stone-900">
                        <CalendarDays className="h-5 w-5" style={{ color: accent }} />
                        {scheduling?.meeting_title || "Agendar reunião"}
                      </p>
                      <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
                        <Clock className="h-4 w-4" /> {scheduling?.duration_min ?? 30} min
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-sm text-stone-500">
                        <Globe className="h-4 w-4" /> {tzLabel(scheduling?.timezone)}
                      </span>
                    </div>

                    {slotsLoading ? (
                      <div className="flex items-center gap-3 px-5 py-10 sm:px-6">
                        <Loader2 className="h-5 w-5 animate-spin text-stone-500" />
                        <p className="text-sm text-stone-500">Carregando horários disponíveis…</p>
                      </div>
                    ) : slots.length === 0 ? (
                      <p className="px-5 py-10 text-sm text-stone-500 sm:px-6">
                        Sem horários livres nos próximos dias. Fique tranquilo, entraremos em contato.
                      </p>
                    ) : (
                      <div className="grid md:grid-cols-[1fr_190px]">
                        {/* Calendário */}
                        <div className="border-b border-stone-200 p-4 sm:p-5 md:border-r md:border-b-0">
                          <MonthCalendar
                            avail={availDays}
                            selected={selectedDay}
                            view={activeView}
                            minMonth={monthRange.min}
                            maxMonth={monthRange.max}
                            todayKey={todayKey}
                            accent={accent}
                            onView={setViewMonth}
                            onSelect={(day) => { setSelectedDay(day); setPicked(null); }}
                          />
                        </div>
                        {/* Horários do dia */}
                        <div className="p-4 sm:p-5">
                          <p className="text-xs font-medium uppercase tracking-widest text-stone-500">
                            {selectedDay ? fmtShortDay(selectedDay) : "Horários"}
                          </p>
                          {selectedDaySlots.length === 0 ? (
                            <p className="mt-3 text-sm text-stone-500">
                              Selecione um dia com disponibilidade no calendário.
                            </p>
                          ) : (
                            <div className="mt-3 max-h-72 space-y-2 overflow-y-auto pr-1">
                              {selectedDaySlots.map((s) => {
                                const active = picked === s.start;
                                return (
                                  <button
                                    type="button"
                                    key={s.start}
                                    onClick={() => setPicked(s.start)}
                                    aria-pressed={active}
                                    className="min-h-[44px] w-full rounded-lg border px-4 py-2.5 text-sm font-medium transition-all duration-150 active:scale-[0.98]"
                                    style={active
                                      ? { background: accent, borderColor: accent, color: onAccent }
                                      : { borderColor: "#e7e5e4", color: "#44403c", background: "#fff" }}
                                  >
                                    {fmtTime(s.start, scheduleTz)}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          {picked && (
                            <button
                              type="button"
                              onClick={book}
                              disabled={busy}
                              className="mt-4 w-full rounded-lg px-5 py-3 text-base font-medium shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                              style={{ background: accent, color: onAccent }}
                            >
                              {busy ? "Agendando…" : "Confirmar"}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {fieldError && <p role="alert" className="mt-4 text-sm text-red-600">{fieldError}</p>}
          </div>
        ) : sending ? (
          <div key="sending" className="animate-rise">
            <Loader2 className="h-8 w-8 animate-spin" style={{ color: accent }} />
            <h2 className="mt-6 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              Enviando sua resposta…
            </h2>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-stone-500">
              Só um instante, já estamos processando.
            </p>
          </div>
        ) : blocks.length === 0 ? (
          <div key="empty" className="animate-rise">
            <h2 className="text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              Formulário em preparação
            </h2>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-stone-500">
              Este formulário ainda não tem perguntas. Tente novamente em instantes.
            </p>
          </div>
        ) : current ? (
          <div key={`${step}-${blocks.length}`} className="animate-rise">
            <p className="text-sm font-medium text-stone-500" aria-live="polite">
              {step + 1} de {blocks.length}
              {step === 0 && theme.welcome_subtitle && <span> · {theme.welcome_subtitle}</span>}
            </p>
            <h2 id="pf-question" className="mt-3 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              {current.config.label}
            </h2>
            {current.config.help_text && (
              <p className="mt-3 max-w-lg text-base leading-relaxed text-stone-500">
                {current.config.help_text}
              </p>
            )}

            <div className="animate-rise-d1 mt-8">
              {current.type === "choice_single" && (
                <div className="space-y-3">
                  {(current.config.options ?? []).map((o, i) => {
                    const selected = choosing === o.value || (!choosing && answers[current.key] === o.value);
                    return (
                    <button
                      type="button"
                      key={o.value}
                      onClick={() => chooseOption(o.value)}
                      aria-pressed={selected}
                      className="group flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-4 text-left transition-all duration-150 hover:-translate-y-[1px] hover:shadow-sm active:scale-[0.99]"
                      style={selected ? { borderColor: accent, background: `${accent}08` } : { borderColor: "#e7e5e4" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; }}
                      onMouseLeave={(e) => { if (!selected) e.currentTarget.style.borderColor = "#e7e5e4"; }}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-sm font-semibold transition-colors duration-150"
                        style={selected ? { background: accent, borderColor: accent, color: onAccent } : { borderColor: "#d6d3d1", color: "#78716c", background: "#fafaf9" }}
                      >
                        {selected ? <Check className="h-4 w-4" /> : (LETTERS[i] ?? i + 1)}
                      </span>
                      <span className="flex-1 text-lg text-stone-800">{o.label}</span>
                      <span
                        className="text-xs font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        style={{ color: accent }}
                      >
                        {LETTERS[i] ?? ""}
                      </span>
                    </button>
                    );
                  })}
                </div>
              )}

              {current.type === "choice_multi" && (
                <div>
                  <div className="space-y-3">
                    {(current.config.options ?? []).map((o, i) => {
                      const selected = multi.includes(o.value);
                      return (
                        <button
                          type="button"
                          key={o.value}
                          aria-pressed={selected}
                          onClick={() => setMulti((m) => (m.includes(o.value) ? m.filter((x) => x !== o.value) : [...m, o.value]))}
                          className="flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-4 text-left transition-all duration-150 hover:-translate-y-[1px] hover:shadow-sm active:scale-[0.99]"
                          style={selected
                            ? { borderColor: accent, background: `${accent}08` }
                            : { borderColor: "#e7e5e4" }}
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-sm font-semibold transition-colors duration-150"
                            style={selected
                              ? { background: accent, borderColor: accent, color: onAccent }
                              : { borderColor: "#d6d3d1", color: "#78716c", background: "#fafaf9" }}
                          >
                            {selected ? <Check className="h-4 w-4" /> : (LETTERS[i] ?? i + 1)}
                          </span>
                          <span className="flex-1 text-lg text-stone-800">{o.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button
                      type="button"
                      onClick={() => advance(multi)}
                      className="rounded-lg px-7 py-3 text-base font-medium shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
                      style={{ background: accent, color: onAccent }}
                    >
                      Continuar
                    </button>
                    <span className="hidden text-sm text-stone-500 [@media(pointer:fine)]:inline">Pressione Enter ↵</span>
                  </div>
                </div>
              )}

              {current.type === "rating" && (
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      type="button"
                      key={n}
                      onClick={() => advance(n)}
                      onMouseEnter={() => setHoverRating(n)}
                      onMouseLeave={() => setHoverRating(0)}
                      aria-label={`${n} de 5`}
                      className="p-1 transition-transform duration-150 hover:scale-110 active:scale-95"
                    >
                      <Star
                        className="h-9 w-9"
                        style={{ color: accent }}
                        fill={n <= (hoverRating || Number(answers[current.key] ?? 0)) ? accent : "none"}
                        strokeWidth={1.5}
                      />
                    </button>
                  ))}
                </div>
              )}

              {current.type === "nps" && (
                <div className="max-w-lg">
                <div className="flex flex-wrap gap-2">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button
                      type="button"
                      key={n}
                      onClick={() => advance(n)}
                      className="h-12 min-w-[44px] flex-1 rounded-lg border bg-white text-base font-medium text-stone-600 transition-all duration-150 hover:-translate-y-[1px] hover:shadow-sm active:scale-95"
                      style={{ borderColor: "#e7e5e4" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; e.currentTarget.style.color = accent; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; e.currentTarget.style.color = "#57534e"; }}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-xs text-stone-500">
                  <span>Nada provável</span>
                  <span>Muito provável</span>
                </div>
                </div>
              )}

              {["short_text", "email", "phone", "number", "date", "file"].includes(current.type) && (
                <form
                  onSubmit={(e) => { e.preventDefault(); advance(input.trim()); }}
                  className="max-w-xl"
                >
                  <input
                    ref={inputRef as React.RefObject<HTMLInputElement>}
                    value={input}
                    onChange={(e) => { setInput(current.type === "phone" ? formatPhone(e.target.value) : e.target.value); setFieldError(null); }}
                    placeholder={current.config.placeholder ?? "Digite sua resposta…"}
                    aria-labelledby="pf-question"
                    aria-invalid={!!fieldError}
                    aria-describedby={fieldError ? "pf-error" : undefined}
                    aria-required={!!current.config.required}
                    autoComplete={autoCompleteFor(current)}
                    autoCapitalize={autoCompleteFor(current) === "name" ? "words" : current.type === "email" ? "none" : undefined}
                    inputMode={current.type === "phone" ? "tel" : current.type === "email" ? "email" : current.type === "number" ? "decimal" : undefined}
                    enterKeyHint={step + 1 < blocks.length ? "next" : "send"}
                    min={current.config.min}
                    max={current.config.max}
                    type={current.type === "email" ? "email" : current.type === "number" ? "number" : current.type === "date" ? "date" : current.type === "phone" ? "tel" : "text"}
                    className="w-full border-0 border-b-2 bg-transparent pb-3 text-2xl text-stone-900 outline-none transition-colors duration-150 placeholder:text-stone-400 sm:text-[28px]"
                    style={{ borderColor: "#e7e5e4" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
                  />
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                      style={{ background: accent, color: onAccent }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Responder <ArrowRight className="h-4 w-4" /></>}
                    </button>
                    <span className="hidden text-sm text-stone-500 [@media(pointer:fine)]:inline">Pressione Enter ↵</span>
                  </div>
                </form>
              )}

              {current.type === "long_text" && (
                <form
                  onSubmit={(e) => { e.preventDefault(); advance(input.trim()); }}
                  className="max-w-xl"
                >
                  <textarea
                    ref={inputRef as React.RefObject<HTMLTextAreaElement>}
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setFieldError(null); }}
                    placeholder={current.config.placeholder ?? "Digite sua resposta…"}
                    aria-labelledby="pf-question"
                    aria-invalid={!!fieldError}
                    aria-describedby={fieldError ? "pf-error" : undefined}
                    rows={3}
                    className="w-full resize-none border-0 border-b-2 bg-transparent pb-3 text-2xl text-stone-900 outline-none transition-colors duration-150 placeholder:text-stone-400 sm:text-[28px]"
                    style={{ borderColor: "#e7e5e4" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
                  />
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                      style={{ background: accent, color: onAccent }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Responder <ArrowRight className="h-4 w-4" /></>}
                    </button>
                    <span className="hidden text-sm text-stone-500 [@media(pointer:fine)]:inline">Pressione Enter ↵</span>
                  </div>
                </form>
              )}

              {current.type === "statement" && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => advance("seen")}
                    className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
                    style={{ background: accent, color: onAccent }}
                  >
                    Continuar <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {fieldError && (
              <p id="pf-error" role="alert" className="animate-rise-d2 mt-5 max-w-lg text-sm text-red-600">{fieldError}</p>
            )}
            {!current.config.required && ["choice_single", "rating", "nps"].includes(current.type) && (
              <button
                type="button"
                onClick={() => advance("")}
                className="mt-5 min-h-[44px] text-sm font-medium text-stone-500 underline underline-offset-4 hover:text-stone-700"
              >
                Pular esta pergunta
              </button>
            )}
          </div>
        ) : null}
      </main>

      {/* Navegação discreta */}
      <footer className="mx-auto flex w-full max-w-2xl items-center justify-between px-6 pb-[max(2rem,env(safe-area-inset-bottom))] sm:px-10">
        <div>
          {!done && step > 0 && (
            <button
              type="button"
              onClick={goBack}
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md px-2 py-2 text-sm text-stone-500 transition-colors hover:text-stone-600"
            >
              <ArrowLeft className="h-4 w-4" /> Voltar
            </button>
          )}
        </div>
        {theme.show_branding && (
          <p className="text-xs text-stone-400">Feito com ProCRM</p>
        )}
      </footer>
    </div>
  );
}

function groupByDay(
  slots: Array<{ start: string; end: string }>,
  timeZone: string,
) {
  const map = new Map<string, { day: string; label: string; slots: Array<{ start: string; end: string }> }>();
  for (const s of slots) {
    const key = zonedDayKey(s.start, timeZone);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, { day: key, label: fmtShortDay(key), slots: [] });
    }
    map.get(key)!.slots.push(s);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

function monthFromDayKey(dayKey: string): { y: number; m: number } {
  const [y, m] = dayKey.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  }
  return { y, m: m - 1 };
}

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function fmtLongDay(iso: string, timeZone: string) {
  const s = new Date(iso).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone,
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtShortDay(dayKey: string) {
  // A chave já é a data local da agenda; formatar em UTC evita deslocar
  // o dia ao passar por fusos negativos.
  return new Date(`${dayKey}T12:00:00Z`).toLocaleDateString("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
}

function fmtTime(iso: string, timeZone: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}

function tzLabel(tz?: string | null) {
  if (!tz) return "";
  if (tz === "America/Sao_Paulo") return "Horário de Brasília";
  if (tz === "America/Manaus") return "Horário de Manaus";
  if (tz === "America/Rio_Branco") return "Horário do Acre";
  return tz.replace(/_/g, " ");
}

/**
 * Mini-calendário mensal estilo Calendly: só dias com disponibilidade
 * são clicáveis (com ponto indicador); os demais ficam apagados.
 */
function MonthCalendar({
  avail,
  selected,
  view,
  minMonth,
  maxMonth,
  todayKey,
  accent,
  onView,
  onSelect,
}: {
  avail: Set<string>;
  selected: string | null;
  view: { y: number; m: number };
  minMonth: string | null;
  maxMonth: string | null;
  /** "Hoje" no fuso da agenda, não no fuso do visitante. */
  todayKey: string;
  accent: string;
  onView: (v: { y: number; m: number }) => void;
  onSelect: (day: string) => void;
}) {
  const { y, m } = view;
  const onAccent = contrastOn(accent);
  const viewKey = `${y}-${pad2(m + 1)}`;
  const monthName = new Date(y, m, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());
  const startOffset = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();

  function shift(dir: 1 | -1) {
    const d = new Date(y, m + dir, 1);
    onView({ y: d.getFullYear(), m: d.getMonth() });
  }

  const cells: Array<{ key: string; day: number } | null> = [];
  for (let i = 0; i < startOffset; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ key: `${y}-${pad2(m + 1)}-${pad2(d)}`, day: d });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-stone-800">{monthName}</p>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shift(-1)}
            disabled={!!minMonth && viewKey <= minMonth}
            aria-label="Mês anterior"
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => shift(1)}
            disabled={!!maxMonth && viewKey >= maxMonth}
            aria-label="Próximo mês"
            className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 transition-colors hover:bg-stone-100 disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-7 gap-y-1 text-center">
        {["D", "S", "T", "Q", "Q", "S", "S"].map((w, i) => (
          <span key={i} className="pb-1 text-[11px] font-medium uppercase text-stone-500">
            {w}
          </span>
        ))}
        {cells.map((c, i) => {
          if (!c) return <span key={`e${i}`} />;
          const has = avail.has(c.key);
          const isSel = selected === c.key;
          const isPast = c.key < todayKey;
          const disabled = !has || isPast;
          return (
            <button
              type="button"
              key={c.key}
              disabled={disabled}
              onClick={() => onSelect(c.key)}
              aria-pressed={isSel}
              aria-label={fmtShortDay(c.key)}
              className="mx-auto flex h-10 w-10 flex-col items-center justify-center rounded-full text-sm transition-all duration-150 active:scale-95"
              style={
                isSel
                  ? { background: accent, color: onAccent, fontWeight: 600 }
                  : has && !isPast
                    ? { color: "#1c1917", fontWeight: 500 }
                    : { color: "#d6d3d1" }
              }
              onMouseEnter={(e) => {
                if (!disabled && !isSel) e.currentTarget.style.background = "#f5f5f4";
              }}
              onMouseLeave={(e) => {
                if (!isSel) e.currentTarget.style.background = "transparent";
              }}
            >
              {c.day}
              {has && !isPast && !isSel && (
                <span className="mt-0.5 h-1 w-1 rounded-full" style={{ background: accent, color: onAccent }} />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
