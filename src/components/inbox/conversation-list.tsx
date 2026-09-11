"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import { Search, ChevronDown, X, Plus, MessageSquare, Smartphone } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { NewConversationDialog } from "@/components/inbox/new-conversation-dialog";

/** Minimum search length before we query the messages table. */
const MIN_SEARCH_LENGTH = 2;
/** Debounce delay (ms) before firing the message search query. */
const SEARCH_DEBOUNCE_MS = 350;

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  onConversationCreated?: (conversationId: string) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};



type InboxFilter = ConversationStatus | "all" | "unread" | "awaitingReply";
type SourceFilter = "all" | "whatsapp" | "uazapi";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onConversationCreated,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(() => [
    { label: t("filterAll"), value: "all" },
    { label: t("filterUnread"), value: "unread" },
    { label: t("filterAwaitingReply"), value: "awaitingReply" },
    { label: t("filterOpen"), value: "open" },
    { label: t("filterPending"), value: "pending" },
    { label: t("filterClosed"), value: "closed" },
  ], [t]);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  // All companies for the current account (for the company filter dropdown).
  const [companies, setCompanies] = useState<string[]>([]);
  // Conversation IDs whose messages contain the search term (server-side
  // full-text search across the messages table, not just last_message_text).
  const [messageMatchIds, setMessageMatchIds] = useState<Set<string>>(
    () => new Set(),
  );
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // Maximum conversations to fetch per request. Supabase defaults to 1000,
    // so we explicitly request more to handle accounts with 3000+ conversations.
    const FETCH_LIMIT = 5000;

    (async () => {
      let data: Conversation[] = [];
      console.log("[Inbox] Fetching conversations with sourceFilter:", sourceFilter, "FETCH_LIMIT:", FETCH_LIMIT);

      if (sourceFilter === "all") {
        // Prefer the inbox_conversations view (adds last_message_sender_type,
        // migration 048). If it's not deployed yet, fall back to the base
        // table so a missing migration never blanks the whole inbox.
        let res = await supabase
          .from("inbox_conversations")
          .select(CONVERSATION_SELECT)
          .order("last_message_at", { ascending: false })
          .limit(FETCH_LIMIT);
        if (res.error) {
          res = await supabase
            .from("conversations")
            .select(CONVERSATION_SELECT)
            .order("last_message_at", { ascending: false })
            .limit(FETCH_LIMIT);
        }
        const { data: all, error } = res;

        if (cancelled) return;

        if (error) {
          // Supabase errors have non-enumerable properties — log fields explicitly
          console.error("Failed to fetch conversations:", {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          });
          setLoading(false);
          return;
        }
        data = all ?? [];
        console.log("[Inbox] Fetched conversations count (all):", data.length);
      } else {
        // Two lookups merged into one list:
        // 1) conversations whose own `source` column matches — covers
        //    rows created by the Uazapi sync route, which can exist
        //    without message rows yet;
        // 2) conversations that contain at least one message from the
        //    channel. Mixed conversations (Meta + Uazapi) get
        //    `source = null` (see the Uazapi webhook), so a column
        //    match alone would miss them.
        let [bySource, byMessage] = await Promise.all([
          supabase
            .from("inbox_conversations")
            .select(CONVERSATION_SELECT)
            .eq("source", sourceFilter)
            .limit(FETCH_LIMIT),
          supabase
            .from("inbox_conversations")
            .select(`${CONVERSATION_SELECT}, messages!inner(source)`)
            .eq("messages.source", sourceFilter)
            .limit(FETCH_LIMIT),
        ]);

        // Fall back to the base table if the view (migration 048) isn't
        // deployed yet — same reason as the "all" branch above.
        if (bySource.error || byMessage.error) {
          [bySource, byMessage] = await Promise.all([
            supabase
              .from("conversations")
              .select(CONVERSATION_SELECT)
              .eq("source", sourceFilter)
              .limit(FETCH_LIMIT),
            supabase
              .from("conversations")
              .select(`${CONVERSATION_SELECT}, messages!inner(source)`)
              .eq("messages.source", sourceFilter)
              .limit(FETCH_LIMIT),
          ]);
        }

        if (cancelled) return;

        if (bySource.error || byMessage.error) {
          const error = bySource.error ?? byMessage.error;
          console.error("Failed to fetch conversations:", {
            message: error!.message,
            details: error!.details,
            hint: error!.hint,
            code: error!.code,
          });
          setLoading(false);
          return;
        }

        const seen = new Map<string, Conversation>();
        for (const row of [
          ...(bySource.data ?? []),
          ...(byMessage.data ?? []),
        ]) {
          if (!seen.has(row.id)) seen.set(row.id, row);
        }
        data = Array.from(seen.values()).sort(
          (a, b) =>
            new Date(b.last_message_at ?? 0).getTime() -
            new Date(a.last_message_at ?? 0).getTime()
        );
        console.log("[Inbox] Fetched conversations count (filtered):", data.length);
      }

      onConversationsLoadedRef.current(normalizeConversations(data));
      console.log("[Inbox] Normalized conversations count:", normalizeConversations(data).length);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [resyncToken, sourceFilter]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      // Get the current user's account_id to filter tags
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      const { data } = await supabase
        .from("tags")
        .select("*")
        .eq("account_id", accountId)
        .order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch all unique companies for the current account (for the company filter dropdown).
  // This runs once on mount and is independent of the source filter so users can
  // filter by company across all conversation sources.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      // Get the current user's account_id from their profile
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      // Fetch distinct companies from contacts for this account
      const { data: contactsData } = await supabase
        .from("contacts")
        .select("company")
        .eq("account_id", accountId)
        .not("company", "is", null);

      if (cancelled) return;

      const companySet = new Set<string>();
      for (const c of contactsData ?? []) {
        const co = c.company?.trim();
        if (co) companySet.add(co);
      }
      setCompanies(Array.from(companySet).sort((a, b) => a.localeCompare(b)));
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Server-side search across the messages table AND contacts table.
  // When the user types a search term (≥ MIN_SEARCH_LENGTH chars), we query for
  // conversation IDs whose messages contain the term (case-insensitive) OR whose
  // contact's phone/name matches. Results are debounced to avoid hammering the DB.
  useEffect(() => {
    // Clear any pending debounce timer.
    if (searchTimerRef.current !== null) {
      clearTimeout(searchTimerRef.current);
      searchTimerRef.current = null;
    }

    const q = search.trim();
    if (q.length < MIN_SEARCH_LENGTH) {
      // Defer the setState to avoid cascading renders when the effect
      // fires synchronously during render.
      const timer = setTimeout(() => setMessageMatchIds(new Set()), 0);
      return () => clearTimeout(timer);
    }

    let cancelled = false;

    searchTimerRef.current = setTimeout(async () => {
      const supabase = createClient();
      const searchTerm = `%${q}%`;

      // Get the current user's account_id for scoping searches
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;

      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      // Search 1: messages table (content_text, template_name) via conversations in this account
      const { data: messageData, error: messageError } = await supabase
        .from("messages")
        .select("conversation_id, conversations!inner(account_id)")
        .eq("conversations.account_id", accountId)
        .or(`content_text.ilike.${searchTerm},template_name.ilike.${searchTerm}`)
        .limit(2000);

      // Search 2: contacts table (phone, phone_normalized, name) -> conversations in this account
      const { data: contactData, error: contactError } = await supabase
        .from("contacts")
        .select("id")
        .eq("account_id", accountId)
        .or(`phone.ilike.${searchTerm},phone_normalized.ilike.${searchTerm},name.ilike.${searchTerm}`)
        .limit(2000);

      const contactConversationIds = new Set<string>();
      if (!contactError && contactData) {
        const contactIds = contactData.map((c) => c.id);
        if (contactIds.length > 0) {
          const { data: convData } = await supabase
            .from("conversations")
            .select("id")
            .eq("account_id", accountId)
            .in("contact_id", contactIds)
            .limit(2000);
          for (const row of convData ?? []) {
            contactConversationIds.add(row.id);
          }
        }
      }

      if (cancelled) return;

      if (messageError || contactError) {
        console.error("Message search failed:", {
          messageError: messageError?.message,
          contactError: contactError?.message,
        });
        setMessageMatchIds(new Set());
      } else {
        const ids = new Set<string>();
        for (const row of messageData ?? []) {
          ids.add(row.conversation_id);
        }
        // Merge contact-based conversation IDs
        for (const id of contactConversationIds) {
          ids.add(id);
        }
        console.log("[Inbox] Search results - message matches:", messageData?.length ?? 0, "contact matches:", contactConversationIds.size, "total:", ids.size);
        setMessageMatchIds(ids);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      if (searchTimerRef.current !== null) {
        clearTimeout(searchTimerRef.current);
        searchTimerRef.current = null;
      }
    };
  }, [search]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === "awaitingReply") {
      // Filter for conversations where the last message was from the
      // customer. If last_message_sender_type is available (from the
      // inbox_conversations view), use it directly. Otherwise, fall back
      // to checking if the conversation has a last_message_at timestamp
      // and is not assigned to an agent (heuristic).
      result = result.filter((c) => {
        // Primary: use the view-provided field if available
        if (c.last_message_sender_type !== undefined) {
          return c.last_message_sender_type === "customer";
        }
        // Fallback: if the view doesn't exist, we can't determine this
        // reliably, so show all non-closed conversations as potentially
        // awaiting reply (the user will see the last message in the preview).
        return c.status !== "closed";
      });
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        // Match on contact name, phone, last message, OR any earlier
        // message in the conversation (server-side search via messageMatchIds).
        return (
          name.includes(q) ||
          phone.includes(q) ||
          lastMsg.includes(q) ||
          messageMatchIds.has(c.id)
        );
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany, messageMatchIds]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const [newConvOpen, setNewConvOpen] = useState(false);
  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* New Conversation Dialog */}
      <NewConversationDialog
        open={newConvOpen}
        onOpenChange={setNewConvOpen}
        onConversationCreated={(id) => onConversationCreated?.(id)}
      />

      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setNewConvOpen(true)}
            className="shrink-0 h-9 w-9 text-muted-foreground hover:text-foreground hover:bg-muted"
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? t("filterAll")}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Channel source filter — all / WhatsApp / Uazapi */}
          <div className="flex items-center gap-1" role="group" aria-label="Channel filter">
            {([
              { value: "all" as SourceFilter, label: t("channelAll"), icon: null },
              { value: "whatsapp" as SourceFilter, label: "WA", icon: MessageSquare },
              { value: "uazapi" as SourceFilter, label: "UZ", icon: Smartphone },
            ] as const).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setSourceFilter(value)}
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md transition-colors",
                  sourceFilter === value
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                )}
              >
                {Icon && <Icon className="h-3 w-3" />}
                {label}
              </button>
            ))}
          </div>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? t("company")}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? t("tags")}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t("noConversations")}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || t("noMessagesYet")}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
