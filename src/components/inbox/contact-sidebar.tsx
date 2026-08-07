"use client";

import { useState, useEffect, useCallback } from "react";
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
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
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
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [stagesByPipeline, setStagesByPipeline] = useState<
    Record<string, PipelineStage[]>
  >({});
  const [movingDealId, setMovingDealId] = useState<string | null>(null);
  const [addingDeal, setAddingDeal] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, tags, pipelines and stages in parallel
    const [dealsRes, notesRes, tagsRes, pipelinesRes, stagesRes] =
      await Promise.all([
        supabase
          .from("deals")
          .select("*, stage:pipeline_stages(*)")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_notes")
          .select("*")
          .eq("contact_id", contact.id)
          .order("created_at", { ascending: false }),
        supabase
          .from("contact_tags")
          .select("id, tag_id, tags(*)")
          .eq("contact_id", contact.id),
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
    if (pipelinesRes.data) setPipelines(pipelinesRes.data);
    if (stagesRes.data) {
      const byPipeline: Record<string, PipelineStage[]> = {};
      for (const s of stagesRes.data as PipelineStage[]) {
        (byPipeline[s.pipeline_id] ??= []).push(s);
      }
      setStagesByPipeline(byPipeline);
    }
  }, [contact, accountId]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

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
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">{tSidebar("noTags")}</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
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
