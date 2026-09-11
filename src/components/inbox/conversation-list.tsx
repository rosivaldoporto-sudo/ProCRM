'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import { fetchAllInboxPages } from '@/lib/inbox/pagination';
import { cn } from '@/lib/utils';
import type { Conversation, ConversationStatus, Tag } from '@/types';
import {
  Search,
  ChevronDown,
  X,
  Plus,
  MessageSquare,
  Smartphone,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { NewConversationDialog } from '@/components/inbox/new-conversation-dialog';

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
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

type InboxFilter = ConversationStatus | 'all' | 'unread' | 'awaitingReply';
type SourceFilter = 'all' | 'whatsapp' | 'uazapi';

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onConversationCreated,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      { label: t('filterAwaitingReply'), value: 'awaitingReply' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t]
  );

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
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
    () => new Set()
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

    (async () => {
      let data: Conversation[] = [];

      if (sourceFilter === 'all') {
        // Prefer the inbox_conversations view (adds last_message_sender_type,
        // migration 048). If it's not deployed yet, fall back to the base
        // table so a missing migration never blanks the whole inbox.
        let res = await fetchAllInboxPages(
          (from, to) =>
            supabase
              .from('inbox_conversations')
              .select(CONVERSATION_SELECT)
              .order('last_message_at', { ascending: false })
              .order('id')
              .range(from, to),
          () => cancelled
        );
        if (res.error) {
          res = await fetchAllInboxPages(
            (from, to) =>
              supabase
                .from('conversations')
                .select(CONVERSATION_SELECT)
                .order('last_message_at', { ascending: false })
                .order('id')
                .range(from, to),
            () => cancelled
          );
        }
        const { data: all, error } = res;

        if (cancelled) return;

        if (error) {
          // Supabase errors have non-enumerable properties — log fields explicitly
          console.error('Failed to fetch conversations:', {
            message: error.message,
            details: error.details,
            hint: error.hint,
            code: error.code,
          });
          setLoading(false);
          return;
        }
        data = all ?? [];
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
          fetchAllInboxPages(
            (from, to) =>
              supabase
                .from('inbox_conversations')
                .select(CONVERSATION_SELECT)
                .eq('source', sourceFilter)
                .order('id')
                .range(from, to),
            () => cancelled
          ),
          fetchAllInboxPages(
            (from, to) =>
              supabase
                .from('inbox_conversations')
                .select(`${CONVERSATION_SELECT}, messages!inner()`)
                .eq('messages.source', sourceFilter)
                .order('id')
                .range(from, to),
            () => cancelled
          ),
        ]);

        // Fall back to the base table if the view (migration 048) isn't
        // deployed yet — same reason as the "all" branch above.
        if (bySource.error || byMessage.error) {
          [bySource, byMessage] = await Promise.all([
            fetchAllInboxPages(
              (from, to) =>
                supabase
                  .from('conversations')
                  .select(CONVERSATION_SELECT)
                  .eq('source', sourceFilter)
                  .order('id')
                  .range(from, to),
              () => cancelled
            ),
            fetchAllInboxPages(
              (from, to) =>
                supabase
                  .from('conversations')
                  .select(`${CONVERSATION_SELECT}, messages!inner()`)
                  .eq('messages.source', sourceFilter)
                  .order('id')
                  .range(from, to),
              () => cancelled
            ),
          ]);
        }

        if (cancelled) return;

        if (bySource.error || byMessage.error) {
          const error = bySource.error ?? byMessage.error;
          console.error('Failed to fetch conversations:', {
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
      }

      onConversationsLoadedRef.current(normalizeConversations(data));
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
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      const { data } = await fetchAllInboxPages(
        (from, to) =>
          supabase
            .from('tags')
            .select('*')
            .eq('account_id', accountId)
            .order('name')
            .order('id')
            .range(from, to),
        () => cancelled
      );
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
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      // Fetch distinct companies from contacts for this account
      const { data: contactsData } = await fetchAllInboxPages(
        (from, to) =>
          supabase
            .from('contacts')
            .select('company')
            .eq('account_id', accountId)
            .not('company', 'is', null)
            .order('id')
            .range(from, to),
        () => cancelled
      );

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
        .from('profiles')
        .select('account_id')
        .eq('user_id', user.id)
        .maybeSingle();
      const accountId = profile?.account_id;
      if (!accountId) return;

      // Match conversations directly so repeated messages cannot consume a
      // row limit and hide other matching conversations.
      const [messageResult, contactResult] = await Promise.all([
        fetchAllInboxPages(
          (from, to) =>
            supabase
              .from('conversations')
              .select('id, messages!inner()')
              .eq('account_id', accountId)
              .or(
                `content_text.ilike.${searchTerm},template_name.ilike.${searchTerm}`,
                { referencedTable: 'messages' }
              )
              .order('id')
              .range(from, to),
          () => cancelled
        ),
        fetchAllInboxPages(
          (from, to) =>
            supabase
              .from('conversations')
              .select('id, contacts!inner()')
              .eq('account_id', accountId)
              .or(
                `phone.ilike.${searchTerm},phone_normalized.ilike.${searchTerm},name.ilike.${searchTerm}`,
                { referencedTable: 'contacts' }
              )
              .order('id')
              .range(from, to),
          () => cancelled
        ),
      ]);
      const { data: messageData, error: messageError } = messageResult;
      const { data: contactData, error: contactError } = contactResult;

      if (cancelled) return;

      if (messageError || contactError) {
        console.error('Message search failed:', {
          messageError: messageError?.message,
          contactError: contactError?.message,
        });
        setMessageMatchIds(new Set());
      } else {
        const ids = new Set<string>();
        for (const row of messageData ?? []) {
          ids.add(row.id);
        }
        // Merge contact-based conversation IDs
        for (const row of contactData ?? []) {
          ids.add(row.id);
        }
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

    if (filter === 'unread') {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === 'awaitingReply') {
      // Filter for conversations where the last message was from the
      // customer. If last_message_sender_type is available (from the
      // inbox_conversations view), use it directly. Otherwise, fall back
      // to checking if the conversation has a last_message_at timestamp
      // and is not assigned to an agent (heuristic).
      result = result.filter((c) => {
        // Primary: use the view-provided field if available
        if (c.last_message_sender_type !== undefined) {
          return c.last_message_sender_type === 'customer';
        }
        // Fallback: if the view doesn't exist, we can't determine this
        // reliably, so show all non-closed conversations as potentially
        // awaiting reply (the user will see the last message in the preview).
        return c.status !== 'closed';
      });
    } else if (filter !== 'all') {
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
      const q = search.trim().toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? '';
        const phone = c.contact?.phone?.toLowerCase() ?? '';
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
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
  }, [
    conversations,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    messageMatchIds,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

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
    <div className="border-border bg-card flex h-full w-full flex-col border-r lg:w-80">
      {/* New Conversation Dialog */}
      <NewConversationDialog
        open={newConvOpen}
        onOpenChange={setNewConvOpen}
        onConversationCreated={(id) => onConversationCreated?.(id)}
      />

      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder={t('searchPlaceholder')}
              className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setNewConvOpen(true)}
            className="text-muted-foreground hover:text-foreground hover:bg-muted h-9 w-9 shrink-0"
            title="New conversation"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? t('filterAll')}
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
                    'text-sm',
                    filter === opt.value
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Channel source filter — all / WhatsApp / Uazapi */}
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label="Channel filter"
          >
            {(
              [
                {
                  value: 'all' as SourceFilter,
                  label: t('channelAll'),
                  icon: null,
                },
                {
                  value: 'whatsapp' as SourceFilter,
                  label: 'WA',
                  icon: MessageSquare,
                },
                {
                  value: 'uazapi' as SourceFilter,
                  label: 'UZ',
                  icon: Smartphone,
                },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => setSourceFilter(value)}
                className={cn(
                  'inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs transition-colors',
                  sourceFilter === value
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
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
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
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
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
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
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
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
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
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
  const displayName = contact?.name || contact?.phone || t('unknown');
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
    <button
      onClick={handleClick}
      className={cn(
        'hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
        isActive && 'border-primary bg-muted/70 border-l-2'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
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
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                'h-2 w-2 rounded-full',
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
