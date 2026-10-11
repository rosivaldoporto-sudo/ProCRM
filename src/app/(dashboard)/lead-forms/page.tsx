"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ClipboardList, Plus, Pencil, Trash2, Loader2, ExternalLink, BarChart3, CalendarDays, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";

interface LeadFormRow {
  id: string;
  name: string;
  slug: string;
  status: "draft" | "published" | "archived";
  view_count: number;
  response_count: number;
  qualified_count: number;
  booked_count: number;
  created_at: string;
}

export default function LeadFormsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const [forms, setForms] = useState<LeadFormRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/lead-forms");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as { forms: LeadFormRow[] };
        if (!cancelled) setForms(json.forms ?? []);
      } catch {
        // Sem console.* aqui: erro de rede não carrega PII e o toast já informa.
        if (!cancelled) toast.error("Não foi possível carregar os formulários");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/lead-forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { form: LeadFormRow };
      setOpen(false);
      setName("");
      router.push(`/lead-forms/${json.form.id}`);
    } catch {
      toast.error("Falha ao criar formulário");
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(f: LeadFormRow) {
    if (!window.confirm(`Excluir "${f.name}"? Respostas e agendamentos serão apagados.`)) return;
    try {
      const res = await fetch(`/api/lead-forms/${f.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setForms((prev) => prev.filter((x) => x.id !== f.id));
      toast.success("Formulário excluído");
    } catch {
      toast.error("Falha ao excluir");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6 p-6" aria-busy="true" aria-label="Carregando formulários">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-2">
            <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
            <div className="h-4 w-96 max-w-full animate-pulse rounded-md bg-muted" />
          </div>
          <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const visible = q
    ? forms.filter((f) => `${f.name} ${f.slug}`.toLowerCase().includes(q))
    : forms;

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Formulários</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Formulários conversacionais estilo Typebot: personalize, qualifique, agende e otimize o Meta Ads.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar formulário…"
              className="w-52 pl-9"
              aria-label="Buscar formulário"
            />
          </div>
          <Button variant="outline" onClick={() => router.push("/lead-forms/agenda")}>
            <CalendarDays className="h-4 w-4" /> Agenda
          </Button>
          <GatedButton canAct={canCreate} gateReason="criar formulários" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> Novo formulário
          </GatedButton>
        </div>
      </header>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-16 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
            {forms.length === 0 ? (
              <ClipboardList className="h-6 w-6 text-muted-foreground" />
            ) : (
              <Search className="h-6 w-6 text-muted-foreground" />
            )}
          </div>
          <h2 className="mt-4 text-base font-medium text-foreground">
            {forms.length === 0 ? "Nenhum formulário ainda" : "Nenhum resultado"}
          </h2>
          <p className="mt-1 max-w-md text-sm text-muted-foreground">
            {forms.length === 0
              ? "Crie um formulário de qualificação com perguntas, score, agendamento e pixel da Meta."
              : `Nada encontrado para "${query}". Ajuste a busca.`}
          </p>
          {forms.length === 0 && (
            <GatedButton canAct={canCreate} gateReason="criar formulários" onClick={() => setOpen(true)} className="mt-5">
              <Plus className="h-4 w-4" /> Criar primeiro formulário
            </GatedButton>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((f) => (
            <div key={f.id} className="flex flex-col rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">{f.name}</h3>
                <Badge variant="outline" className={cn("shrink-0 text-[10px]", f.status === "published" ? "border-emerald-600/40 bg-emerald-500/10 text-emerald-300" : "border-border bg-muted text-muted-foreground")}>
                  {f.status === "published" ? "Publicado" : f.status === "archived" ? "Arquivado" : "Rascunho"}
                </Badge>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">/{f.slug}</p>
              <div className="mt-3 flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1"><BarChart3 className="h-3 w-3" />{f.view_count} views</span>
                <span>{f.response_count} respostas</span>
                <span>{f.qualified_count} qualificados</span>
                <span>{f.booked_count} agendados</span>
              </div>
              <div className="mt-4 flex items-center justify-end gap-2 border-t border-border pt-3">
                {f.status === "published" && (
                  <Button variant="ghost" size="sm" onClick={() => window.open(`/f/${f.slug}`, "_blank")}>
                    <ExternalLink className="h-3.5 w-3.5" /> Ver
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => router.push(`/lead-forms/${f.id}`)}>
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </Button>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(f)} className="text-red-400 hover:bg-red-500/10 hover:text-red-300">
                  <Trash2 className="h-3.5 w-3.5" /> Excluir
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Novo formulário</DialogTitle>
          </DialogHeader>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Qualificação — Tráfego pago" onKeyDown={(e) => e.key === "Enter" && handleCreate()} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={handleCreate} disabled={!name.trim() || creating}>
              {creating && <Loader2 className="h-4 w-4 animate-spin" />} Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
