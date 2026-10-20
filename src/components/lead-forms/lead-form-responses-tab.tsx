"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarCheck, ChevronDown, Download, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  attributionLabel,
  normalizeAttribution,
  type Attribution,
  type TrackingBag,
} from "@/lib/lead-forms/attribution";
import { cn } from "@/lib/utils";

interface ResponseRow {
  id: string;
  respondent_name?: string;
  respondent_email?: string;
  respondent_phone?: string;
  score: number;
  is_qualified: boolean;
  status: string;
  created_at: string;
  answers: Record<string, unknown>;
  tracking?: TrackingBag | null;
}

interface BookingRow {
  id: string;
  response_id?: string;
  attendee_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
}

interface Props {
  responses: Array<Record<string, unknown>>;
  bookings: Array<Record<string, unknown>>;
}

interface Enriched extends ResponseRow {
  attribution: Attribution;
  booked: boolean;
}

const SOURCE_DOT: Record<string, string> = {
  meta: "bg-sky-400",
  google: "bg-red-400",
  tiktok: "bg-zinc-100",
  bing: "bg-emerald-400",
  linkedin: "bg-blue-500",
  whatsapp: "bg-green-400",
  referral: "bg-violet-400",
  direct: "bg-stone-400",
};

function csvEscape(v: unknown): string {
  let s = v == null ? "" : String(v);
  // Anti formula-injection: células iniciadas por = + - @ | executam código
  // ao abrir no Excel/Sheets. O prefixo ' neutraliza sem alterar o visível.
  if (/^[=+\-@|\t\r]/.test(s)) s = `'${s}`;
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function LeadFormResponsesTab({ responses, bookings }: Props) {
  const [search, setSearch] = useState("");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [qualifiedFilter, setQualifiedFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);

  const bookedIds = useMemo(() => {
    const s = new Set<string>();
    for (const b of bookings) {
      const id = (b as unknown as BookingRow).response_id;
      if (typeof id === "string") s.add(id);
    }
    return s;
  }, [bookings]);

  const enriched: Enriched[] = useMemo(
    () =>
      (responses as unknown as ResponseRow[]).map((r) => ({
        ...r,
        attribution: normalizeAttribution(r.tracking ?? null),
        booked: bookedIds.has(r.id),
      })),
    [responses, bookedIds]
  );

  const campaigns = useMemo(() => {
    const s = new Map<string, number>();
    for (const r of enriched) {
      const key = r.attribution.campaign ?? "(sem campanha)";
      s.set(key, (s.get(key) ?? 0) + 1);
    }
    return [...s.entries()].sort((a, b) => b[1] - a[1]);
  }, [enriched]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return enriched.filter((r) => {
      if (campaignFilter !== "all") {
        const key = r.attribution.campaign ?? "(sem campanha)";
        if (key !== campaignFilter) return false;
      }
      if (qualifiedFilter === "incomplete" && r.status !== "started") return false;
      if (qualifiedFilter === "qualified" && (!r.is_qualified || r.status === "started")) return false;
      if (qualifiedFilter === "disqualified" && (r.is_qualified || r.status === "started")) return false;
      if (qualifiedFilter === "booked" && !r.booked) return false;
      if (!q) return true;
      return [r.respondent_name, r.respondent_email, r.respondent_phone, r.attribution.campaign, r.attribution.ad]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [enriched, search, campaignFilter, qualifiedFilter]);

  function handleExport() {
    if (filtered.length === 0) {
      toast.error("Nada para exportar com os filtros atuais");
      return;
    }
    const header = ["nome", "email", "telefone", "score", "qualificado", "status", "agendou", "origem", "campanha", "conjunto", "anuncio", "data"];
    const lines = filtered.map((r) =>
      [
        r.respondent_name ?? "",
        r.respondent_email ?? "",
        r.respondent_phone ?? "",
        r.score,
        r.is_qualified ? "sim" : "não",
        r.status,
        r.booked ? "sim" : "não",
        r.attribution.sourceLabel,
        r.attribution.campaign ?? "",
        r.attribution.adset ?? "",
        r.attribution.ad ?? "",
        new Date(r.created_at).toLocaleString("pt-BR"),
      ]
        .map(csvEscape)
        .join(";")
    );
    const blob = new Blob([[header.join(";"), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `respostas-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`${filtered.length} respostas exportadas`);
  }

  return (
    <div className="space-y-3">
      {/* Resumo por campanha */}
      {campaigns.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {campaigns.slice(0, 6).map(([name, count]) => (
            <button key={name} onClick={() => setCampaignFilter(name)} title="Filtrar por esta campanha">
              <Badge
                variant="outline"
                className={cn(
                  "cursor-pointer text-[11px]",
                  campaignFilter === name && "border-primary/60 bg-primary/10"
                )}
              >
                {name} · {count}
              </Badge>
            </button>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle>Respostas</CardTitle>
              <CardDescription>
                {filtered.length} de {responses.length} respostas · {bookings.length} agendamentos
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-3.5 w-3.5" /> Exportar CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar nome, e-mail, campanha…"
                className="pl-9"
              />
            </div>
            <Select value={campaignFilter} onValueChange={(v) => setCampaignFilter(v ?? "all")}>
              <SelectTrigger className="w-48"><SelectValue placeholder="Campanha" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as campanhas</SelectItem>
                {campaigns.map(([name, count]) => (
                  <SelectItem key={name} value={name}>
                    {name} ({count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={qualifiedFilter} onValueChange={(v) => setQualifiedFilter(v ?? "all")}>
              <SelectTrigger className="w-40"><SelectValue placeholder="Situação" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="incomplete">Em preenchimento</SelectItem>
                <SelectItem value="qualified">Qualificados</SelectItem>
                <SelectItem value="disqualified">Desqualificados</SelectItem>
                <SelectItem value="booked">Agendaram</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {filtered.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-medium text-foreground">
                {responses.length === 0 ? "Nenhuma resposta ainda" : "Nada com estes filtros"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {responses.length === 0
                  ? "Compartilhe o link do formulário (aba Compartilhar) para começar."
                  : "Ajuste a busca ou limpe os filtros."}
              </p>
            </div>
          )}

          {filtered.map((row) => {
            const open = openId === row.id;
            return (
              <div key={row.id} className="rounded-lg border border-border">
                <button
                  onClick={() => setOpenId(open ? null : row.id)}
                  className="flex w-full items-center gap-3 p-3 text-left"
                  aria-expanded={open}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <strong className="truncate text-sm text-foreground">
                        {String(row.respondent_name ?? "Anônimo")}
                      </strong>
                      {row.status === "started" ? (
                        <Badge variant="outline" className="border-amber-600/40 bg-amber-500/10 text-[10px] text-amber-300">
                          Em preenchimento
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px]">
                          {row.is_qualified ? `Qualificado · ${row.score}` : `Pontuação ${row.score}`}
                        </Badge>
                      )}
                      {row.booked && (
                        <Badge variant="outline" className="border-emerald-600/40 bg-emerald-500/10 text-[10px] text-emerald-300">
                          <CalendarCheck className="mr-1 h-3 w-3" /> Agendou
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <span className={cn("h-1.5 w-1.5 rounded-full", SOURCE_DOT[row.attribution.source] ?? "bg-stone-400")} />
                        {row.attribution.sourceLabel}
                      </span>
                      <span className="truncate">· {attributionLabel(row.attribution)}</span>
                      {row.respondent_phone && (
                        <span className="truncate">· {row.respondent_phone}</span>
                      )}
                      <span>· {new Date(row.created_at).toLocaleString("pt-BR")}</span>
                    </div>
                  </div>
                  <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
                </button>
                {open && (
                  <div className="space-y-2 border-t border-border p-3">
                    {(row.attribution.campaign || row.attribution.ad || row.attribution.placement) && (
                      <dl className="grid grid-cols-1 gap-1 rounded bg-muted p-2 text-[11px] sm:grid-cols-2">
                        {row.attribution.campaign && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Campanha</dt>
                            <dd className="truncate font-medium">{row.attribution.campaign}</dd>
                          </div>
                        )}
                        {row.attribution.adset && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Conjunto</dt>
                            <dd className="truncate font-medium">{row.attribution.adset}</dd>
                          </div>
                        )}
                        {row.attribution.ad && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Anúncio</dt>
                            <dd className="truncate font-medium">{row.attribution.ad}</dd>
                          </div>
                        )}
                        {row.attribution.placement && (
                          <div className="flex justify-between gap-2">
                            <dt className="text-muted-foreground">Posicionamento</dt>
                            <dd className="truncate font-medium">{row.attribution.placement}</dd>
                          </div>
                        )}
                      </dl>
                    )}
                    <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-[11px]">
                      {JSON.stringify(row.answers, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
