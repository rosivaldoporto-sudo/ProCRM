"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Search,
  Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type BookingStatus = "scheduled" | "cancelled" | "completed" | "no_show";

interface Booking {
  id: string;
  form_id: string;
  attendee_name: string;
  attendee_email: string | null;
  attendee_phone: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  status: BookingStatus;
  meeting_title: string | null;
  notes: string | null;
  created_at: string;
  lead_forms: { id: string; name: string; slug: string } | null;
}

interface FormOption {
  id: string;
  name: string;
}

const STATUS_META: Record<BookingStatus, { label: string; className: string; dot: string }> = {
  scheduled: {
    label: "Agendado",
    className: "border-sky-600/40 bg-sky-500/10 text-sky-300",
    dot: "bg-sky-400",
  },
  completed: {
    label: "Concluído",
    className: "border-emerald-600/40 bg-emerald-500/10 text-emerald-300",
    dot: "bg-emerald-400",
  },
  cancelled: {
    label: "Cancelado",
    className: "border-red-600/40 bg-red-500/10 text-red-300",
    dot: "bg-red-400",
  },
  no_show: {
    label: "Faltou",
    className: "border-amber-600/40 bg-amber-500/10 text-amber-300",
    dot: "bg-amber-400",
  },
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function dayKeyLocal(d: Date) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDayLong(key: string) {
  const s = new Date(`${key}T12:00:00`).toLocaleDateString("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default function FormsAgendaPage() {
  const router = useRouter();
  const today = useMemo(() => new Date(), []);
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [selectedDay, setSelectedDay] = useState<string>(dayKeyLocal(today));
  const [forms, setForms] = useState<FormOption[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [formFilter, setFormFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState<Booking | null>(null);

  // Janela da grade: 1º dia do mês - 7d até último dia + 7d (cobre dias vizinhos).
  const windowRange = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const last = new Date(view.y, view.m + 1, 0);
    const from = new Date(first);
    from.setDate(from.getDate() - 7);
    const to = new Date(last);
    to.setDate(to.getDate() + 7);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [view]);

  const fetchBookings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: windowRange.from,
        to: windowRange.to,
      });
      if (formFilter !== "all") params.set("form_id", formFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const res = await fetch(`/api/lead-forms/bookings?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { bookings: Booking[] };
      setBookings(json.bookings ?? []);
    } catch {
      toast.error("Não foi possível carregar os agendamentos");
    } finally {
      setLoading(false);
    }
  }, [windowRange, formFilter, statusFilter]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/lead-forms", { cache: "no-store" });
        if (res.ok) {
          const json = (await res.json()) as { forms: FormOption[] };
          setForms(json.forms ?? []);
        }
      } catch {
        /* filtros de formulário ficam indisponíveis, o resto funciona */
      }
    })();
  }, []);

  useEffect(() => {
    void fetchBookings();
  }, [fetchBookings]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return bookings;
    return bookings.filter((b) =>
      [b.attendee_name, b.attendee_email, b.attendee_phone, b.lead_forms?.name]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q)
    );
  }, [bookings, search]);

  const byDay = useMemo(() => {
    const map = new Map<string, Booking[]>();
    for (const b of filtered) {
      const key = dayKeyLocal(new Date(b.starts_at));
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    for (const list of map.values()) {
      list.sort((a, c) => +new Date(a.starts_at) - +new Date(c.starts_at));
    }
    return map;
  }, [filtered]);

  const selectedBookings = byDay.get(selectedDay) ?? [];
  const monthTotal = filtered.length;
  const upcomingTotal = useMemo(() => {
    const now = Date.now();
    return filtered.filter(
      (b) => b.status === "scheduled" && +new Date(b.starts_at) >= now
    ).length;
  }, [filtered]);

  // Grade do mês (Semana começa no domingo).
  const cells = useMemo(() => {
    const startOffset = new Date(view.y, view.m, 1).getDay();
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const out: Array<{ key: string; day: number; inMonth: boolean }> = [];
    for (let i = 0; i < startOffset; i++) {
      const d = new Date(view.y, view.m, 1 - startOffset + i);
      out.push({ key: dayKeyLocal(d), day: d.getDate(), inMonth: false });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({
        key: `${view.y}-${pad2(view.m + 1)}-${pad2(d)}`,
        day: d,
        inMonth: true,
      });
    }
    while (out.length % 7 !== 0) {
      const last = out[out.length - 1];
      const base = last && last.key ? new Date(`${last.key}T12:00:00`) : new Date(view.y, view.m, daysInMonth);
      const d = new Date(base);
      d.setDate(d.getDate() + 1);
      out.push({ key: dayKeyLocal(d), day: d.getDate(), inMonth: false });
    }
    return out;
  }, [view]);

  const monthLabel = new Date(view.y, view.m, 1)
    .toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
    .replace(/^./, (c) => c.toUpperCase());

  function shiftMonth(dir: 1 | -1) {
    setView((v) => {
      const d = new Date(v.y, v.m + dir, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  }

  function goToday() {
    const t = new Date();
    setView({ y: t.getFullYear(), m: t.getMonth() });
    setSelectedDay(dayKeyLocal(t));
  }

  const todayKey = dayKeyLocal(today);

  return (
    <div className="space-y-5 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => router.push("/lead-forms")} className="mb-2 -ml-2 text-muted-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Formulários
          </Button>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <CalendarDays className="h-6 w-6" /> Agenda
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Todos os agendamentos de todos os formulários em um só calendário.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            {monthTotal} neste período
          </Badge>
          <Badge variant="outline" className="border-sky-600/40 bg-sky-500/10 text-xs text-sky-300">
            {upcomingTotal} futuros
          </Badge>
        </div>
      </header>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-52 flex-1">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, e-mail, telefone…"
            className="pl-9"
          />
        </div>
        <Select value={formFilter} onValueChange={(v) => setFormFilter(v ?? "all")}>
          <SelectTrigger className="w-52">
            <SelectValue placeholder="Formulário" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os formulários</SelectItem>
            {forms.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "all")}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="Situação" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os status</SelectItem>
            {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_META[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={goToday}>
          Hoje
        </Button>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1fr_340px]">
        {/* Calendário */}
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-base font-semibold text-foreground">{monthLabel}</p>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => shiftMonth(-1)} aria-label="Mês anterior">
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => shiftMonth(1)} aria-label="Próximo mês">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-1">
              {["D", "S", "T", "Q", "Q", "S", "S"].map((w, i) => (
                <div key={i} className="pb-1 text-center text-[11px] font-medium text-muted-foreground uppercase">
                  {w}
                </div>
              ))}
              {cells.map((c) => {
                const list = byDay.get(c.key) ?? [];
                const isSel = selectedDay === c.key;
                const isToday = todayKey === c.key;
                return (
                  <button
                    key={c.key}
                    onClick={() => setSelectedDay(c.key)}
                    className={cn(
                      "flex min-h-20 flex-col rounded-md border p-1 text-left transition-colors sm:min-h-24",
                      isSel
                        ? "border-primary/60 bg-primary/10"
                        : "border-border bg-card hover:border-primary/30",
                      !c.inMonth && "opacity-45"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium",
                        isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground"
                      )}
                    >
                      {c.day}
                    </span>
                    <div className="mt-1 hidden space-y-1 sm:block">
                      {list.slice(0, 3).map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[10px]"
                          style={{ background: "color-mix(in srgb, var(--primary) 12%, transparent)" }}
                        >
                          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", STATUS_META[b.status].dot)} />
                          <span className="truncate text-foreground">
                            {fmtTime(b.starts_at)} {b.attendee_name.split(" ")[0]}
                          </span>
                        </div>
                      ))}
                      {list.length > 3 && (
                        <p className="px-1 text-[10px] text-muted-foreground">+{list.length - 3}</p>
                      )}
                    </div>
                    {list.length > 0 && (
                      <div className="mt-auto flex gap-0.5 pt-1 sm:hidden">
                        {list.slice(0, 4).map((b) => (
                          <span key={b.id} className={cn("h-1.5 w-1.5 rounded-full", STATUS_META[b.status].dot)} />
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Dia selecionado */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-semibold text-foreground">{fmtDayLong(selectedDay)}</p>
          <p className="text-xs text-muted-foreground">
            {selectedBookings.length === 0
              ? "Nenhum agendamento"
              : `${selectedBookings.length} agendamento${selectedBookings.length > 1 ? "s" : ""}`}
          </p>
          <div className="mt-3 space-y-2">
            {selectedBookings.length === 0 && (
              <p className="rounded-md border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
                Nada agendado para este dia.
              </p>
            )}
            {selectedBookings.map((b) => (
              <button
                key={b.id}
                onClick={() => setDetail(b)}
                className="w-full rounded-md border border-border bg-muted/40 p-3 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
                    <Clock className="h-3.5 w-3.5 text-primary" />
                    {fmtTime(b.starts_at)}
                  </span>
                  <Badge variant="outline" className={cn("text-[10px]", STATUS_META[b.status].className)}>
                    {STATUS_META[b.status].label}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-sm text-foreground">{b.attendee_name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {b.meeting_title ?? b.lead_forms?.name ?? "Reunião"}
                </p>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Detalhes */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Video className="h-4 w-4" /> {detail?.meeting_title ?? "Reunião"}
            </DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 font-medium">
                  <Clock className="h-4 w-4 text-primary" />
                  {new Date(detail.starts_at).toLocaleDateString("pt-BR", {
                    weekday: "short",
                    day: "2-digit",
                    month: "short",
                  })}{" "}
                  · {fmtTime(detail.starts_at)} às {fmtTime(detail.ends_at)}
                </span>
                <Badge variant="outline" className={cn("text-[10px]", STATUS_META[detail.status].className)}>
                  {STATUS_META[detail.status].label}
                </Badge>
              </div>
              <dl className="space-y-1.5 rounded-md border border-border p-3">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Participante</dt>
                  <dd className="text-right font-medium">{detail.attendee_name}</dd>
                </div>
                {detail.attendee_email && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">E-mail</dt>
                    <dd className="truncate text-right">{detail.attendee_email}</dd>
                  </div>
                )}
                {detail.attendee_phone && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Telefone</dt>
                    <dd className="text-right">{detail.attendee_phone}</dd>
                  </div>
                )}
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Formulário</dt>
                  <dd className="text-right">{detail.lead_forms?.name ?? "Não informado"}</dd>
                </div>
                {detail.notes && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted-foreground">Notas</dt>
                    <dd className="max-w-56 truncate text-right">{detail.notes}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
