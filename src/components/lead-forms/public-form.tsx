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
} from "lucide-react";
import { trackFormPixel } from "@/lib/lead-forms/meta-pixel";

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

interface PublicFormData {
  form: {
    id: string; name: string;
    theme: { primary_color: string; background: string; font: string; avatar_url: string | null; logo_url: string | null; welcome_title: string; welcome_subtitle: string; button_text: string; show_branding: boolean; bubble_user: string; bubble_bot: string };
    scheduling: { enabled: boolean; duration_min: number; timezone: string; meeting_title: string };
    pixel_id: string | null;
  };
  blocks: PublicBlock[];
}

function getTracking() {
  if (typeof window === "undefined") return {};
  const qs = new URLSearchParams(window.location.search);
  const cookies = Object.fromEntries(document.cookie.split(";").map((c) => {
    const [k, ...rest] = c.trim().split("=");
    return [k, rest.join("=")];
  }));
  return {
    utm_source: qs.get("utm_source") ?? undefined,
    utm_campaign: qs.get("utm_campaign") ?? undefined,
    utm_medium: qs.get("utm_medium") ?? undefined,
    utm_term: qs.get("utm_term") ?? undefined,
    utm_content: qs.get("utm_content") ?? undefined,
    fbclid: qs.get("fbclid") ?? undefined,
    fbp: cookies._fbp,
    fbc: cookies._fbc,
    source_url: window.location.href,
  };
}

const LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

export function PublicForm({ slug, nonce }: { slug: string; nonce?: string }) {
  const [data, setData] = useState<PublicFormData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [done, setDone] = useState<{ score: number; is_qualified: boolean; message: string; response_id: string } | null>(null);
  const [slots, setSlots] = useState<Array<{ start: string; end: string }>>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  const blocks = useMemo(() => (data?.blocks ?? []).filter((b) => b.type !== "meeting"), [data]);
  const theme = data?.form.theme;
  const pixelId = data?.form.pixel_id;
  const accent = theme?.primary_color && /^#[0-9a-fA-F]{6}$/.test(theme.primary_color)
    ? theme.primary_color
    : "#4f46e5";

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/forms/${slug}`);
        if (!res.ok) throw new Error("not found");
        const json = (await res.json()) as PublicFormData;
        setData(json);
      } catch {
        setError("Formulário não encontrado ou fora do ar.");
      }
    })();
  }, [slug]);

  // ViewContent no funil assim que o formulário carrega (o PageView
  // já é disparado pelo próprio snippet do pixel acima).
  useEffect(() => {
    if (!pixelId) return;
    const t = setTimeout(() => trackFormPixel(pixelId, "ViewContent", { content_name: slug }), 800);
    return () => clearTimeout(t);
  }, [pixelId, slug]);

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
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(pointer: fine)").matches
      ) {
        inputRef.current?.focus({ preventScroll: true });
      }
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, started]);

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
      if (digits.length < 10) return "Digite um WhatsApp válido com DDD.";
    }
    return null;
  }

  const advance = useCallback((value: unknown) => {
    const b = blocks[step];
    if (!b || busy) return;
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
    if (step + 1 < blocks.length) {
      setStep(step + 1);
    } else {
      void submit(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, step, busy, answers]);

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

  async function submit(finalAnswers: Record<string, unknown>) {
    setBusy(true);
    // Mesmo event_id no browser e no CAPI → a Meta deduplica
    // (redundant setup recomendado na doc do Conversions API).
    const clientEventId = newClientEventId();
    try {
      const res = await fetch(`/api/public/forms/${slug}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: finalAnswers, tracking: getTracking(), event_id: clientEventId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "submit failed");
      const r = json as { score: number; is_qualified: boolean; message: string; response_id: string; scheduling_enabled: boolean };
      setDone({ score: r.score, is_qualified: r.is_qualified, message: r.message, response_id: r.response_id });
      if (pixelId) {
        trackFormPixel(pixelId, "Lead", { content_name: slug }, clientEventId);
        if (r.is_qualified) trackFormPixel(pixelId, "CompleteRegistration", { content_name: slug });
      }
      if (r.is_qualified && r.scheduling_enabled) {
        void loadSlots();
      }
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : "Ops, tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  async function loadSlots() {
    setSlotsLoading(true);
    try {
      const res = await fetch(`/api/public/forms/${slug}/slots`);
      if (res.ok) {
        const json = await res.json() as { slots: Array<{ start: string; end: string }> };
        setSlots(json.slots ?? []);
      }
    } finally {
      setSlotsLoading(false);
    }
  }

  async function book() {
    if (!picked || !done) return;
    setBusy(true);
    try {
      const name = String(answers.nome ?? answers.name ?? "");
      const email = typeof answers.email === "string" ? answers.email : undefined;
      const phone = typeof answers.whatsapp === "string" ? answers.whatsapp : typeof answers.phone === "string" ? answers.phone : undefined;
      const res = await fetch(`/api/public/forms/${slug}/book`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response_id: done.response_id, starts_at: picked, name, email, phone }),
      });
      const json = (await res.json()) as { booking?: { id: string }; error?: string };
      if (!res.ok) throw new Error(json.error ?? "book failed");
      setBooked(true);
      // event_id idêntico ao do CAPI (`booking_<id>`) para deduplicar.
      if (pixelId && json.booking?.id) trackFormPixel(pixelId, "Schedule", { content_name: slug }, `booking_${json.booking.id}`);
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : "Horário indisponível.");
      void loadSlots();
    } finally {
      setBusy(false);
    }
  }

  // Atalhos de teclado: Enter avança (texto), A–C escolhem opção.
  useEffect(() => {
    if (!started || done || !current) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" && !busy) {
        const tag = (document.activeElement?.tagName ?? "").toLowerCase();
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
      if ((current.type === "choice_single" || current.type === "choice_multi") && /^[a-cA-C]$/.test(e.key)) {
        const idx = e.key.toLowerCase().charCodeAt(0) - 97;
        const opt = current.config.options?.[idx];
        if (!opt) return;
        if (current.type === "choice_single") {
          advance(opt.value);
        } else {
          setMulti((m) => (m.includes(opt.value) ? m.filter((x) => x !== opt.value) : [...m, opt.value]));
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [started, done, current, busy, input, multi, advance]);

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#fafaf9] p-6 text-center">
        <p className="max-w-sm text-lg text-stone-500">{error}</p>
      </div>
    );
  }
  if (!data || !theme) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[#fafaf9]">
        <Loader2 className="h-6 w-6 animate-spin text-stone-400" />
      </div>
    );
  }

  const progress = blocks.length
    ? Math.round(((done ? blocks.length : step) / blocks.length) * 100)
    : 0;
  const grouped = groupByDay(slots);
  const fontStack = `${theme.font}, Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;

  return (
    <div
      className="flex min-h-dvh flex-col bg-[#fafaf9] text-stone-800 antialiased"
      style={{ fontFamily: fontStack }}
    >
      <style>{`
        @keyframes rise { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        .animate-rise { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) both; }
        .animate-rise-d1 { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.06s both; }
        .animate-rise-d2 { animation: rise 0.45s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both; }
      `}</style>
      {pixelId && <MetaPixelSnippet pixelId={pixelId} nonce={nonce} />}

      {/* Barra de progresso fina */}
      <div className="fixed inset-x-0 top-0 z-10 h-[3px] bg-stone-200/70">
        <div
          className="h-full transition-[width] duration-500 ease-out"
          style={{ width: `${started ? progress : 0}%`, background: accent }}
        />
      </div>

      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16 sm:px-10">
        {!started ? (
          <div key="welcome" className="animate-rise">
            {theme.logo_url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={theme.logo_url} alt="" className="mb-10 h-10 object-contain object-left" />
            )}
            <h1 className="text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              {theme.welcome_title}
            </h1>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-stone-500">
              {theme.welcome_subtitle}
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <button
                onClick={() => setStarted(true)}
                className="rounded-lg px-7 py-3.5 text-base font-medium text-white shadow-sm transition-transform duration-150 hover:brightness-105 active:scale-[0.98]"
                style={{ background: accent }}
              >
                {theme.button_text}
              </button>
              <span className="text-sm text-stone-400">Leva menos de 1 minuto</span>
            </div>
          </div>
        ) : done ? (
          <div key="done" className="animate-rise">
            <div
              className="flex h-12 w-12 items-center justify-center rounded-full"
              style={{ background: `${accent}14`, color: accent }}
            >
              <Check className="h-6 w-6" />
            </div>
            <h2 className="mt-6 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              Obrigado!
            </h2>
            <p className="mt-4 max-w-lg text-lg leading-relaxed text-stone-500">
              {done.message}
            </p>

            {done.is_qualified && !booked && (
              <div className="animate-rise-d1 mt-10">
                <p className="flex items-center gap-2 text-base font-medium text-stone-900">
                  <CalendarDays className="h-5 w-5" style={{ color: accent }} />
                  Escolha um horário
                </p>
                {slotsLoading && <p className="mt-3 text-sm text-stone-400">Carregando agenda…</p>}
                {!slotsLoading && slots.length === 0 && (
                  <p className="mt-3 text-sm text-stone-400">Sem horários livres nos próximos dias.</p>
                )}
                {grouped.slice(0, 5).map((g) => (
                  <div key={g.day} className="mt-5">
                    <p className="text-xs font-medium uppercase tracking-widest text-stone-400">{g.label}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {g.slots.slice(0, 8).map((s) => {
                        const active = picked === s.start;
                        return (
                          <button
                            key={s.start}
                            onClick={() => setPicked(s.start)}
                            className="min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-all duration-150 active:scale-[0.97]"
                            style={active
                              ? { background: accent, borderColor: accent, color: "#fff" }
                              : { borderColor: "#e7e5e4", color: "#44403c", background: "#fff" }}
                          >
                            {new Date(s.start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
                {picked && (
                  <div className="mt-8 flex flex-wrap items-center gap-4">
                    <button
                      onClick={book}
                      disabled={busy}
                      className="rounded-lg px-7 py-3 text-base font-medium text-white shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                      style={{ background: accent }}
                    >
                      {busy ? "Agendando…" : "Confirmar reunião"}
                    </button>
                  </div>
                )}
              </div>
            )}
            {booked && (
              <div
                className="mt-8 flex items-center gap-3 rounded-xl border px-5 py-4 text-base"
                style={{ borderColor: `${accent}45`, background: `${accent}0d`, color: "#44403c" }}
              >
                <Check className="h-5 w-5 shrink-0" style={{ color: accent }} />
                Agendado! Você receberá a confirmação.
              </div>
            )}
            {fieldError && <p className="mt-4 text-sm text-red-500">{fieldError}</p>}
          </div>
        ) : current ? (
          <div key={`${step}-${blocks.length}`} className="animate-rise">
            <p className="text-sm font-medium text-stone-400">
              {step + 1} de {blocks.length}
              {current.config.required && <span className="ml-2 text-stone-300">· obrigatória</span>}
            </p>
            <h2 className="mt-3 text-3xl font-medium leading-tight tracking-tight text-stone-900 sm:text-4xl">
              {current.config.label}
            </h2>
            {current.config.help_text && (
              <p className="mt-3 max-w-lg text-base leading-relaxed text-stone-400">
                {current.config.help_text}
              </p>
            )}

            <div className="animate-rise-d1 mt-8">
              {current.type === "choice_single" && (
                <div className="space-y-3">
                  {(current.config.options ?? []).map((o, i) => (
                    <button
                      key={o.value}
                      onClick={() => advance(o.value)}
                      className="group flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-4 text-left transition-all duration-150 hover:-translate-y-[1px] hover:shadow-sm active:scale-[0.99]"
                      style={{ borderColor: "#e7e5e4" }}
                      onMouseEnter={(e) => { e.currentTarget.style.borderColor = accent; }}
                      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
                    >
                      <span
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-sm font-semibold transition-colors duration-150"
                        style={{ borderColor: "#d6d3d1", color: "#78716c", background: "#fafaf9" }}
                      >
                        {LETTERS[i] ?? i + 1}
                      </span>
                      <span className="flex-1 text-lg text-stone-800">{o.label}</span>
                      <span
                        className="text-xs font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        style={{ color: accent }}
                      >
                        {LETTERS[i] ?? ""}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {current.type === "choice_multi" && (
                <div>
                  <div className="space-y-3">
                    {(current.config.options ?? []).map((o, i) => {
                      const selected = multi.includes(o.value);
                      return (
                        <button
                          key={o.value}
                          onClick={() => setMulti((m) => (m.includes(o.value) ? m.filter((x) => x !== o.value) : [...m, o.value]))}
                          className="flex w-full items-center gap-4 rounded-xl border bg-white px-4 py-4 text-left transition-all duration-150 hover:-translate-y-[1px] hover:shadow-sm active:scale-[0.99]"
                          style={selected
                            ? { borderColor: accent, background: `${accent}08` }
                            : { borderColor: "#e7e5e4" }}
                        >
                          <span
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-sm font-semibold transition-colors duration-150"
                            style={selected
                              ? { background: accent, borderColor: accent, color: "#fff" }
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
                      onClick={() => advance(multi)}
                      className="rounded-lg px-7 py-3 text-base font-medium text-white shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
                      style={{ background: accent }}
                    >
                      Continuar
                    </button>
                    <span className="text-sm text-stone-400">Pressione Enter ↵</span>
                  </div>
                </div>
              )}

              {current.type === "rating" && (
                <div className="flex items-center gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      onClick={() => advance(n)}
                      aria-label={`${n} de 5`}
                      className="p-1 transition-transform duration-150 hover:scale-110 active:scale-95"
                    >
                      <Star className="h-9 w-9" style={{ color: accent }} fill="none" strokeWidth={1.5} />
                    </button>
                  ))}
                </div>
              )}

              {current.type === "nps" && (
                <div className="flex max-w-lg flex-wrap gap-2">
                  {Array.from({ length: 11 }, (_, n) => (
                    <button
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
              )}

              {["short_text", "email", "phone", "number", "date", "file"].includes(current.type) && (
                <form
                  onSubmit={(e) => { e.preventDefault(); advance(input.trim()); }}
                  className="max-w-xl"
                >
                  <input
                    ref={inputRef as React.RefObject<HTMLInputElement>}
                    value={input}
                    onChange={(e) => { setInput(e.target.value); setFieldError(null); }}
                    placeholder={current.config.placeholder ?? "Digite sua resposta…"}
                    type={current.type === "email" ? "email" : current.type === "number" ? "number" : current.type === "date" ? "date" : current.type === "phone" ? "tel" : "text"}
                    className="w-full border-0 border-b-2 bg-transparent pb-3 text-2xl text-stone-900 outline-none transition-colors duration-150 placeholder:text-stone-300 sm:text-[28px]"
                    style={{ borderColor: "#e7e5e4" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
                  />
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium text-white shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                      style={{ background: accent }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Responder <ArrowRight className="h-4 w-4" /></>}
                    </button>
                    <span className="text-sm text-stone-400">Pressione Enter ↵</span>
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
                    rows={3}
                    className="w-full resize-none border-0 border-b-2 bg-transparent pb-3 text-2xl text-stone-900 outline-none transition-colors duration-150 placeholder:text-stone-300 sm:text-[28px]"
                    style={{ borderColor: "#e7e5e4" }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = accent; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "#e7e5e4"; }}
                  />
                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium text-white shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98] disabled:opacity-60"
                      style={{ background: accent }}
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <>Responder <ArrowRight className="h-4 w-4" /></>}
                    </button>
                    <span className="text-sm text-stone-400">Pressione Enter ↵</span>
                  </div>
                </form>
              )}

              {current.type === "statement" && (
                <div className="mt-2">
                  <button
                    onClick={() => advance("seen")}
                    className="inline-flex items-center gap-2 rounded-lg px-7 py-3 text-base font-medium text-white shadow-sm transition-all duration-150 hover:brightness-105 active:scale-[0.98]"
                    style={{ background: accent }}
                  >
                    Continuar <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>

            {fieldError && (
              <p className="animate-rise-d2 mt-5 max-w-lg text-sm text-red-500">{fieldError}</p>
            )}
          </div>
        ) : null}
      </main>

      {/* Navegação discreta */}
      <footer className="mx-auto flex w-full max-w-2xl items-center justify-between px-6 pb-8 sm:px-10">
        <div>
          {started && !done && step > 0 && (
            <button
              onClick={goBack}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-2 text-sm text-stone-400 transition-colors hover:text-stone-600"
            >
              <ArrowLeft className="h-4 w-4" /> Voltar
            </button>
          )}
        </div>
        {theme.show_branding && (
          <p className="text-xs text-stone-300">Feito com ProCRM</p>
        )}
      </footer>
    </div>
  );
}

function groupByDay(slots: Array<{ start: string; end: string }>) {
  const map = new Map<string, { day: string; label: string; slots: Array<{ start: string; end: string }> }>();
  for (const s of slots) {
    const key = new Date(s.start).toISOString().slice(0, 10);
    if (!map.has(key)) {
      map.set(key, {
        day: key,
        label: new Date(`${key}T12:00:00`).toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "short" }),
        slots: [],
      });
    }
    map.get(key)!.slots.push(s);
  }
  return [...map.values()];
}
