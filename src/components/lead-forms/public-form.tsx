"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Script from "next/script";
import { Loader2, Send, Star, Check, CalendarDays } from "lucide-react";
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

interface Msg {
  from: "bot" | "user";
  text: string;
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

export function PublicForm({ slug, nonce }: { slug: string; nonce?: string }) {
  const [data, setData] = useState<PublicFormData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [step, setStep] = useState(0);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [input, setInput] = useState("");
  const [multi, setMulti] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [typing, setTyping] = useState(false);
  const [done, setDone] = useState<{ score: number; is_qualified: boolean; message: string; response_id: string } | null>(null);
  const [slots, setSlots] = useState<Array<{ start: string; end: string }>>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [booked, setBooked] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const blocks = useMemo(() => (data?.blocks ?? []).filter((b) => b.type !== "meeting"), [data]);
  const theme = data?.form.theme;
  const pixelId = data?.form.pixel_id;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs, typing, step]);

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

  const pushBot = useCallback((text: string, delay = 500) => {
    setTyping(true);
    setTimeout(() => {
      setMsgs((m) => [...m, { from: "bot", text }]);
      setTyping(false);
    }, delay);
  }, []);

  function start() {
    if (!data) return;
    setStarted(true);
    pushBot(blocks[0]?.config.label ?? "Vamos lá!", 300);
  }

  function validateCurrent(value: unknown): string | null {
    const b = blocks[step];
    if (!b) return null;
    if (b.config.required && (value === "" || value === undefined || (Array.isArray(value) && value.length === 0))) {
      return "Esse campo é obrigatório 🙂";
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

  async function answerCurrent(value: unknown) {
    const b = blocks[step];
    if (!b || busy) return;
    const err = validateCurrent(value);
    if (err) {
      pushBot(err, 200);
      return;
    }
    const label = b.type === "choice_single" || b.type === "choice_multi"
      ? (Array.isArray(value) ? value.map((v) => b.config.options?.find((o) => o.value === v)?.label ?? v).join(", ") : (b.config.options?.find((o) => o.value === value)?.label ?? String(value)))
      : String(value);
    setMsgs((m) => [...m, { from: "user", text: label }]);
    const next = { ...answers, [b.key]: value };
    setAnswers(next);
    setInput("");
    setMulti([]);
    if (step + 1 < blocks.length) {
      setStep(step + 1);
      pushBot(blocks[step + 1].config.label, 600);
    } else {
      await submit(next);
    }
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
    setTyping(true);
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
      setMsgs((m) => [...m, { from: "bot", text: r.message }]);
      if (pixelId) {
        trackFormPixel(pixelId, "Lead", { content_name: slug }, clientEventId);
        if (r.is_qualified) trackFormPixel(pixelId, "CompleteRegistration", { content_name: slug });
      }
      if (r.is_qualified && r.scheduling_enabled) {
        void loadSlots();
      }
    } catch (err) {
      setMsgs((m) => [...m, { from: "bot", text: err instanceof Error ? err.message : "Ops, tente novamente." }]);
    } finally {
      setBusy(false);
      setTyping(false);
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
      setMsgs((m) => [...m, { from: "bot", text: `Reunião confirmada para ${new Date(picked).toLocaleString("pt-BR")} 🎉` }]);
      // event_id idêntico ao do CAPI (`booking_<id>`) para deduplicar.
      if (pixelId && json.booking?.id) trackFormPixel(pixelId, "Schedule", { content_name: slug }, `booking_${json.booking.id}`);
    } catch (err) {
      setMsgs((m) => [...m, { from: "bot", text: err instanceof Error ? err.message : "Horário indisponível." }]);
      void loadSlots();
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="flex min-h-screen items-center justify-center bg-[#0f0f14] p-6 text-center text-sm text-white/70">{error}</div>;
  }
  if (!data || !theme) {
    return <div className="flex min-h-screen items-center justify-center bg-[#0f0f14]"><Loader2 className="h-6 w-6 animate-spin text-white/60" /></div>;
  }

  const current = blocks[step];
  const progress = blocks.length ? Math.round(((done ? blocks.length : step) / blocks.length) * 100) : 0;
  const grouped = groupByDay(slots);

  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-8" style={{ background: theme.background, fontFamily: theme.font }}>
      {pixelId && <MetaPixelSnippet pixelId={pixelId} nonce={nonce} />}
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-white/10 shadow-2xl" style={{ background: "rgba(255,255,255,0.03)" }}>
        {/* header */}
        <div className="flex items-center gap-3 border-b border-white/10 p-4">
          {theme.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={theme.avatar_url} alt="avatar" className="h-10 w-10 rounded-full object-cover" />
          ) : (
            <div className="flex h-10 w-10 items-center justify-center rounded-full text-white" style={{ background: theme.primary_color }}>
              {data.form.name.charAt(0)}
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-white">{data.form.name}</p>
            <p className="flex items-center gap-1 text-[11px] text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online agora</p>
          </div>
        </div>
        {/* progress */}
        <div className="h-1 w-full bg-white/10">
          <div className="h-full transition-all" style={{ width: `${progress}%`, background: theme.primary_color }} />
        </div>

        {/* body */}
        <div className="max-h-[55vh] space-y-3 overflow-y-auto p-4">
          {!started ? (
            <div className="py-8 text-center">
              {theme.logo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={theme.logo_url} alt="logo" className="mx-auto mb-4 h-12 object-contain" />
              )}
              <h1 className="text-2xl font-bold text-white">{theme.welcome_title}</h1>
              <p className="mt-2 text-sm text-white/60">{theme.welcome_subtitle}</p>
              <button onClick={start} className="mt-6 rounded-full px-8 py-3 text-sm font-semibold text-white" style={{ background: theme.primary_color }}>
                {theme.button_text}
              </button>
            </div>
          ) : (
            <>
              {msgs.map((m, i) => (
                <div key={i} className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className="max-w-[85%] rounded-2xl px-4 py-2.5 text-sm"
                    style={m.from === "user"
                      ? { background: theme.bubble_user, color: "#fff", borderBottomRightRadius: 4 }
                      : { background: theme.bubble_bot, color: "#fff", borderBottomLeftRadius: 4 }}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {typing && <div className="flex justify-start"><div className="animate-pulse rounded-2xl px-4 py-2 text-sm text-white/60" style={{ background: theme.bubble_bot }}>digitando…</div></div>}

              {/* slots */}
              {done?.is_qualified && !booked && (
                <div className="rounded-2xl border border-white/10 p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold text-white"><CalendarDays className="h-4 w-4" /> Escolha um horário</p>
                  {slotsLoading && <p className="mt-2 text-xs text-white/60">Carregando agenda…</p>}
                  {!slotsLoading && slots.length === 0 && <p className="mt-2 text-xs text-white/60">Sem horários livres nos próximos dias.</p>}
                  {grouped.slice(0, 5).map((g) => (
                    <div key={g.day} className="mt-2">
                      <p className="text-[11px] uppercase tracking-wide text-white/50">{g.label}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {g.slots.slice(0, 6).map((s) => (
                          <button
                            key={s.start}
                            onClick={() => setPicked(s.start)}
                            className="rounded-full border px-3 py-1 text-xs"
                            style={picked === s.start
                              ? { background: theme.primary_color, color: "#fff", borderColor: theme.primary_color }
                              : { borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}
                          >
                            {new Date(s.start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  {picked && (
                    <button onClick={book} disabled={busy} className="mt-3 w-full rounded-full py-2.5 text-sm font-semibold text-white" style={{ background: theme.primary_color }}>
                      {busy ? "Agendando…" : "Confirmar reunião"}
                    </button>
                  )}
                </div>
              )}
              {booked && <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200"><Check className="h-4 w-4" /> Agendado! Você receberá a confirmação.</div>}
              <div ref={bottomRef} />
            </>
          )}
        </div>

        {/* input */}
        {started && !done && current && (
          <div className="border-t border-white/10 p-3">
            {(current.type === "choice_single") && (
              <div className="flex flex-wrap gap-2">
                {(current.config.options ?? []).map((o) => (
                  <button key={o.value} onClick={() => answerCurrent(o.value)} className="rounded-full border px-4 py-2 text-sm text-white hover:opacity-90" style={{ borderColor: theme.primary_color }}>
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {(current.type === "choice_multi") && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {(current.config.options ?? []).map((o) => (
                    <button key={o.value} onClick={() => setMulti((m) => m.includes(o.value) ? m.filter((x) => x !== o.value) : [...m, o.value])}
                      className="rounded-full border px-4 py-2 text-sm"
                      style={multi.includes(o.value) ? { background: theme.primary_color, color: "#fff" } : { borderColor: "rgba(255,255,255,0.2)", color: "#fff" }}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <button onClick={() => answerCurrent(multi)} className="w-full rounded-full py-2.5 text-sm font-semibold text-white" style={{ background: theme.primary_color }}>Continuar</button>
              </div>
            )}
            {(current.type === "rating") && (
              <div className="flex items-center justify-center gap-2">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} onClick={() => answerCurrent(n)}><Star className="h-8 w-8" style={{ color: theme.primary_color }} fill={theme.primary_color} /></button>
                ))}
              </div>
            )}
            {(current.type === "nps") && (
              <div className="flex flex-wrap justify-center gap-1.5">
                {Array.from({ length: 11 }, (_, n) => (
                  <button key={n} onClick={() => answerCurrent(n)} className="h-9 w-9 rounded-lg border text-sm text-white" style={{ borderColor: "rgba(255,255,255,0.2)" }}>{n}</button>
                ))}
              </div>
            )}
            {["short_text", "long_text", "email", "phone", "number", "date", "file", "statement"].includes(current.type) && (
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); answerCurrent(input.trim()); }}>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={current.config.placeholder ?? "Digite aqui…"}
                  type={current.type === "email" ? "email" : current.type === "number" ? "number" : current.type === "date" ? "date" : "text"}
                  className="flex-1 rounded-full border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-white outline-none placeholder:text-white/40"
                />
                <button type="submit" className="flex h-10 w-10 items-center justify-center rounded-full text-white" style={{ background: theme.primary_color }}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </button>
              </form>
            )}
            {current.config.help_text && <p className="mt-1 text-[11px] text-white/40">{current.config.help_text}</p>}
          </div>
        )}

        {theme.show_branding && (
          <p className="border-t border-white/10 p-2 text-center text-[10px] text-white/30">Feito com ProCRM · Formulários</p>
        )}
      </div>
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
