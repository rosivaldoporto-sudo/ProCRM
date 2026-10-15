"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/currency";
import type { Contact, Deal, ContactNote, PipelineStage, Tag } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Megaphone,
  Plus,
  X,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { addContactTag, deleteContactTag } from "@/lib/contacts/tag-api";
import { format } from "date-fns";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

interface ContactSidebarProps {
  contact: Contact | null;
}

// Mirrors SPEC_DEFAULT_STAGES in the Pipelines page — used to seed a
// default pipeline when the account has none (sidebars can add leads
// before the user ever visits the Pipelines page).
const SIDEBAR_DEFAULT_STAGES = [
  { name: "New Lead", color: "#3b82f6", position: 0 },
  { name: "Qualified", color: "#eab308", position: 1 },
  { name: "Proposal Sent", color: "#f97316", position: 2 },
  { name: "Negotiation", color: "#8b5cf6", position: 3 },
  { name: "Won", color: "#22c55e", position: 4 },
];

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const tSidebar = useTranslations("Inbox.sidebar");
  const tThread = useTranslations("Inbox.messageThread");

  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [savingTagIds, setSavingTagIds] = useState<Set<string>>(new Set());
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [stagesByPipeline, setStagesByPipeline] = useState<
    Record<string, PipelineStage[]>
  >({});
  const [movingDealId, setMovingDealId] = useState<string | null>(null);
  const [addingDeal, setAddingDeal] = useState(false);

  // Contact id estável — usar o objeto `contact` inteiro como dep faria
  // refetch a cada render do pai; usar só o id evita isso e ainda
  // detecta troca de contato de forma confiável.
  const contactId = contact?.id ?? null;

  // Espelho síncrono do contato atual + contador de requisições.
  // Servem para descartar respostas atrasadas: se o usuário troca de
  // contato enquanto um fetch do contato anterior ainda está no ar,
  // a resposta antiga é ignorada em vez de sobrescrever as tags do
  // contato novo (bug da tag "vazando" entre contatos).
  const contactIdRef = useRef<string | null>(null);
  contactIdRef.current = contactId;
  const requestIdRef = useRef(0);

  const fetchContactData = useCallback(async () => {
    if (!contactId) return;
    const targetContactId = contactId;
    const requestId = ++requestIdRef.current;

    const supabase = createClient();

    // Fetch deals, notes, tags, pipelines and stages in parallel
    const [dealsRes, notesRes, tagsRes, allTagsRes, pipelinesRes, stagesRes] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", targetContactId)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", targetContactId)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", targetContactId),
        supabase.from("tags").select("*").order("name"),
        supabase
          .from("pipelines")
          .select("id, name")
          .eq("account_id", accountId)
          .order("created_at", { ascending: true }),
        supabase
          .from("pipeline_stages")
          .select("*")
          .order("position", { ascending: true }),
      ]);

    // Resposta de um contato que já não está mais selecionado, ou de
    // uma requisição superada por outra mais recente — descarta.
    if (
      contactIdRef.current !== targetContactId ||
      requestIdRef.current !== requestId
    ) {
      return;
    }

    if (dealsRes.data) setDeals(dealsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (allTagsRes.data) setAllTags(allTagsRes.data);
    if (pipelinesRes.data) setPipelines(pipelinesRes.data);
    if (stagesRes.data) {
      const byPipeline: Record<string, PipelineStage[]> = {};
      for (const s of stagesRes.data as PipelineStage[]) {
        (byPipeline[s.pipeline_id] ??= []).push(s);
      }
      setStagesByPipeline(byPipeline);
    }
  }, [contactId, accountId]);

  // Load on contact change. Limpa o estado do contato anterior de
  // imediato para nunca exibir tags/deals/notes de outro contato
  // enquanto o fetch do novo ainda está no ar.
  useEffect(() => {
    setTags([]);
    setDeals([]);
    setNotes([]);
    if (contactId) {
      fetchContactData();
    }
  }, [fetchContactData, contactId]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  // Add/remove a tag on the contact via the API route (same path the
  // Contacts detail view uses — also fires tag-triggered automations).
  // Atualização otimista: a tag aparece/some de imediato, sem esperar
  // o POST (que aguarda automações no servidor) nem o re-fetch.
  const handleToggleTag = useCallback(
    async (tagId: string) => {
      if (!contact || savingTagIds.has(tagId)) return;
      const targetContactId = contact.id;
      // Calculado de forma síncrona a partir do estado atual: updaters
      // do setState não executam na hora, então ler dentro do updater
      // chegaria tarde para decidir POST vs DELETE.
      const attached = tags.some((t) => t.id === tagId);
      if (attached) {
        setTags((prev) => prev.filter((t) => t.id !== tagId));
      } else {
        const tagInfo = allTags.find((t) => t.id === tagId);
        if (tagInfo) {
          setTags((prev) =>
            prev.some((t) => t.id === tagId)
              ? prev
              : [...prev, { ...tagInfo, contact_tag_id: `temp-${tagId}` }],
          );
        }
      }
      setSavingTagIds((prev) => new Set(prev).add(tagId));
      try {
        if (attached) {
          await deleteContactTag(targetContactId, tagId);
        } else {
          await addContactTag(targetContactId, tagId);
        }
        // Re-fetch the contact's tag rows so contact_tag_id stays accurate.
        // Ignora o resultado se o usuário já trocou de contato no meio
        // da requisição para não clobberar as tags do contato novo.
        const supabase = createClient();
        const { data } = await supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", targetContactId);
        if (contactIdRef.current !== targetContactId) return;
        if (data) {
          const mapped = data
            .filter((ct: Record<string, unknown>) => ct.tags)
            .map((ct: Record<string, unknown>) => ({
              ...(ct.tags as Tag),
              contact_tag_id: ct.id as string,
            }));
          setTags(mapped);
        }
      } catch (err) {
        // Reverte o otimista recarregando as tags reais do contato
        // (somente se ele ainda estiver selecionado).
        if (contactIdRef.current === targetContactId) {
          const supabase = createClient();
          const { data } = await supabase
            .from("contact_tags")
            .select("id, tag_id, tags(*)")
            .eq("contact_id", targetContactId);
          if (data) {
            const mapped = data
              .filter((ct: Record<string, unknown>) => ct.tags)
              .map((ct: Record<string, unknown>) => ({
                ...(ct.tags as Tag),
                contact_tag_id: ct.id as string,
              }));
            setTags(mapped);
          }
        }
        toast.error(
          err instanceof Error ? err.message : tSidebar("toastTagUpdateFailed"),
        );
      } finally {
        setSavingTagIds((prev) => {
          const next = new Set(prev);
          next.delete(tagId);
          return next;
        });
      }
    },
    [contact, tags, allTags, savingTagIds, tSidebar],
  );

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  // Move a deal to another pipeline stage straight from the inbox —
  // same persistence the Kanban drag does (plus the qualified-lead
  // CAPI ping for stage-triggered attribution).
  const handleMoveDeal = useCallback(
    async (deal: Deal, newStageId: string) => {
      if (deal.stage_id === newStageId) return;
      setMovingDealId(deal.id);
      const supabase = createClient();
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId, updated_at: new Date().toISOString() })
        .eq("id", deal.id);
      setMovingDealId(null);
      if (error) {
        toast.error(tSidebar("toastFailedMoveDeal"));
        return;
      }
      setDeals((prev) =>
        prev.map((d) => (d.id === deal.id ? { ...d, stage_id: newStageId } : d)),
      );
      const stageName = (stagesByPipeline[deal.pipeline_id] ?? []).find(
        (s) => s.id === newStageId,
      )?.name;
      fetch("/api/v1/capi/qualified-lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: deal.id, newStageId, stageName }),
      }).catch(() => {});
    },
    [stagesByPipeline, tSidebar],
  );

  // Add the lead to the account's default pipeline (first column)
  // right from the inbox. Seeds the standard pipeline when the
  // account has none, mirroring the Pipelines page.
  const handleAddDeal = useCallback(async () => {
    if (!contact || !accountId) return;
    setAddingDeal(true);
    const supabase = createClient();
    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        toast.error(tSidebar("toastFailedAddDeal"));
        return;
      }

      let pipelineId = pipelines[0]?.id ?? null;
      if (!pipelineId) {
        const { data: pipeline, error: pipelineErr } = await supabase
          .from("pipelines")
          .insert({
            user_id: user.id,
            account_id: accountId,
            name: "Sales Pipeline",
          })
          .select()
          .single();
        if (pipelineErr || !pipeline) {
          toast.error(tSidebar("toastFailedAddDeal"));
          return;
        }
        await supabase.from("pipeline_stages").insert(
          SIDEBAR_DEFAULT_STAGES.map((s) => ({ pipeline_id: pipeline.id, ...s })),
        );
        pipelineId = pipeline.id;
        await fetchContactData();
      }

      const stages = pipelineId ? stagesByPipeline[pipelineId] ?? [] : [];
      const firstStage = stages[0];
      if (!pipelineId || !firstStage) {
        toast.error(tSidebar("toastFailedAddDeal"));
        return;
      }

      const { error } = await supabase.from("deals").insert({
        user_id: user.id,
        account_id: accountId,
        pipeline_id: pipelineId,
        stage_id: firstStage.id,
        contact_id: contact.id,
        title: contact.name || contact.phone,
        value: 0,
        status: "open",
      });
      if (error) {
        toast.error(tSidebar("toastFailedAddDeal"));
        return;
      }
      toast.success(tSidebar("dealAdded"));
      await fetchContactData();
    } finally {
      setAddingDeal(false);
    }
  }, [contact, accountId, pipelines, stagesByPipeline, fetchContactData, tSidebar]);

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">{tThread("selectConversation")}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              {tSidebar("tags")}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {tags.map((tag) => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: `${tag.color}20`,
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => handleToggleTag(tag.id)}
                    disabled={savingTagIds.has(tag.id)}
                    aria-label={tSidebar("removeTag")}
                    title={tSidebar("removeTag")}
                    className="opacity-60 transition-opacity hover:opacity-100 disabled:opacity-40"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
              {tags.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">
                  {tSidebar("noTags")}
                </p>
              )}
              <Popover open={tagMenuOpen} onOpenChange={setTagMenuOpen}>
                <PopoverTrigger
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={tSidebar("addTag")}
                  title={tSidebar("addTag")}
                >
                  <Plus className="h-3 w-3" />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-1.5">
                  {allTags.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-muted-foreground">
                      {tSidebar("noTagsFound")}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {allTags
                        .filter((t) => !tags.some((ct) => ct.id === t.id))
                        .map((tag) => (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => {
                              setTagMenuOpen(false);
                              handleToggleTag(tag.id);
                            }}
                            disabled={savingTagIds.has(tag.id)}
                            className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                          >
                            <span
                              className="h-2 w-2 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                            />
                            {tag.name}
                          </button>
                        ))}
                      {allTags.every((t) => tags.some((ct) => ct.id === t.id)) && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">
                          {tSidebar("allTagsApplied")}
                        </p>
                      )}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Ad attribution (CTWA) */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <Megaphone className="h-3 w-3" />
              {tSidebar("adAttribution")}
            </div>
            <div className="mt-2">
              <div className="rounded-lg bg-muted px-3 py-2">
                <p className="text-sm font-medium text-foreground">
                  {contact.ad_name || tSidebar("noAdsAttribution")}
                </p>
                {contact.campaign_name && (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {contact.campaign_name}
                  </p>
                )}
                {(contact.ad_id || contact.campaign_id) && (
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/70">
                    {[
                      contact.ad_id && `${tSidebar("adId")} ${contact.ad_id}`,
                      contact.campaign_id &&
                        `${tSidebar("campaignId")} ${contact.campaign_id}`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {contact.ctwa_clid && (
                  <p
                    className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70"
                    title={contact.ctwa_clid}
                  >
                    {tSidebar("clickId")}: {contact.ctwa_clid}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <DollarSign className="h-3 w-3" />
                {tSidebar("deals")}
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAddDeal}
                disabled={addingDeal}
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                title={tSidebar("addToPipeline")}
              >
                {addingDeal ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Plus className="h-3 w-3" />
                )}
                {tSidebar("addToPipeline")}
              </Button>
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noDeals")}</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {formatCurrency(deal.value, deal.currency || "BRL")}
                      </span>
                      <select
                        value={deal.stage_id}
                        onChange={(e) => handleMoveDeal(deal, e.target.value)}
                        disabled={movingDealId === deal.id}
                        className="h-6 max-w-[130px] truncate rounded-full border-none bg-transparent px-1.5 text-[10px] font-medium text-muted-foreground outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                        style={{
                          color: (stagesByPipeline[deal.pipeline_id] ?? []).find(
                            (s) => s.id === deal.stage_id,
                          )?.color,
                        }}
                        title={tSidebar("changeStage")}
                      >
                        {(stagesByPipeline[deal.pipeline_id] ?? []).map((s) => (
                          <option key={s.id} value={s.id} className="text-foreground">
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {tSidebar("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={tSidebar("addNotePlaceholder")}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
