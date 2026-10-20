"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, GripVertical, Save, ExternalLink, RefreshCw, Calculator, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import type {
  LeadForm, LeadFormBlock, LeadFormBlockType,
} from "@/lib/lead-forms/types";
import { BLOCK_TYPE_LABELS } from "@/lib/lead-forms/types";
import { LeadFormMetaTab } from "./lead-form-meta-tab";
import { LeadFormShareTab } from "./lead-form-share-tab";
import { LeadFormResponsesTab } from "./lead-form-responses-tab";
import { ScheduleEditor } from "./lead-form-schedule-editor";

interface Props {
  formId: string;
}

const BLOCK_TYPES = Object.keys(BLOCK_TYPE_LABELS) as LeadFormBlockType[];

/** Snapshot só dos campos editáveis (contadores de views/respostas não sujam o dirty). */
function editableSnapshot(form: LeadForm, blocks: LeadFormBlock[]): string {
  return JSON.stringify({
    name: form.name,
    description: form.description,
    status: form.status,
    slug: form.slug,
    theme_config: form.theme_config,
    settings: form.settings,
    qualification_config: form.qualification_config,
    scheduling_config: form.scheduling_config,
    meta_config: form.meta_config,
    blocks,
  });
}

export function LeadFormEditor({ formId }: Props) {
  const [form, setForm] = useState<LeadForm | null>(null);
  const [blocks, setBlocks] = useState<LeadFormBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [responses, setResponses] = useState<Array<Record<string, unknown>>>([]);
  const [bookings, setBookings] = useState<Array<Record<string, unknown>>>([]);
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const snapshotRef = useRef<string>("");
  const saveRef = useRef<() => void>(() => undefined);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`/api/lead-forms/${formId}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const json = await res.json() as { form: LeadForm; blocks: Array<{ block_key: string; block_type: LeadFormBlockType; config: LeadFormBlock["config"]; position: number; is_qualifier: boolean; score_weight: number }> };
      setForm(json.form);
      const mapped = json.blocks.map((b) => ({ block_key: b.block_key, block_type: b.block_type, config: b.config, position: b.position, is_qualifier: b.is_qualifier, score_weight: b.score_weight }));
      setBlocks(mapped);
      snapshotRef.current = editableSnapshot(json.form, mapped);
      setDirty(false);
      const r2 = await fetch(`/api/lead-forms/${formId}/responses`, { cache: "no-store" });
      if (r2.ok) {
        const j2 = await r2.json() as { responses: Array<Record<string, unknown>>; bookings: Array<Record<string, unknown>> };
        setResponses(j2.responses ?? []);
        setBookings(j2.bookings ?? []);
      }
    } catch {
      toast.error("Falha ao carregar formulário");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formId]);

  // Dirty tracking: compara editáveis atuais com o último snapshot salvo.
  useEffect(() => {
    if (!form) return;
    setDirty(editableSnapshot(form, blocks) !== snapshotRef.current);
  }, [form, blocks]);

  // Ctrl/Cmd+S salva de qualquer aba.
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function handleRecount() {
    setSaving(true);
    try {
      const res = await fetch(`/api/lead-forms/${formId}/recount`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { error?: string; form?: LeadForm; counts?: Record<string, number> };
      if (!res.ok) throw new Error(j.error ?? "recount failed");
      if (j.form) setForm(j.form);
      else await load(true);
      toast.success(`Resumo recalculado: ${j.counts?.response_count ?? "?"} respostas`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao recalcular");
    } finally {
      setSaving(false);
    }
  }

  async function save(patch: Partial<LeadForm> & { blocks?: LeadFormBlock[] } = {}) {
    setSaving(true);
    try {
      const payload = {
        name: patch.name ?? form?.name,
        description: patch.description ?? form?.description,
        status: patch.status ?? form?.status,
        slug: patch.slug ?? form?.slug,
        theme_config: patch.theme_config ?? form?.theme_config,
        settings: patch.settings ?? form?.settings,
        qualification_config: patch.qualification_config ?? form?.qualification_config,
        scheduling_config: patch.scheduling_config ?? form?.scheduling_config,
        meta_config: patch.meta_config ?? form?.meta_config,
        blocks: (patch.blocks ?? blocks).map((b, i) => ({
          block_key: b.block_key, block_type: b.block_type, config: b.config,
          position: i, is_qualifier: b.is_qualifier, score_weight: b.score_weight,
        })),
      };
      const res = await fetch(`/api/lead-forms/${formId}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as { error?: string }).error ?? "save failed");
      }
      const json = await res.json() as { form: LeadForm };
      setForm(json.form);
      const nextBlocks = patch.blocks ?? blocks;
      if (patch.blocks) setBlocks(patch.blocks);
      snapshotRef.current = editableSnapshot(json.form, nextBlocks);
      setDirty(false);
      setLastSaved(new Date());
      toast.success("Salvo");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  function updateForm<K extends keyof LeadForm>(key: K, value: LeadForm[K]) {
    if (form) setForm({ ...form, [key]: value });
  }

  if (loading || !form) {
    return (
      <div className="space-y-4 p-6" aria-busy="true" aria-label="Carregando formulário">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="h-9 w-72 animate-pulse rounded-md bg-muted" />
          <div className="h-9 w-40 animate-pulse rounded-md bg-muted" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
        <div className="h-64 animate-pulse rounded-lg bg-muted" />
      </div>
    );
  }

  const publicUrl = typeof window !== "undefined" ? `${window.location.origin}/f/${form.slug}` : `/f/${form.slug}`;
  const convRate = form.view_count > 0 ? Math.round((form.response_count / form.view_count) * 100) : 0;

  return (
    <div className="space-y-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Input value={form.name} onChange={(e) => updateForm("name", e.target.value)} className="w-72 text-lg font-semibold" />
          <Badge variant="outline">{form.status === "published" ? "Publicado" : form.status === "archived" ? "Arquivado" : "Rascunho"}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <Select value={form.status} onValueChange={(v) => updateForm("status", v as LeadForm["status"])}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Rascunho</SelectItem>
              <SelectItem value="published">Publicado</SelectItem>
              <SelectItem value="archived">Arquivado</SelectItem>
            </SelectContent>
          </Select>
          {form.status === "published" && (
            <Button variant="outline" size="sm" onClick={() => window.open(publicUrl, "_blank")}>
              <ExternalLink className="h-3.5 w-3.5" /> Abrir
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading} title="Recarregar métricas e respostas">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
          <span
            className={`hidden items-center gap-1.5 text-xs sm:inline-flex ${dirty ? "text-amber-400" : "text-muted-foreground"}`}
            role="status"
            title={dirty ? "Há alterações ainda não salvas" : lastSaved ? `Salvo às ${lastSaved.toLocaleTimeString("pt-BR")}` : "Nenhuma alteração pendente"}
          >
            {dirty ? (
              <><span className="h-1.5 w-1.5 rounded-full bg-amber-400" /> Não salvo</>
            ) : (
              <><Check className="h-3.5 w-3.5 text-emerald-400" /> Salvo</>
            )}
          </span>
          <Button onClick={() => save()} disabled={saving} title="Salvar (Ctrl+S)">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}<Save className="h-4 w-4" /> Salvar
          </Button>
        </div>
      </header>

      <div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {[
            ["Views", form.view_count],
            ["Respostas", form.response_count],
            ["Conversão", `${convRate}%`],
            ["Qualificados", form.qualified_count],
            ["Agendados", form.booked_count],
          ].map(([label, v]) => (
            <Card key={label}><CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-foreground">{v}</p>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
            </CardContent></Card>
          ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[11px] text-muted-foreground">Resumo zerado mas há respostas na aba abaixo?</span>
          <Button variant="ghost" size="sm" onClick={handleRecount} disabled={saving} title="Recalcula os cards a partir das respostas reais">
            <Calculator className="h-3.5 w-3.5" /> Recalcular resumo
          </Button>
        </div>
      </div>

      <Tabs defaultValue="build">
        <TabsList className="flex flex-wrap">
          <TabsTrigger value="build">Perguntas</TabsTrigger>
          <TabsTrigger value="design">Personalização</TabsTrigger>
          <TabsTrigger value="qualify">Qualificação</TabsTrigger>
          <TabsTrigger value="schedule">Agenda</TabsTrigger>
          <TabsTrigger value="meta">Meta Ads</TabsTrigger>
          <TabsTrigger value="share">Compartilhar</TabsTrigger>
          <TabsTrigger value="responses">Respostas ({responses.length})</TabsTrigger>
        </TabsList>

        {/* ---------- BUILD ---------- */}
        <TabsContent value="build" className="space-y-3">
          {blocks.map((b, i) => (
            <Card key={`${b.block_key}-${i}`}>
              <CardContent className="flex gap-3 p-4">
                <GripVertical className="mt-2 h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input value={b.config.label} onChange={(e) => {
                      const nb = [...blocks]; nb[i] = { ...b, config: { ...b.config, label: e.target.value } }; setBlocks(nb);
                    }} placeholder="Pergunta" className="min-w-52 flex-1" />
                    <Select value={b.block_type} onValueChange={(v) => {
                      const nb = [...blocks]; nb[i] = { ...b, block_type: v as LeadFormBlockType }; setBlocks(nb);
                    }}>
                      <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {BLOCK_TYPES.map((t) => <SelectItem key={t} value={t}>{BLOCK_TYPE_LABELS[t]}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="sm" aria-label="Excluir pergunta" onClick={() => {
                      const nb = [...blocks]; const [removed] = nb.splice(i, 1);
                      const idx = i;
                      setBlocks(nb.map((x, j) => ({ ...x, position: j })));
                      toast("Pergunta excluída", {
                        action: {
                          label: "Desfazer",
                          onClick: () => setBlocks((prev) => {
                            const cp = [...prev];
                            cp.splice(Math.min(idx, cp.length), 0, removed);
                            return cp.map((x, j) => ({ ...x, position: j }));
                          }),
                        },
                      });
                    }} className="text-red-400"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                    <Input value={b.block_key} onChange={(e) => {
                      const nb = [...blocks]; nb[i] = { ...b, block_key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }; setBlocks(nb);
                    }} placeholder="chave (ex: faturamento)" />
                    <Input value={b.config.placeholder ?? ""} onChange={(e) => {
                      const nb = [...blocks]; nb[i] = { ...b, config: { ...b.config, placeholder: e.target.value } }; setBlocks(nb);
                    }} placeholder="Texto de exemplo" />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={!!b.config.required} onCheckedChange={(v) => {
                        const nb = [...blocks]; nb[i] = { ...b, config: { ...b.config, required: v } }; setBlocks(nb);
                      }} /> Obrigatório
                    </label>
                  </div>
                  {(b.block_type === "choice_single" || b.block_type === "choice_multi") && (
                    <OptionsEditor block={b} onChange={(cfg) => {
                      const nb = [...blocks]; nb[i] = { ...b, config: cfg }; setBlocks(nb);
                    }} />
                  )}
                  <div className="flex flex-wrap items-center gap-3 border-t border-border pt-2">
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={b.is_qualifier} onCheckedChange={(v) => {
                        const nb = [...blocks]; nb[i] = { ...b, is_qualifier: v }; setBlocks(nb);
                      }} /> Pergunta qualificadora
                    </label>
                    {b.is_qualifier && (
                      <Input type="number" value={b.score_weight} onChange={(e) => {
                        const nb = [...blocks]; nb[i] = { ...b, score_weight: Number(e.target.value) }; setBlocks(nb);
                      }} className="w-28" placeholder="Peso" />
                    )}
                    {(b.block_type === "choice_single" || b.block_type === "choice_multi") && b.is_qualifier && (
                      <span className="text-[11px] text-muted-foreground">Marque abaixo quais opções qualificam (pontuação somada).</span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setBlocks([...blocks, {
              block_key: `pergunta_${blocks.length + 1}`, block_type: "short_text",
              config: { label: "Nova pergunta", required: true }, position: blocks.length,
              is_qualifier: false, score_weight: 0,
            }])}>
              <Plus className="h-4 w-4" /> Adicionar pergunta
            </Button>
            <Button variant="outline" onClick={() => setBlocks([...blocks, {
              block_key: "agendar", block_type: "meeting",
              config: { label: "Agende sua reunião" }, position: blocks.length,
              is_qualifier: false, score_weight: 0,
            }])}>
              <Plus className="h-4 w-4" /> Bloco de agendamento
            </Button>
          </div>
          <Button onClick={() => save({ blocks })} disabled={saving}>Salvar perguntas</Button>
        </TabsContent>

        {/* ---------- DESIGN ---------- */}
        <TabsContent value="design">
          <Card><CardHeader><CardTitle>Personalização</CardTitle>
            <CardDescription>Cores, avatar, logo e marca. Pré-visualize em /f/{form.slug}</CardDescription></CardHeader>
            <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2"><Label>Cor primária</Label>
                <div className="flex gap-2"><Input type="color" value={form.theme_config.primary_color} onChange={(e) => updateForm("theme_config", { ...form.theme_config, primary_color: e.target.value })} className="h-10 w-16" />
                  <Input value={form.theme_config.primary_color} onChange={(e) => updateForm("theme_config", { ...form.theme_config, primary_color: e.target.value })} /></div></div>
              <div className="space-y-2"><Label>Fundo</Label>
                <div className="flex gap-2"><Input type="color" value={form.theme_config.background} onChange={(e) => updateForm("theme_config", { ...form.theme_config, background: e.target.value })} className="h-10 w-16" />
                  <Input value={form.theme_config.background} onChange={(e) => updateForm("theme_config", { ...form.theme_config, background: e.target.value })} /></div></div>
              <div className="space-y-2"><Label>Avatar (URL)</Label><Input value={form.theme_config.avatar_url ?? ""} onChange={(e) => updateForm("theme_config", { ...form.theme_config, avatar_url: e.target.value || null })} placeholder="https://..." /></div>
              <div className="space-y-2"><Label>Logo (URL)</Label><Input value={form.theme_config.logo_url ?? ""} onChange={(e) => updateForm("theme_config", { ...form.theme_config, logo_url: e.target.value || null })} placeholder="https://..." /></div>
              <div className="space-y-2"><Label>Balão do visitante</Label><Input type="color" value={form.theme_config.bubble_user} onChange={(e) => updateForm("theme_config", { ...form.theme_config, bubble_user: e.target.value })} className="h-10 w-16" /></div>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.theme_config.show_branding} onCheckedChange={(v) => updateForm("theme_config", { ...form.theme_config, show_branding: v })} /> Mostrar marca ProCRM</label>
            </CardContent></Card>
          <Button className="mt-3" onClick={() => save()} disabled={saving}>Salvar design</Button>
        </TabsContent>

        {/* ---------- QUALIFY ---------- */}
        <TabsContent value="qualify">
          <Card><CardHeader><CardTitle>Qualificação</CardTitle>
            <CardDescription>Pontuação de 0 a 100. Leads com pontuação a partir do limiar veem o agendamento.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2"><Label>Modo</Label>
                  <Select value={form.qualification_config.mode} onValueChange={(v) => updateForm("qualification_config", { ...form.qualification_config, mode: v as "score" | "rules" | "all_required" })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="score">Por pontuação</SelectItem>
                      <SelectItem value="all_required">Todas qualificadoras obrigatórias</SelectItem>
                      <SelectItem value="rules">Pontuação + qualificadoras</SelectItem>
                    </SelectContent></Select></div>
                <div className="space-y-2"><Label>Limiar (0 a 100)</Label>
                  <Input type="number" min={0} max={100} value={form.qualification_config.threshold} onChange={(e) => updateForm("qualification_config", { ...form.qualification_config, threshold: Number(e.target.value) })} /></div>
              </div>
              <div className="space-y-2"><Label>Mensagem: lead qualificado</Label><Textarea value={form.qualification_config.qualified_message} onChange={(e) => updateForm("qualification_config", { ...form.qualification_config, qualified_message: e.target.value })} /></div>
              <div className="space-y-2"><Label>Mensagem: lead desqualificado</Label><Textarea value={form.qualification_config.disqualified_message} onChange={(e) => updateForm("qualification_config", { ...form.qualification_config, disqualified_message: e.target.value })} /></div>
            </CardContent></Card>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => save()} disabled={saving}>Salvar qualificação</Button>
          </div>
          <Card className="mt-3"><CardHeader><CardTitle>Criação automática</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.settings.create_contact} onCheckedChange={(v) => updateForm("settings", { ...form.settings, create_contact: v })} /> Criar contato</label>
              <label className="flex items-center gap-2 text-sm"><Switch checked={form.settings.create_deal} onCheckedChange={(v) => updateForm("settings", { ...form.settings, create_deal: v })} /> Criar negócio</label>
              {blocks.some((b) => b.block_type === "phone") && (
                <p className="w-full text-xs text-muted-foreground">
                  Com &quot;Criar contato&quot; ligado, o lead entra no CRM assim que a pergunta de WhatsApp é respondida — mesmo que a pessoa não conclua o formulário. As respostas finais atualizam o mesmo contato e negócio, sem duplicar.
                </p>
              )}
              <div className="w-full space-y-2"><Label>Webhook externo (POST JSON, opcional)</Label>
                <Input value={form.settings.webhook_url ?? ""} onChange={(e) => updateForm("settings", { ...form.settings, webhook_url: e.target.value || null })} placeholder="https://..." /></div>
              <div className="w-full space-y-2"><Label>Redirecionar após concluir (opcional)</Label>
                <Input value={form.settings.redirect_url ?? ""} onChange={(e) => updateForm("settings", { ...form.settings, redirect_url: e.target.value || null })} placeholder="https://obrigado..." /></div>
            </CardContent></Card>
        </TabsContent>

        {/* ---------- SCHEDULE ---------- */}
        <TabsContent value="schedule">
          <ScheduleEditor
            value={form.scheduling_config}
            onChange={(v) => updateForm("scheduling_config", v)}
          />
          <Button className="mt-3" onClick={() => save()} disabled={saving}>Salvar agenda</Button>
        </TabsContent>

        {/* ---------- META ---------- */}
        <TabsContent value="meta" className="space-y-3">
          <LeadFormMetaTab
            formId={formId}
            meta={form.meta_config}
            onChange={(meta_config) => updateForm("meta_config", meta_config)}
            onSaveForm={() => save()}
            savingForm={saving}
          />
        </TabsContent>

        {/* ---------- SHARE ---------- */}
        <TabsContent value="share" className="space-y-3">
          <LeadFormShareTab
            slug={form.slug}
            onSlugChange={(slug) => updateForm("slug", slug)}
            publicUrl={publicUrl}
          />
          <Button onClick={() => save()} disabled={saving}>Salvar slug</Button>
        </TabsContent>

        {/* ---------- RESPONSES ---------- */}
        <TabsContent value="responses" className="space-y-3">
          <LeadFormResponsesTab responses={responses} bookings={bookings} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function OptionsEditor({ block, onChange }: { block: LeadFormBlock; onChange: (cfg: LeadFormBlock["config"]) => void }) {
  const opts = block.config.options ?? [];
  return (
    <div className="space-y-1">
      {opts.map((o, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input value={o.label} placeholder="Rótulo" onChange={(e) => {
            const no = [...opts]; no[i] = { ...o, label: e.target.value }; onChange({ ...block.config, options: no });
          }} />
          <Input value={o.value} placeholder="valor" className="w-32" onChange={(e) => {
            const no = [...opts]; no[i] = { ...o, value: e.target.value }; onChange({ ...block.config, options: no });
          }} />
          <Input type="number" value={o.score ?? 0} className="w-20" placeholder="pontos" onChange={(e) => {
            const no = [...opts]; no[i] = { ...o, score: Number(e.target.value) }; onChange({ ...block.config, options: no });
          }} />
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Esta opção qualifica?">
            <input type="checkbox" checked={(block.config.qualifying_values ?? []).includes(o.value)} onChange={(e) => {
              const cur = new Set(block.config.qualifying_values ?? []);
              if (e.target.checked) cur.add(o.value); else cur.delete(o.value);
              onChange({ ...block.config, qualifying_values: [...cur] });
            }} /> Q
          </label>
          <Button variant="ghost" size="sm" onClick={() => onChange({ ...block.config, options: opts.filter((_, j) => j !== i) })}><Trash2 className="h-3.5 w-3.5" /></Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange({ ...block.config, options: [...opts, { value: `opcao_${opts.length + 1}`, label: "Nova opção", score: 0 }] })}>
        <Plus className="h-3.5 w-3.5" /> Opção
      </Button>
    </div>
  );
}
