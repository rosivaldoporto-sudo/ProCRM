'use client';

import {
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  THREAD_PAGE_SIZE,
  isOptimisticMessage,
  mergeLatestPage,
  prependOlderPage,
} from '@/lib/inbox/thread-messages';
import { useAuth } from '@/hooks/use-auth';
import { usePresence } from '@/hooks/use-presence';
import { PresenceDot } from '@/components/presence/presence-dot';
import { presenceLabel } from '@/lib/presence';
import { cn } from '@/lib/utils';
import type {
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
  InteractiveMessagePayload,
} from '@/types';
import {
  MessageSquare,
  ChevronDown,
  ArrowDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
} from 'lucide-react';
import { format, isToday, isYesterday, differenceInHours } from 'date-fns';
import { ptBR } from 'date-fns/locale/pt-BR';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ContactSidebar } from './contact-sidebar';
import { MessageBubble } from './message-bubble';
import { MessageActions } from './message-actions';
import { AdReferralCard } from './ad-referral-card';
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from './message-composer';
import { deleteAccountMedia } from '@/lib/storage/upload-media';
import { TemplatePicker } from './template-picker';
import { AiThreadBanner } from './ai-thread-banner';
import { buildReplyPreview } from './reply-quote';
import { toast } from 'sonner';

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_match: string, raw: string) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

function formatDateSeparator(
  dateStr: string,
  t: ReturnType<typeof useTranslations>
): string {
  const date = new Date(dateStr);
  if (isToday(date)) return t('today');
  if (isYesterday(date)) return t('yesterday');
  return format(date, "d 'de' MMMM 'de' yyyy", { locale: ptBR });
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = '';

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), 'yyyy-MM-dd');
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

// `labelKey` is the full key in Inbox.messageThread — never build it from
// a display word (the old `status${'Aberta'}` asked for keys that don't
// exist and logged MISSING_MESSAGE on every render).
const STATUS_OPTIONS: {
  labelKey: 'statusOpen' | 'statusPending' | 'statusClosed';
  value: ConversationStatus;
  color: string;
}[] = [
  { labelKey: 'statusOpen', value: 'open', color: 'text-primary' },
  { labelKey: 'statusPending', value: 'pending', color: 'text-amber-400' },
  { labelKey: 'statusClosed', value: 'closed', color: 'text-muted-foreground' },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

/** Placeholder das bolhas enquanto a primeira página da conversa carrega. */
const SKELETON_ROWS: { mine: boolean; width: string }[] = [
  { mine: false, width: 'w-40' },
  { mine: false, width: 'w-56' },
  { mine: true, width: 'w-48' },
  { mine: false, width: 'w-32' },
  { mine: true, width: 'w-64' },
  { mine: true, width: 'w-36' },
];

function ThreadSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 py-2">
      {SKELETON_ROWS.map((row, index) => (
        <div
          key={index}
          className={cn('flex', row.mine ? 'justify-end' : 'justify-start')}
        >
          <div
            className={cn(
              'bg-muted h-9 max-w-[75%] animate-pulse rounded-2xl',
              row.width,
              row.mine ? 'rounded-br-md' : 'rounded-bl-md'
            )}
          />
        </div>
      ))}
    </div>
  );
}

interface ThreadMessageRowProps {
  message: Message;
  /** Mensagem citada, quando esta é uma resposta. */
  parent: Message | null;
  contactLabel: string;
  reactions: MessageReaction[] | undefined;
  currentUserId: string | undefined;
  onReply: (message: Message) => void;
  /** `emoji === ''` remove a reação do agente. */
  onReact: (messageId: string, emoji: string) => void;
}

/**
 * Uma linha da conversa. Memoizada: uma mensagem nova, um tique de
 * status ou a presença da equipe não re-renderizam as outras bolhas
 * (antes a thread inteira era refeita a cada evento do realtime).
 */
const ThreadMessageRow = memo(function ThreadMessageRow({
  message,
  parent,
  contactLabel,
  reactions,
  currentUserId,
  onReply,
  onReact,
}: ThreadMessageRowProps) {
  const tQuote = useTranslations('Inbox.replyQuote');

  const reply = parent
    ? {
        authorLabel:
          parent.sender_type === 'agent' || parent.sender_type === 'bot'
            ? 'Você'
            : contactLabel,
        preview: buildReplyPreview(parent, tQuote),
      }
    : null;

  const handlePillToggle = (emoji: string) => {
    const own = reactions?.find(
      (r) => r.actor_type === 'agent' && r.actor_id === currentUserId
    );
    onReact(message.id, own?.emoji === emoji ? '' : emoji);
  };

  const bubble = (
    <MessageActions
      message={message}
      onReply={() => onReply(message)}
      onReact={(emoji) => {
        if (emoji) onReact(message.id, emoji);
      }}
    >
      <MessageBubble
        message={message}
        reply={reply}
        reactions={reactions}
        currentUserId={currentUserId}
        onToggleReaction={handlePillToggle}
      />
    </MessageActions>
  );

  // Mensagem que veio de um anúncio (Click-to-WhatsApp): o cartão do
  // anúncio aparece logo acima dela.
  const referral =
    message.sender_type === 'customer' &&
    message.referral &&
    typeof message.referral === 'object'
      ? message.referral
      : null;
  if (!referral) return bubble;
  return (
    <div className="space-y-1">
      <AdReferralCard referral={referral} />
      {bubble}
    </div>
  );
});

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
}: MessageThreadProps) {
  const t = useTranslations('Inbox.messageThread');
  const tTimer = useTranslations('Inbox.sessionTimer');
  const tQuote = useTranslations('Inbox.replyQuote');

  const { user } = useAuth();
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Omit<Profile, 'email'>[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);
  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  /** Manual override of the send channel. Null = use conversation.source. */
  const [channelOverride, setChannelOverride] = useState<
    'whatsapp' | 'uazapi' | null
  >(null);

  // Determine which API endpoint to use — manual override > conversation source > default (whatsapp)
  const effectiveChannel =
    channelOverride ?? conversation?.source ?? 'whatsapp';
  const sendEndpoint =
    effectiveChannel === 'uazapi' ? '/api/uazapi/send' : '/api/whatsapp/send';

  // Reset override when switching conversations
  useEffect(() => {
    setChannelOverride(null);
  }, [conversation?.id]);

  const toggleChannel = useCallback(() => {
    setChannelOverride((prev) => (prev === 'uazapi' ? 'whatsapp' : 'uazapi'));
  }, []);

  // Profiles are bounded by RLS to rows the current user is allowed to
  // see — today that's just the current user, but the dropdown keeps the
  // shape ready for shared-team workspaces without a refactor.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase
      .from('profiles')
      .select(
        'id, user_id, full_name, avatar_url, role, beta_features, account_id, account_role, created_at, updated_at'
      )
      .order('full_name')
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('Failed to fetch profiles:', error);
          return;
        }
        setProfiles((data as Omit<Profile, 'email'>[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A thread só guarda a página mais recente (+ as antigas que o agente
  // carregou). Quando as últimas mensagens são todas nossas, a última do
  // cliente pode estar fora da janela — `olderCustomerAt` guarda a data
  // dela, buscada à parte, para o cronômetro de 24h não dar "expirada"
  // por engano.
  const [olderCustomerAt, setOlderCustomerAt] = useState<{
    conversationId: string;
    at: string | null;
  } | null>(null);

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: '' };

    // Find last customer message
    let lastCustomerAt: string | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].sender_type === 'customer') {
        lastCustomerAt = messages[i].created_at;
        break;
      }
    }
    if (!lastCustomerAt && olderCustomerAt?.conversationId === conversation?.id) {
      lastCustomerAt = olderCustomerAt?.at ?? null;
    }

    if (!lastCustomerAt)
      return { expired: true, remaining: 'Sem mensagens do cliente' };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerAt));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: tTimer('expired') };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? tTimer('xhRemaining', { hours: Math.floor(hoursLeft) })
        : tTimer('xmRemaining', { minutes: Math.floor(hoursLeft * 60) });

    return { expired, remaining };
  }, [messages, tTimer, olderCustomerAt, conversation?.id]);

  // The 24h Meta window only applies to the official WhatsApp Cloud API.
  // UAZAPI sends through the user's own WhatsApp Web session, which has
  // no such restriction — so the composer must not be locked by the
  // session timer when the effective send channel is Uazapi.
  const sessionLocked =
    effectiveChannel === 'uazapi' ? false : sessionInfo.expired;

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  //
  // Só a página MAIS RECENTE é buscada (ordem decrescente + limite); as
  // anteriores vêm sob demanda em `loadOlder`. Ver thread-messages.ts.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  });
  const activeConversationIdRef = useRef(conversationId);
  useEffect(() => {
    activeConversationIdRef.current = conversationId;
  });
  /** Conversa cuja primeira página já chegou: distingue abrir de ressincronizar. */
  const loadedConversationRef = useRef<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const hasOlderRef = useRef(false);
  useEffect(() => {
    hasOlderRef.current = hasOlder;
  });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  /**
   * `true` enquanto a thread deve ficar colada na última mensagem: ao abrir
   * a conversa e sempre que o agente está no fim. Rolar para cima desliga.
   */
  const stickToBottomRef = useRef(true);
  /** Posição a restaurar depois de inserir mensagens antigas no topo. */
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);

  useEffect(() => {
    if (!conversationId) {
      loadedConversationRef.current = null;
      return;
    }

    const supabase = createClient();
    let cancelled = false;
    const isFirstLoad = loadedConversationRef.current !== conversationId;

    if (isFirstLoad) {
      // Abrir uma conversa sempre começa na última mensagem. Na
      // ressincronização (reconexão do realtime, aba voltando ao foco) a
      // lista continua na tela e a posição de leitura é preservada — o
      // spinner antigo desmontava a lista e jogava o agente para o topo.
      stickToBottomRef.current = true;
      prependAnchorRef.current = null;
      setLoading(true);
      setHasOlder(false);
    }

    (async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(THREAD_PAGE_SIZE);

      if (cancelled) return;

      if (error) {
        console.error('Failed to fetch messages:', error);
      } else {
        const page = ((data ?? []) as Message[]).slice().reverse();
        const merged = mergeLatestPage(
          isFirstLoad ? [] : messagesRef.current,
          page
        );
        if (merged.replaced) setHasOlder(page.length >= THREAD_PAGE_SIZE);
        loadedConversationRef.current = conversationId;
        onMessagesLoadedRef.current(merged.messages);
      }

      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus —
    // realtime is best-effort and any message events sent while the WS
    // was disconnected or throttled are otherwise lost.
  }, [conversationId, resyncToken]);

  const loadOlder = useCallback(async () => {
    const convId = activeConversationIdRef.current;
    if (!convId || loadingOlderRef.current) return;
    const oldest = messagesRef.current.find((m) => !isOptimisticMessage(m));
    if (!oldest) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      // `lte` + dedupe em vez de `lt`: mensagens importadas em lote podem
      // dividir o mesmo created_at, e um corte estrito pularia as que
      // caíram do outro lado da página.
      const { data, error } = await createClient()
        .from('messages')
        .select('*')
        .eq('conversation_id', convId)
        .lte('created_at', oldest.created_at)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(THREAD_PAGE_SIZE);

      if (activeConversationIdRef.current !== convId) return;
      if (error) {
        console.error('Failed to fetch older messages:', error);
        return;
      }

      const olderPage = ((data ?? []) as Message[]).slice().reverse();
      const next = prependOlderPage(messagesRef.current, olderPage);
      const added = next.length - messagesRef.current.length;
      // Página cheia mas sem nada novo só acontece com dezenas de
      // mensagens no mesmo instante; encerra em vez de buscar para sempre.
      setHasOlder(olderPage.length >= THREAD_PAGE_SIZE && added > 0);
      if (added > 0) {
        const el = scrollRef.current;
        prependAnchorRef.current = el
          ? { height: el.scrollHeight, top: el.scrollTop }
          : null;
        onMessagesLoadedRef.current(next);
      }
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, []);

  // Última mensagem do cliente fora da janela carregada (ver
  // `olderCustomerAt`). Só consulta quando realmente falta essa informação.
  const hasCustomerMessageLoaded = useMemo(
    () => messages.some((m) => m.sender_type === 'customer'),
    [messages]
  );
  useEffect(() => {
    if (!conversationId || loading || !hasOlder || hasCustomerMessageLoaded) {
      return;
    }
    // No render da troca de conversa, `hasOlder` e `loading` ainda são os
    // da conversa anterior; sem esta checagem saía uma consulta à toa a
    // cada troca.
    if (loadedConversationRef.current !== conversationId) return;
    let cancelled = false;
    createClient()
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setOlderCustomerAt({
          conversationId,
          at: (data?.created_at as string | undefined) ?? null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, loading, hasOlder, hasCustomerMessageLoaded]);

  // Mensagens citadas (respostas) que ficaram fora da janela carregada:
  // busca só as que faltam, para a citação continuar aparecendo.
  const [quotedParents, setQuotedParents] = useState<Map<string, Message>>(
    () => new Map()
  );
  const requestedParentIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    requestedParentIdsRef.current = new Set();
    setQuotedParents(new Map());
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId || messages.length === 0) return;
    const loaded = new Set(messages.map((m) => m.id));
    const missing: string[] = [];
    for (const m of messages) {
      const parentId = m.reply_to_message_id;
      if (
        parentId &&
        !loaded.has(parentId) &&
        !requestedParentIdsRef.current.has(parentId)
      ) {
        requestedParentIdsRef.current.add(parentId);
        missing.push(parentId);
      }
    }
    if (missing.length === 0) return;
    // Sem cleanup de cancelamento: os ids já foram marcados como pedidos,
    // então descartar a resposta a cada nova mensagem perderia a citação.
    // Basta conferir se a conversa ainda é a mesma.
    const requestedFor = conversationId;
    void createClient()
      .from('messages')
      .select('*')
      .eq('conversation_id', requestedFor)
      .in('id', missing)
      .then(({ data }) => {
        if (activeConversationIdRef.current !== requestedFor) return;
        if (!data || data.length === 0) return;
        setQuotedParents((prev) => {
          const next = new Map(prev);
          for (const row of data as Message[]) next.set(row.id, row);
          return next;
        });
      });
  }, [conversationId, messages]);

  // Reactions fetch — pulls the current state from the DB. Kept separate
  // from the channel subscription below so a `resyncToken` bump just
  // refetches the rows without also tearing down and rebuilding the
  // realtime channel.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('message_reactions')
        .select('*')
        .eq('conversation_id', conversationId);
      if (cancelled) return;
      if (error) {
        console.error('Failed to fetch reactions:', error);
        return;
      }
      setReactions((data as MessageReaction[]) ?? []);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // Reactions realtime subscription per conversation. Subscribing here
  // (not at the page level) keeps the channel scoped to the visible
  // conversation and avoids cross-conversation chatter on a busy inbox.
  useEffect(() => {
    if (!conversationId) return;
    const supabase = createClient();

    const channel = supabase
      .channel(`reactions:${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => {
            if (prev.some((r) => r.id === row.id)) return prev;
            // Swap any matching optimistic temp row for the real one so
            // the pill doesn't double up after a successful POST.
            const tempIdx = prev.findIndex(
              (r) =>
                r.id.startsWith('temp-') &&
                r.message_id === row.message_id &&
                r.actor_type === row.actor_type &&
                r.actor_id === row.actor_id
            );
            if (tempIdx >= 0) {
              const copy = prev.slice();
              copy[tempIdx] = row;
              return copy;
            }
            return [...prev, row];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as MessageReaction;
          setReactions((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'message_reactions',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const old = payload.old as Partial<MessageReaction>;
          if (!old?.id) return;
          setReactions((prev) => prev.filter((r) => r.id !== old.id));
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [conversationId]);

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    const supabase = createClient();
    supabase
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId)
      .then(({ error }) => {
        if (error) console.error('Failed to reset unread_count:', error);
      });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages — but only when the agent
  // is already near the bottom. Yanking a user who scrolled up to read
  // history back down on every inbound message is the classic mobile
  // chat annoyance; the scroll-to-bottom FAB (below) covers the rest.
  //
  // A conversa SEMPRE abre na última mensagem. Antes o scroll ao abrir
  // rodava com o spinner ainda na tela (lista vazia) e, quando as
  // mensagens chegavam, a checagem "está perto do fim?" dava falso — a
  // thread ficava parada no topo, nas mensagens mais antigas.
  const [showScrollFab, setShowScrollFab] = useState(false);
  /** Mensagens do cliente que chegaram enquanto o agente lia o histórico. */
  const [unseenCount, setUnseenCount] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<{ conversationId?: string; id?: string }>({});

  // Layout effect (antes da pintura): sem piscar no topo ao abrir, e a
  // posição é restaurada no mesmo frame em que o histórico entra.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      el.scrollTop = anchor.top + (el.scrollHeight - anchor.height);
      return;
    }

    const last = messages[messages.length - 1];
    const previous = lastMessageRef.current;
    const sameConversation = previous.conversationId === conversationId;
    const appended = sameConversation && !!last && previous.id !== last.id;
    lastMessageRef.current = { conversationId, id: last?.id };

    // Enviar uma mensagem sempre leva ao fim, mesmo lendo o histórico.
    if (appended && last && isOptimisticMessage(last)) {
      stickToBottomRef.current = true;
    }

    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    } else if (appended && last?.sender_type === 'customer') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- contador derivado de uma mudança externa (mensagem recebida) cruzada com a posição do scroll, que só existe no DOM.
      setUnseenCount((n) => n + 1);
    }
  }, [messages, loading, conversationId]);

  useEffect(() => {
    setShowScrollFab(false);
    setUnseenCount(0);
  }, [conversationId]);

  // Imagens, áudios e cartões de anúncio mudam de altura depois de
  // renderizados; o teclado do celular e o composer mudam a altura da
  // área visível. Em qualquer dos casos, se o agente está no fim da
  // conversa, continua no fim.
  const threadVisible = !!conversation && !!contact;
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && !prependAnchorRef.current) {
        el.scrollTop = el.scrollHeight;
      }
    });
    observer.observe(content);
    observer.observe(el);
    return () => observer.disconnect();
  }, [conversationId, threadVisible]);

  const handleThreadScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const nearBottom = distance < 120;
    stickToBottomRef.current = nearBottom;
    setShowScrollFab(distance > 240);
    if (nearBottom) setUnseenCount(0);
    // Histórico sob demanda ao chegar perto do topo.
    if (el.scrollTop < 240 && hasOlderRef.current) void loadOlder();
  }, [loadOlder]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setShowScrollFab(false);
    setUnseenCount(0);
  }, []);

  // Mobile contact sheet — the right-rail ContactSidebar never renders
  // below lg, so tapping the thread header's avatar/name opens the same
  // panel as a bottom sheet instead.
  const [contactSheetOpen, setContactSheetOpen] = useState(false);
  const openContactSheet = useCallback(() => {
    // Desktop already shows the sidebar; the sheet is mobile-only.
    if (typeof window !== 'undefined' && window.innerWidth >= 1024) return;
    setContactSheetOpen(true);
  }, []);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'text',
        content_text: text,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch(sendEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'text',
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send message:', reason);
          toast.error(`Falha ao enviar: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send message:', err);
        const reason = err instanceof Error ? err.message : 'erro de rede';
        toast.error(`Falha ao enviar: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, sendEndpoint, onNewMessage, onUpdateMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === 'document'
          ? payload.caption || payload.filename || 'Documento'
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch(sendEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send media:', reason);
          toast.error(`Falha ao enviar: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
            () => {}
          );
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send media:', err);
        const reason = err instanceof Error ? err.message : 'erro de rede';
        toast.error(`Falha ao enviar: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(
          () => {}
        );
      }
    },
    [conversation, sendEndpoint, onNewMessage, onUpdateMessage]
  );

  const handleSendInteractive = useCallback(
    async (payload: InteractiveMessagePayload, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;
      // Optimistic bubble — renders the buttons/list immediately via the
      // interactive_payload, same as the persisted row will.
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: payload.body,
        interactive_payload: payload,
        status: 'sending',
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch(sendEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'interactive',
            interactive_payload: payload,
            reply_to_message_id: replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error('Failed to send interactive message:', reason);
          toast.error(`Falha ao enviar: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send interactive message:', err);
        const reason = err instanceof Error ? err.message : 'erro de rede';
        toast.error(`Falha ao enviar: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, sendEndpoint, onNewMessage, onUpdateMessage]
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      const supabase = createClient();
      await supabase
        .from('conversations')
        .update({ status })
        .eq('id', conversation.id);

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
        headerMediaUrl?: string;
      }
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: 'agent',
        content_type: 'template',
        content_text: renderedBody,
        template_name: template.name,
        status: 'sending',
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        // Templates are WhatsApp-only, always use whatsapp endpoint
        const res = await fetch('/api/whatsapp/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: 'template',
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
              headerMediaUrl: values.headerMediaUrl,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error('Failed to send template:', reason);
          toast.error(`Falha ao enviar o modelo: ${reason}`);
          onUpdateMessage(tempId, { status: 'failed' });
          return;
        }

        onUpdateMessage(tempId, { status: 'sent' });
      } catch (err) {
        console.error('Failed to send template:', err);
        const reason = err instanceof Error ? err.message : 'erro de rede';
        toast.error(`Falha ao enviar o modelo: ${reason}`);
        onUpdateMessage(tempId, { status: 'failed' });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  const messageGroups = useMemo(
    () => groupMessagesByDate(messages),
    [messages]
  );

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || 'Cliente';

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg = m.sender_type === 'agent' || m.sender_type === 'bot';
      return isAgentMsg ? 'Você' : contactDisplayName;
    },
    [contactDisplayName]
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg, tQuote),
      });
    },
    [authorLabelFor, tQuote]
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversationId) {
        console.warn('[reactions] missing user or conversation');
        return;
      }
      if (messageId.startsWith('temp-')) {
        toast.error('Aguarde o envio da mensagem terminar');
        return;
      }

      const convId = conversationId;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === 'agent' &&
            r.actor_id === userId
        );
        if (emoji === '') return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: 'agent',
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch('/api/whatsapp/react', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'erro de rede';
        toast.error(`Falha na reação: ${reason}`);
        setReactions(snapshot);
      }
    },
    // Depende só dos ids: o objeto `conversation` muda a cada evento do
    // realtime e recriar esta função re-renderizaria todas as bolhas.
    [conversationId, user?.id]
  );

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      const supabase = createClient();
      const { error } = await supabase
        .from('conversations')
        .update({ assigned_agent_id: agentId })
        .eq('id', conversation.id);

      if (error) {
        console.error('Failed to update assignment:', error);
        toast.error('Falha ao atualizar a atribuição');
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange]
  );

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div
        className={cn(
          'flex flex-1 flex-col items-center justify-center',
          DOODLE_BG_CLASSES
        )}
      >
        <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
          <MessageSquare className="text-muted-foreground h-8 w-8" />
        </div>
        <h3 className="text-muted-foreground mt-4 text-sm font-medium">
          {t('selectConversation')}
        </h3>
        <p className="text-muted-foreground mt-1 text-xs">
          {t('selectConversationHint')}
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? t('assigned'))
    : t('assign');

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div className={cn('flex min-w-0 flex-1 flex-col', DOODLE_BG_CLASSES)}>
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex min-h-[60px] items-center justify-between gap-1 border-b border-border bg-card px-2 py-2 sm:gap-2 sm:px-4 sm:py-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread.
              44px hit target per Apple HIG. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label={t('backToConversations')}
              className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground active:bg-muted lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          {/* Avatar + name double as the contact-sheet trigger on mobile,
              where the right-rail sidebar never renders. Desktop keeps
              the static display (sidebar is already visible / toggleable). */}
          <button
            type="button"
            onClick={openContactSheet}
            aria-label={t('viewContact')}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left active:bg-muted sm:gap-3 lg:cursor-default lg:active:bg-transparent"
          >
            <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
              {displayName.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-foreground">
                {displayName}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="truncate text-xs text-muted-foreground">
                  {contact.phone}
                </span>
                {/* Channel indicator — click to toggle between WhatsApp / Uazapi */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleChannel();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleChannel();
                    }
                  }}
                  title={`Enviando por ${effectiveChannel === 'uazapi' ? 'Uazapi' : 'WhatsApp'}: clique para trocar`}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium transition-colors',
                    effectiveChannel === 'uazapi'
                      ? 'bg-violet-500/10 text-violet-400 hover:bg-violet-500/20'
                      : 'bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20'
                  )}
                >
                  {effectiveChannel === 'uazapi' ? 'UZ' : 'WA'}
                </span>
              </span>
            </span>
          </button>
          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. */}
          <Badge
            variant="outline"
            className={cn(
              'border-border ml-1 hidden gap-1 text-[10px] sm:ml-2 sm:inline-flex',
              effectiveChannel === 'uazapi'
                ? 'text-violet-400'
                : sessionInfo.expired
                  ? 'text-red-400'
                  : 'text-primary'
            )}
          >
            <Clock className="h-3 w-3" />
            {effectiveChannel === 'uazapi'
              ? tTimer('uazapiUnlimited')
              : sessionInfo.remaining}
          </Badge>
        </div>

        <div className="flex shrink-0 items-center gap-0.5 sm:gap-2">
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? t('hideContactPanel') : t('showContactPanel')
              }
              title={contactPanelOpen ? t('hideContact') : t('showContact')}
              aria-pressed={contactPanelOpen}
              className={cn(
                'hover:bg-muted hover:text-foreground hidden h-7 w-7 items-center justify-center rounded-md transition-colors lg:inline-flex',
                contactPanelOpen ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label={t('refreshConversation')}
              title={t('refresh')}
              className={cn(
                'text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-9 w-9 items-center justify-center rounded-md transition-colors disabled:opacity-60 sm:h-7 sm:w-7'
              )}
            >
              <RefreshCw
                className={cn('h-3.5 w-3.5', isRefreshing && 'animate-spin')}
              />
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs sm:h-7',
                currentStatus?.color ?? 'text-muted-foreground'
              )}
            >
              {currentStatus ? t(currentStatus.labelKey) : t('status')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn('text-sm', opt.color)}
                >
                  {t(opt.labelKey)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                'hover:bg-muted inline-flex h-9 items-center justify-center gap-1 rounded-md px-2 text-xs sm:h-7',
                assignedAgentId ? 'text-primary' : 'text-muted-foreground'
              )}
            >
              <UserPlus className="h-4 w-4 sm:h-3 sm:w-3" />
              <span className="hidden sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {profiles.length === 0 ? (
                <DropdownMenuItem
                  disabled
                  className="text-muted-foreground text-sm"
                >
                  {t('noTeammates')}
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        'text-sm',
                        isSelected ? 'text-primary' : 'text-popover-foreground'
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? t('me') : ''}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-muted-foreground text-sm"
                  >
                    {t('unassign')}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Messages Area */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={handleThreadScroll}
          className="flex-1 touch-pan-y overscroll-contain overflow-y-auto px-3 py-4 sm:px-4"
        >
        <div ref={contentRef}>
        {loading ? (
          <ThreadSkeleton label={t('loadingMessages')} />
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground text-sm">
              {t('noMessagesYet')}
            </p>
            <p className="text-muted-foreground text-xs">
              {t('sendTemplateHint')}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Histórico sob demanda: carrega sozinho ao rolar até o topo;
                o botão cobre teclado, leitor de tela e threads curtas
                demais para rolar. */}
            {hasOlder ? (
              <div className="flex justify-center">
                <button
                  type="button"
                  onClick={() => void loadOlder()}
                  disabled={loadingOlder}
                  className="bg-card text-muted-foreground hover:text-foreground border-border inline-flex h-8 items-center gap-2 rounded-full border px-3 text-xs font-medium shadow-sm transition-colors disabled:opacity-70"
                >
                  {loadingOlder && (
                    <span
                      aria-hidden
                      className="border-primary h-3 w-3 animate-spin rounded-full border-2 border-t-transparent"
                    />
                  )}
                  {loadingOlder ? t('loadingOlder') : t('loadOlder')}
                </button>
              </div>
            ) : (
              <p className="text-muted-foreground text-center text-[11px]">
                {t('conversationStart')}
              </p>
            )}
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator — fica preso no topo enquanto o dia
                    está na tela, como nos apps de mensagem. */}
                <div className="pointer-events-none sticky top-0 z-10 mb-4 flex items-center justify-center">
                  <span className="bg-card/90 text-muted-foreground border-border rounded-full border px-3 py-1 text-[10px] font-medium shadow-sm backdrop-blur">
                    {formatDateSeparator(group.date, t)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => (
                    <ThreadMessageRow
                      key={msg.id}
                      message={msg}
                      parent={
                        msg.reply_to_message_id
                          ? (messagesById.get(msg.reply_to_message_id) ??
                            quotedParents.get(msg.reply_to_message_id) ??
                            null)
                          : null
                      }
                      contactLabel={contactDisplayName}
                      reactions={reactionsByMessageId.get(msg.id)}
                      currentUserId={user?.id}
                      onReply={handleStartReply}
                      onReact={postReaction}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        </div>
        </div>
        {/* Scroll-to-bottom FAB — appears when the agent scrolled up;
            standard chat-app pattern for long threads. Mostra quantas
            mensagens do cliente chegaram nesse meio-tempo. */}
        {showScrollFab && (
          <button
            type="button"
            onClick={scrollToBottom}
            aria-label={
              unseenCount > 0
                ? t('newMessagesBelow', { count: unseenCount })
                : t('scrollToBottom')
            }
            className="border-border bg-card text-foreground active:bg-muted absolute right-4 bottom-4 flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition-transform hover:scale-105"
          >
            <ArrowDown className="h-5 w-5" />
            {unseenCount > 0 && (
              <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-semibold">
                {unseenCount > 99 ? '99+' : unseenCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* AI auto-reply banner — take over an active bot, or resume it
          after a handoff. Renders nothing unless the account has
          auto-reply configured. */}
      <AiThreadBanner
        conversationId={conversation.id}
        disabled={conversation.ai_autoreply_disabled ?? false}
        handoffSummary={conversation.ai_handoff_summary}
        assignedAgentId={assignedAgentId}
        currentUserId={user?.id}
        onChange={(patch) => {
          if ('assigned_agent_id' in patch) {
            onAssignChange(conversation.id, patch.assigned_agent_id ?? null);
          }
        }}
      />

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionLocked}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onSendInteractive={handleSendInteractive}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {/* Mobile contact sheet — bottom-sheet presentation of the same
          panel desktop renders as a right rail. */}
      <Dialog open={contactSheetOpen} onOpenChange={setContactSheetOpen}>
        <DialogContent className="max-h-[85dvh] overflow-hidden border-border bg-card p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:right-0 max-sm:w-full max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none max-sm:rounded-t-2xl sm:max-w-md">
          <DialogHeader className="sr-only">
            <DialogTitle>{displayName}</DialogTitle>
          </DialogHeader>
          {/* Drag handle */}
          <div className="flex shrink-0 justify-center pt-2.5 sm:hidden" aria-hidden>
            <span className="h-1 w-10 rounded-full bg-muted-foreground/40" />
          </div>
          <div className="min-h-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
            <ContactSidebar contact={contact} className="h-auto w-full border-l-0" />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
