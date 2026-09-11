'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { matchesContactFilters } from '@/lib/inbox/conversations';
import { fetchInboxPage, INBOX_PAGE_SIZE } from '@/lib/inbox/query';
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

/** Debounce delay (ms) before firing the message search query. */
const SEARCH_DEBOUNCE_MS = 350;

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (
    conversations: Conversation[],
    append?: boolean
  ) => void;
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
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [pageRequest, setPageRequest] = useState({ key: '', offset: 0 });
  const [loadedKey, setLoadedKey] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadError, setLoadError] = useState<number | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [resultIds, setResultIds] = useState<Set<string>>(new Set());
  const [loadCompanies, setLoadCompanies] = useState(false);
  const queryKey = JSON.stringify([
    debouncedSearch,
    filter,
    sourceFilter,
    selectedTagIds,
    selectedCompany,
  ]);
  const requestKey = queryKey + ':' + resyncToken;
  const offset = pageRequest.key === requestKey ? pageRequest.offset : 0;

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => clearTimeout(timer);
  }, [search]);

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
    const controller = new AbortController();
    const filters = JSON.parse(queryKey) as [
      string,
      InboxFilter,
      SourceFilter,
      string[],
      string | null,
    ];
    const reset = offset === 0;
    // Defer state changes while still starting only one bounded request.
    void (async () => {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      setLoadError(null);
      try {
        const rows = await fetchInboxPage(
          createClient(),
          {
            search: filters[0],
            status: filters[1],
            source: filters[2],
            tagIds: filters[3],
            company: filters[4],
          },
          offset,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setResultIds(
          (prev) =>
            new Set([...(reset ? [] : prev), ...rows.map((row) => row.id)])
        );
        onConversationsLoadedRef.current(rows, !reset);
        setHasMore(rows.length === INBOX_PAGE_SIZE);
        setLoadedKey(queryKey);
      } catch (error) {
        if (controller.signal.aborted) return;
        const failure = error as { status?: number; code?: string };
        console.error('Inbox load failed', {
          status: failure.status,
          code: failure.code,
        });
        setLoadError(failure.status || 0);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [queryKey, offset, retryToken, resyncToken]);

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
  // This runs when the picker is first opened and is independent of source so users can
  // filter by company across all conversation sources.
  useEffect(() => {
    if (!loadCompanies) return;
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
  }, [loadCompanies]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = loadedKey === queryKey ? conversations : [];

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

    // Server-side search and channel matching determine membership across
    // the whole account; do not re-filter message matches using local text.
    if (debouncedSearch || sourceFilter !== 'all') {
      result = result.filter((c) => resultIds.has(c.id));
    }

    return result;
  }, [
    conversations,
    loadedKey,
    queryKey,
    filter,
    debouncedSearch,
    sourceFilter,
    selectedTagIds,
    selectedCompany,
    resultIds,
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

          <DropdownMenu
            onOpenChange={(open) => {
              if (open) setLoadCompanies(true);
            }}
          >
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
              {loadCompanies && companies.length === 0 && (
                <DropdownMenuItem disabled>{t('noCompanies')}</DropdownMenuItem>
              )}
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
        {loading && offset === 0 ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 && loadError === null ? (
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
        {loadError !== null && (
          <div role="alert" className="text-destructive px-4 py-3 text-sm">
            <p>{loadError === 403 ? t('accessDenied') : t('loadFailed')}</p>
            <Button
              variant="outline"
              className="mt-2"
              disabled={loading}
              onClick={() => setRetryToken((value) => value + 1)}
            >
              {t('retry')}
            </Button>
          </div>
        )}
        {hasMore && loadError === null && (
          <Button
            variant="ghost"
            className="w-full"
            disabled={loading}
            onClick={() =>
              setPageRequest({
                key: requestKey,
                offset: offset + INBOX_PAGE_SIZE,
              })
            }
          >
            {loading ? t('loadingMore') : t('loadMore')}
          </Button>
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
            loading="lazy"
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
