'use client';

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { createClient } from '@/lib/supabase/client';
import { runBulkTagAction, type BulkTagAction } from '@/lib/contacts/bulk-tags';
import {
  deleteContactsInBatches,
  fetchContactPage,
  fetchContactTagIds,
} from '@/lib/contacts/contact-list';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { useWindowedRows } from '@/hooks/use-windowed-rows';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { Contact, Tag as TagType, ContactTag } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Search,
  Plus,
  Upload,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Users,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Filter,
  X,
  List,
  Tag,
  Tags,
  MessageSquare,
  Smartphone,
} from 'lucide-react';
import { ContactForm } from '@/components/contacts/contact-form';
import { ContactDetailView } from '@/components/contacts/contact-detail-view';
import { ImportModal } from '@/components/contacts/import-modal';
import { BulkAddContactsModal } from '@/components/contacts/bulk-add-modal';
import { CustomFieldsManager } from '@/components/contacts/custom-fields-manager';
import { useCan } from '@/hooks/use-can';
import { GatedButton } from '@/components/ui/gated-button';
import { useTranslations } from 'next-intl';

const PAGE_SIZE_OPTIONS = [250, 500, 1000, 2000, 3000];
const SEARCH_DEBOUNCE_MS = 300;
const TAG_FILTER_DEBOUNCE_MS = 250;
// Altura esperada da linha, com o conteúdo em uma só linha de texto. A janela
// de linhas visíveis mede a altura real; este valor só vale até a primeira medição.
const ROW_HEIGHT = 45;
const COLUMN_COUNT = 8;

// Criar um Intl.DateTimeFormat por linha, como faz toLocaleDateString com
// opções, custa caro numa lista longa.
const CREATED_AT_FORMAT = new Intl.DateTimeFormat('pt-BR', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

interface ContactWithTags extends Contact {
  tags?: TagType[];
}

type BulkProgress = {
  done: number;
  total: number;
} & (
  | { kind: BulkTagAction; tagName: string }
  | { kind: 'delete' }
);

interface ContactRowProps {
  contact: ContactWithTags;
  index: number;
  isSelected: boolean;
  tagsPending: boolean;
  onRowClick: (id: string, index: number, event: React.MouseEvent) => void;
  onToggleCheckbox: (id: string, index: number, shiftKey: boolean) => void;
  onOpenDetail: (contactId: string) => void;
  onOpenEdit: (contact: Contact) => void;
  onConfirmDelete: (contact: Contact) => void;
  t: ReturnType<typeof useTranslations>;
}

// Linha memorizada e com handlers estáveis: um clique de seleção só
// re-renderiza a linha cujo `isSelected` mudou, e só as linhas perto da área
// visível chegam a ser montadas (ver useWindowedRows).
const ContactRow = memo(function ContactRow({
  contact,
  index,
  isSelected,
  tagsPending,
  onRowClick,
  onToggleCheckbox,
  onOpenDetail,
  onOpenEdit,
  onConfirmDelete,
  t,
}: ContactRowProps) {
  // Abrir um contato não mexe na seleção: um clique no nome não pode
  // descartar centenas de contatos já marcados.
  const openOnPlainClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.stopPropagation();
    onOpenDetail(contact.id);
  };

  return (
    <TableRow
      data-window-row
      aria-rowindex={index + 2}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        "border-border hover:bg-muted/50 cursor-pointer",
        isSelected && "bg-muted/30"
      )}
      onMouseDown={(e) => {
        // Shift+clique marca um intervalo de linhas, não um trecho de texto.
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => onRowClick(contact.id, index, e)}
    >
      <TableCell
        onClick={(e) => {
          // A caixa soma à seleção, em vez de substituí-la como o clique na
          // linha. O Base UI repassa o clique a um input oculto: só o clique
          // original conta, senão a caixa alternaria duas vezes.
          e.stopPropagation();
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          onToggleCheckbox(contact.id, index, e.shiftKey);
        }}
      >
        <Checkbox
          checked={isSelected}
          aria-label={`Selecionar ${contact.name || contact.phone}`}
        />
      </TableCell>
      <TableCell
        className="truncate text-foreground font-medium cursor-pointer"
        onClick={openOnPlainClick}
      >
        {contact.name || <span className="text-muted-foreground italic">{t('unnamed')}</span>}
      </TableCell>
      <TableCell
        className="truncate text-muted-foreground font-mono text-xs cursor-pointer"
        onClick={openOnPlainClick}
      >
        {contact.phone}
      </TableCell>
      <TableCell className="truncate text-muted-foreground hidden md:table-cell text-sm">
        {contact.email || <span className="text-muted-foreground">-</span>}
      </TableCell>
      <TableCell className="truncate text-muted-foreground hidden lg:table-cell text-sm">
        {contact.company || <span className="text-muted-foreground">-</span>}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <div className="flex items-center gap-1 overflow-hidden">
          {contact.tags && contact.tags.length > 0 ? (
            contact.tags.slice(0, 3).map((tag) => (
              <span
                key={tag.id}
                className="min-w-0 max-w-28 truncate rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  backgroundColor: tag.color + '20',
                  color: tag.color,
                }}
              >
                {tag.name}
              </span>
            ))
          ) : tagsPending ? (
            <span className="h-4 w-16 rounded-full bg-muted animate-pulse" />
          ) : (
            <span className="text-muted-foreground text-xs">-</span>
          )}
          {contact.tags && contact.tags.length > 3 && (
            <span className="shrink-0 text-[10px] text-muted-foreground">
              +{contact.tags.length - 3}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="truncate text-muted-foreground text-xs hidden lg:table-cell">
        {CREATED_AT_FORMAT.format(new Date(contact.created_at))}
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="bg-popover border-border"
          >
            <DropdownMenuItem
              onClick={(e) => {
                e.stopPropagation();
                onOpenEdit(contact);
              }}
              className="text-popover-foreground focus:bg-muted focus:text-foreground"
            >
              <Pencil className="size-4" />
              {t('editAction')}
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => {
                e.stopPropagation();
                onConfirmDelete(contact);
              }}
            >
              <Trash2 className="size-4" />
              {t('deleteAction')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

export default function ContactsPage() {
  const t = useTranslations('Contacts.page');
  // Memoizado para manter identidade estável entre renders — os
  // useCallbacks/useEffects abaixo dependem dele; nova identidade a
  // cada render invalidaria tudo e refaria fetches em loop.
  const supabase = useMemo(() => createClient(), []);
  const canEdit = useCan('send-messages');
  const canEditSettings = useCan('edit-settings');

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [tagIdsByContact, setTagIdsByContact] = useState<Map<string, string[]>>(
    () => new Map()
  );
  const [tagsPending, setTagsPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(250);
  const [totalCount, setTotalCount] = useState(0);
  // Tag filter — contacts shown must have ANY of these tags (OR).
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  // Channel filter — 'whatsapp' = API oficial, 'uazapi' = UZ API.
  // Contato entra quando tem conversa OU mensagem do canal (cobre
  // mistas com conversations.source NULL e linhas legadas).
  type ChannelFilter = 'all' | 'whatsapp' | 'uazapi';
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>('all');

  // Modals
  const [formOpen, setFormOpen] = useState(false);
  const [editContact, setEditContact] = useState<Contact | null>(null);
  const [editContactTags, setEditContactTags] = useState<ContactTag[]>([]);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [bulkAddOpen, setBulkAddOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Contact | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Bulk selection (page-scoped — only the loaded rows are selectable)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null);
  const bulkBusy = bulkProgress !== null;

  // Refs, não estado: os handlers das linhas precisam de identidade estável
  // para o memo de ContactRow valer, e nada na tela depende destes valores.
  const lastSelectedIndexRef = useRef<number | null>(null);
  const contactsRef = useRef<Contact[]>([]);

  // All tags for display
  const [tagsMap, setTagsMap] = useState<Record<string, TagType>>({});

  // Busca e etiquetas só consultam quando param de mudar: digitar um nome
  // ou marcar várias etiquetas seguidas não dispara uma consulta por vez.
  const debouncedSearch = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const debouncedTagIds = useDebouncedValue(selectedTagIds, TAG_FILTER_DEBOUNCE_MS);

  // Guards against out-of-order fetch responses: each fetchContacts run
  // claims a sequence number and only the latest is allowed to commit its
  // results. Without this, rapidly toggling tag filters could let a slower
  // earlier request resolve last and render stale rows.
  const fetchSeq = useRef(0);

  // As etiquetas ficam fora da busca de contatos: recarregar a lista de
  // etiquetas não refaz a consulta de contatos, só a montagem das linhas.
  const rows = useMemo<ContactWithTags[]>(
    () =>
      contacts.map((contact) => ({
        ...contact,
        tags: (tagIdsByContact.get(contact.id) ?? [])
          .map((tagId) => tagsMap[tagId])
          .filter(Boolean),
      })),
    [contacts, tagIdsByContact, tagsMap]
  );

  const {
    anchorRef,
    start: windowStart,
    end: windowEnd,
    paddingTop,
    paddingBottom,
    scrollToTop,
  } = useWindowedRows({ count: rows.length, rowHeight: ROW_HEIGHT });

  useEffect(() => {
    contactsRef.current = contacts;
  }, [contacts]);

  // Um lote pela metade é seguro de repetir, mas fechar a aba interrompe o
  // restante: o navegador pergunta antes.
  useEffect(() => {
    if (!bulkBusy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [bulkBusy]);

  const fetchTags = useCallback(async () => {
    const { data } = await supabase.from('tags').select('*');
    if (data) {
      const map: Record<string, TagType> = {};
      data.forEach((t) => (map[t.id] = t));
      setTagsMap(map);
      // Drop any filter selections whose tag no longer exists (e.g. a tag
      // deleted elsewhere) so it can't linger invisibly in the query.
      setSelectedTagIds((prev) => {
        const pruned = prev.filter((id) => map[id]);
        return pruned.length === prev.length ? prev : pruned;
      });
    }
  }, [supabase]);

  const fetchContacts = useCallback(async (
    { keepSelection = false }: { keepSelection?: boolean } = {}
  ) => {
    const seq = ++fetchSeq.current;
    const isSuperseded = () => seq !== fetchSeq.current;
    setLoading(true);
    // The visible rows are about to change — drop any selection that
    // referred to the old page/search results so the bulk bar can't
    // act on rows the user can no longer see. A plain refresh of the same
    // list keeps it, pruned below once the new rows arrive.
    if (!keepSelection) {
      setSelected(new Set());
      lastSelectedIndexRef.current = null;
    }

    let result;
    try {
      result = await fetchContactPage(
        supabase,
        {
          from: page * pageSize,
          pageSize,
          term: debouncedSearch.trim(),
          tagIds: debouncedTagIds,
          source: channelFilter === 'all' ? null : channelFilter,
        },
        isSuperseded
      );
    } catch {
      if (isSuperseded()) return;
      toast.error(t('toastFailedLoad'));
      setLoading(false);
      setTagsPending(false);
      return;
    }
    if (!result || isSuperseded()) return;

    // Página além do fim, por exemplo depois de excluir a última inteira.
    if (result.rows.length === 0 && page > 0) {
      setPage(0);
      return;
    }

    // As linhas aparecem já; as etiquetas chegam em seguida, em pedaços.
    setTotalCount(result.total);
    setContacts(result.rows);
    setLoading(false);
    const visibleIds = new Set(result.rows.map((row) => row.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => visibleIds.has(id)));
      return next.size === prev.size ? prev : next;
    });

    if (result.rows.length === 0) {
      setTagsPending(false);
      return;
    }

    setTagsPending(true);
    try {
      const tagIds = await fetchContactTagIds(
        supabase,
        result.rows.map((row) => row.id),
        isSuperseded
      );
      if (!tagIds || isSuperseded()) return;
      setTagIdsByContact(tagIds);
    } catch {
      if (isSuperseded()) return;
      toast.warning(t('toastTagsLoadFailed'));
    }
    setTagsPending(false);
  }, [supabase, page, pageSize, debouncedSearch, debouncedTagIds, channelFilter, t]);

  // Recarrega a mesma lista, sem descartar a seleção de quem está trabalhando.
  const refreshContacts = useCallback(
    () => fetchContacts({ keepSelection: true }),
    [fetchContacts]
  );

  // Load-once-on-mount-ish data fetches. Each setter inside runs
  // inside an async promise completion (Supabase await), not
  // synchronously in the effect body, so the cascade the lint rule
  // warns about doesn't apply here.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchTags();
  }, [fetchTags]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContacts();
  }, [fetchContacts]);

  // Outra página ou outro filtro: a lista recomeça do topo.
  useEffect(() => {
    scrollToTop();
  }, [scrollToTop, page, pageSize, debouncedSearch, debouncedTagIds, channelFilter]);

  function openAddForm() {
    setEditContact(null);
    setEditContactTags([]);
    setFormOpen(true);
  }

  const openEditForm = useCallback(async (contact: Contact) => {
    const { data } = await supabase
      .from('contact_tags')
      .select('*')
      .eq('contact_id', contact.id);
    setEditContact(contact);
    setEditContactTags(data ?? []);
    setFormOpen(true);
  }, [supabase]);

  const openDetail = useCallback((contactId: string) => {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }, []);

  const confirmDelete = useCallback((contact: Contact) => {
    setDeleteTarget(contact);
    setDeleteConfirmOpen(true);
  }, []);

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);

    const { error } = await supabase
      .from('contacts')
      .delete()
      .eq('id', deleteTarget.id);

    if (error) {
      toast.error(t('toastFailedDelete'));
    } else {
      toast.success(t('toastDeleted'));
      refreshContacts();
    }

    setDeleting(false);
    setDeleteConfirmOpen(false);
    setDeleteTarget(null);
  }

  const allOnPageSelected = useMemo(
    () => contacts.length > 0 && contacts.every((c) => selected.has(c.id)),
    [contacts, selected]
  );
  const someOnPageSelected = useMemo(
    () => contacts.some((c) => selected.has(c.id)),
    [contacts, selected]
  );

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }, [contacts, allOnPageSelected]);

  // Soma à seleção o intervalo entre o último clique e esta linha.
  const selectRange = useCallback((from: number, to: number) => {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    // Snapshot fora do updater: o updater pode rodar 2x no StrictMode.
    const ids = contactsRef.current.slice(start, end + 1).map((c) => c.id);
    setSelected((prev) => {
      const next = new Set(prev);
      ids.forEach((cid) => next.add(cid));
      return next;
    });
  }, []);

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleRowClick = useCallback((id: string, index: number, event: React.MouseEvent) => {
    // Handle shift+click for range selection (Windows-style)
    const last = lastSelectedIndexRef.current;
    if (event.shiftKey && last !== null) {
      selectRange(last, index);
      return;
    }

    lastSelectedIndexRef.current = index;

    // Handle ctrl/cmd+click for individual toggle
    if (event.ctrlKey || event.metaKey) {
      toggleOne(id);
      return;
    }

    // Default click behavior — if already selected, deselect; otherwise replace selection
    setSelected((prev) => {
      const next = new Set<string>();
      if (prev.has(id) && prev.size === 1) {
        // clicking the only selected item deselects it
      } else {
        next.add(id);
      }
      return next;
    });
  }, [selectRange, toggleOne]);

  const handleCheckboxToggle = useCallback((id: string, index: number, shiftKey: boolean) => {
    const last = lastSelectedIndexRef.current;
    if (shiftKey && last !== null) {
      selectRange(last, index);
      return;
    }
    lastSelectedIndexRef.current = index;
    toggleOne(id);
  }, [selectRange, toggleOne]);

  async function handleBulkTag(tag: TagType, action: BulkTagAction) {
    const ids = [...selected];
    if (ids.length === 0 || bulkBusy) return;

    setBulkProgress({ kind: action, tagName: tag.name, done: 0, total: ids.length });
    const outcome = await runBulkTagAction({
      contactIds: ids,
      tagId: tag.id,
      action,
      onProgress: ({ done, total }) =>
        setBulkProgress({ kind: action, tagName: tag.name, done, total }),
    });
    setBulkProgress(null);

    const processed = outcome.total - outcome.failedIds.length;

    if (outcome.error) {
      // Quem ficou de fora continua selecionado: repetir a ação termina o
      // lote, e os que já foram gravados só contam como "sem alteração".
      setSelected(new Set(outcome.failedIds));
      const description = t('bulkTagFailedDesc', {
        failed: outcome.failedIds.length,
        reason: outcome.error,
      });
      if (processed > 0) {
        toast.error(t('toastBulkTagPartial', { done: processed, total: outcome.total }), {
          description,
          duration: Infinity,
          closeButton: true,
        });
        refreshContacts();
      } else {
        toast.error(t('toastBulkTagFailed'), { description, duration: 10000 });
      }
      return;
    }

    setSelected(new Set());
    const details = [
      outcome.unchanged > 0 &&
        t(action === 'add' ? 'bulkTagUnchangedAdd' : 'bulkTagUnchangedRemove', {
          count: outcome.unchanged,
        }),
      outcome.notFound > 0 && t('bulkTagNotFound', { count: outcome.notFound }),
    ].filter(Boolean);
    toast.success(
      t(action === 'add' ? 'toastBulkTagAdded' : 'toastBulkTagRemoved', {
        count: outcome.changed,
        tag: tag.name,
      }),
      { description: details.join(' ') || undefined }
    );
    refreshContacts();
  }

  async function handleBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0 || bulkBusy) return;
    setDeleting(true);
    setBulkProgress({ kind: 'delete', done: 0, total: ids.length });

    const outcome = await deleteContactsInBatches(supabase, ids, (done, total) =>
      setBulkProgress({ kind: 'delete', done, total })
    );

    setSelected(new Set(outcome.failedIds));
    if (!outcome.failed) {
      toast.success(t('toastBulkDeleted', { count: outcome.deleted }));
    } else if (outcome.deleted > 0) {
      toast.error(
        t('toastBulkDeletePartial', { deleted: outcome.deleted, total: ids.length }),
        {
          description: t('bulkDeleteFailedDesc', { failed: outcome.failedIds.length }),
          duration: Infinity,
          closeButton: true,
        }
      );
    } else {
      toast.error(t('toastBulkFailedDelete'));
    }
    refreshContacts();

    setBulkProgress(null);
    setDeleting(false);
    setBulkDeleteOpen(false);
  }

  const totalPages = Math.ceil(totalCount / pageSize);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;

  // Tag filter helpers. Every change resets to page 0 — the result set
  // shrinks/grows so page N may no longer be valid (mirrors the search box).
  // Memorizado: Object.values().sort() a cada render custava O(n log n)
  // à toa e quebrava a estabilidade de props dos componentes filhos.
  const allTags = useMemo(
    () => Object.values(tagsMap).sort((a, b) => a.name.localeCompare(b.name)),
    [tagsMap]
  );
  const hasActiveFilters = search.trim().length > 0 || selectedTagIds.length > 0 || channelFilter !== 'all';

  function toggleTagFilter(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId)
        ? prev.filter((id) => id !== tagId)
        : [...prev, tagId]
    );
    setPage(0);
  }

  function clearTagFilters() {
    setSelectedTagIds([]);
    setPage(0);
  }

  function selectChannel(value: ChannelFilter) {
    setChannelFilter(value);
    setPage(0);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-foreground">
            {t('title')}
            {loading && rows.length > 0 && (
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('loading')} />
            )}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {totalCount > 0 ? t('subtitle', { count: totalCount }) : t('subtitleZero')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canEditSettings && (
            <Button
              variant="outline"
              onClick={() => setCustomFieldsOpen(true)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <SlidersHorizontal className="size-4" />
              {t('customFieldsBtn')}
            </Button>
          )}
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="adicionar ou importar contatos"
            onClick={() => setImportOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <Upload className="size-4" />
            {t('importBtn')}
          </GatedButton>
          <GatedButton
            variant="outline"
            canAct={canEdit}
            gateReason="adicionar ou importar contatos"
            onClick={() => setBulkAddOpen(true)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            <List className="size-4" />
            {t('bulkAddBtn')}
          </GatedButton>
          <GatedButton
            canAct={canEdit}
            gateReason="adicionar ou importar contatos"
            onClick={openAddForm}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" />
            {t('addContactBtn')}
          </GatedButton>
        </div>
      </div>

      {/* Search + tag filter */}
      <div className="space-y-2">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                // Reset pagination when the query changes — the result
                // set shrinks/grows, page N may no longer be valid.
                setPage(0);
              }}
              placeholder={t('searchPlaceholder')}
              className="pl-8 bg-card border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>

          <Popover>
            <PopoverTrigger
              render={
                <Button
                  variant="outline"
                  className="border-border text-muted-foreground hover:bg-muted shrink-0"
                />
              }
            >
              <Filter className="size-4" />
              {t('filterByTags')}
              {selectedTagIds.length > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                  {selectedTagIds.length}
                </span>
              )}
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 p-0">
              <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                <span className="text-sm font-medium text-popover-foreground">
                  {t('filterByTags')}
                </span>
                {selectedTagIds.length > 0 && (
                  <button
                    onClick={clearTagFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t('clearAll')}
                  </button>
                )}
              </div>
              {allTags.length === 0 ? (
                <p className="px-3 py-4 text-sm text-muted-foreground text-center">
                  {t('noTagsYet')}
                </p>
              ) : (
                <div className="max-h-64 overflow-y-auto py-1">
                  {allTags.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={selectedTagIds.includes(tag.id)}
                        onCheckedChange={() => toggleTagFilter(tag.id)}
                        aria-label={`Filtrar por ${tag.name}`}
                      />
                      <span
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: tag.color }}
                      />
                      <span className="text-sm text-popover-foreground truncate">
                        {tag.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </PopoverContent>
          </Popover>

          {/* Channel filter — Todos / API oficial (WA) / UZ API */}
          <div
            className="flex items-center gap-1"
            role="group"
            aria-label={t('channelFilter')}
          >
            {(
              [
                { value: 'all' as const, label: t('channelAll'), icon: null },
                {
                  value: 'whatsapp' as const,
                  label: t('channelOfficial'),
                  icon: MessageSquare,
                },
                {
                  value: 'uazapi' as const,
                  label: t('channelUazapi'),
                  icon: Smartphone,
                },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                onClick={() => selectChannel(value)}
                className={cn(
                  'inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-sm transition-colors border',
                  channelFilter === value
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted'
                )}
              >
                {Icon && <Icon className="size-4" />}
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Active tag/channel-filter chips */}
        {(selectedTagIds.length > 0 || channelFilter !== 'all') && (
          <div className="flex flex-wrap items-center gap-1.5">
            {channelFilter !== 'all' && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {channelFilter === 'whatsapp'
                  ? t('channelOfficial')
                  : t('channelUazapi')}
                <button
                  onClick={() => selectChannel('all')}
                  aria-label={t('clearAll')}
                  className="hover:opacity-70"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}
            {selectedTagIds.map((id) => {
              const tag = tagsMap[id];
              if (!tag) return null;
              return (
                <span
                  key={id}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: tag.color + '20',
                    color: tag.color,
                  }}
                >
                  {tag.name}
                  <button
                    onClick={() => toggleTagFilter(id)}
                    aria-label={`Remover filtro ${tag.name}`}
                    className="hover:opacity-70"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              );
            })}
            <button
              onClick={() => {
                clearTagFilters();
                setChannelFilter('all');
              }}
              className="text-xs text-muted-foreground hover:text-foreground px-1"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Bulk action bar. Fixa no topo: com centenas de linhas selecionadas, a
          ação precisa continuar ao alcance depois de rolar a lista. */}
      {selected.size > 0 && (
        <div className="sticky -top-4 sm:-top-6 z-20 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-2 shadow-sm">
          {bulkProgress && bulkProgress.kind !== 'delete' ? (
            <div className="min-w-48 flex-1" role="status" aria-live="polite">
              <p className="truncate text-sm text-foreground">
                {t(bulkProgress.kind === 'add' ? 'bulkProgressAdd' : 'bulkProgressRemove', {
                  tag: bulkProgress.tagName,
                  done: bulkProgress.done,
                  total: bulkProgress.total,
                })}
              </p>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={bulkProgress.total}
                aria-valuenow={bulkProgress.done}
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{ width: `${(bulkProgress.done / bulkProgress.total) * 100}%` }}
                />
              </div>
            </div>
          ) : (
            <p className="text-sm text-foreground">
              {t('selectedCount', { count: selected.size })}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('clearSelection')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={bulkBusy}
                render={
                  <Button variant="outline" size="sm" className="border-border text-muted-foreground hover:bg-muted" />
                }
              >
                {bulkProgress && bulkProgress.kind !== 'delete' ? (
                  <Loader2 className="size-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Tag className="size-3.5 mr-1.5" />
                )}
                {t('tags')}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 bg-popover border-border">
                {(['add', 'remove'] as const).map((action, groupIndex) => (
                  <DropdownMenuGroup key={action}>
                    {groupIndex > 0 && <DropdownMenuSeparator className="bg-border" />}
                    <DropdownMenuLabel className="flex items-center gap-2 px-3 py-2 text-sm text-popover-foreground">
                      {action === 'add' ? (
                        <Tags className="size-4 text-muted-foreground" />
                      ) : (
                        <Tag className="size-4 text-muted-foreground" />
                      )}
                      {t(action === 'add' ? 'addTag' : 'removeTag')}
                    </DropdownMenuLabel>
                    {allTags.map((tag) => (
                      <DropdownMenuItem
                        key={tag.id}
                        onClick={() => handleBulkTag(tag, action)}
                        className="flex items-center gap-2 px-3 py-2 text-popover-foreground focus:bg-muted focus:text-foreground"
                      >
                        <span className="size-2.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                        <span className="text-sm truncate">{tag.name}</span>
                      </DropdownMenuItem>
                    ))}
                    {allTags.length === 0 && (
                      <DropdownMenuItem className="text-muted-foreground px-3 py-2 text-sm" disabled>
                        {t('noTagsYet')}
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuGroup>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <GatedButton
              variant="destructive"
              size="sm"
              canAct={canEdit}
              gateReason="excluir contatos"
              disabled={bulkBusy}
              onClick={() => setBulkDeleteOpen(true)}
            >
              <Trash2 className="size-4" />
              {t('deleteSelected')}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        {/* table-fixed: as larguras não dependem das linhas montadas, senão as
            colunas pulariam a cada rolagem. */}
        <Table className="table-fixed lg:min-w-[60rem]" aria-rowcount={rows.length + 1}>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allOnPageSelected}
                  indeterminate={!allOnPageSelected && someOnPageSelected}
                  onCheckedChange={toggleSelectAll}
                  disabled={rows.length === 0 || loading || bulkBusy}
                  aria-label="Selecionar todos os contatos desta página"
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t('tableColumns.name')}</TableHead>
              <TableHead className="w-32 text-muted-foreground">{t('tableColumns.phone')}</TableHead>
              <TableHead className="w-[18%] text-muted-foreground hidden md:table-cell">{t('tableColumns.email')}</TableHead>
              <TableHead className="w-[10%] text-muted-foreground hidden lg:table-cell">{t('tableColumns.company')}</TableHead>
              <TableHead className="w-[20%] text-muted-foreground hidden md:table-cell">{t('tableColumns.tags')}</TableHead>
              <TableHead className="w-32 text-muted-foreground hidden lg:table-cell">{t('tableColumns.createdAt')}</TableHead>
              <TableHead className="text-muted-foreground w-12" />
            </TableRow>
          </TableHeader>
          <TableBody
            ref={anchorRef}
            aria-busy={loading}
            className={cn(
              'transition-opacity',
              loading && rows.length > 0 && 'pointer-events-none opacity-60',
              bulkBusy && 'pointer-events-none'
            )}
          >
            {rows.length === 0 && loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={COLUMN_COUNT} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t('loading')}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={COLUMN_COUNT} className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {hasActiveFilters
                        ? t('noContactsMatch')
                        : t('noContactsYet')}
                    </p>
                    {!hasActiveFilters && (
                      <GatedButton
                        canAct={canEdit}
                        gateReason="adicionar ou importar contatos"
                        variant="outline"
                        size="sm"
                        onClick={openAddForm}
                        className="mt-2 border-border text-muted-foreground hover:bg-muted"
                      >
                        <Plus className="size-3.5" />
                        {t('addFirstContact')}
                      </GatedButton>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              <>
                {/* Sem colSpan: em tela pequena há colunas ocultas, e um colSpan
                    criaria colunas vazias que tirariam largura do nome. */}
                {paddingTop > 0 && (
                  <tr aria-hidden="true" style={{ height: paddingTop }}>
                    <td />
                  </tr>
                )}
                {rows.slice(windowStart, windowEnd).map((contact, offset) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    index={windowStart + offset}
                    isSelected={selected.has(contact.id)}
                    tagsPending={tagsPending}
                    onRowClick={handleRowClick}
                    onToggleCheckbox={handleCheckboxToggle}
                    onOpenDetail={openDetail}
                    onOpenEdit={openEditForm}
                    onConfirmDelete={confirmDelete}
                    t={t}
                  />
                ))}
                {paddingBottom > 0 && (
                  <tr aria-hidden="true" style={{ height: paddingBottom }}>
                    <td />
                  </tr>
                )}
              </>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalCount > PAGE_SIZE_OPTIONS[0] && (
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-xs text-muted-foreground">
            {t('showingPagination', {
              start: page * pageSize + 1,
              end: Math.min((page + 1) * pageSize, totalCount),
              total: totalCount
            })}
          </p>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <label htmlFor="page-size" className="text-xs text-muted-foreground">
                {t('perPage')}
              </label>
              <select
                id="page-size"
                value={pageSize}
                onChange={(e) => {
                  const newSize = Number(e.target.value);
                  setPageSize(newSize);
                  setPage(0);
                }}
                className="bg-background border-border text-foreground text-xs rounded-md px-2 py-1 w-[110px]"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-sm"
                disabled={!hasPrev}
                onClick={() => setPage((p) => p - 1)}
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronLeft className="size-4" />
              </Button>
              <span className="text-xs text-muted-foreground px-2">
                {t('pageCount', { page: page + 1, total: totalPages })}
              </span>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={!hasNext}
                onClick={() => setPage((p) => p + 1)}
                className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Contact Form Dialog */}
      <ContactForm
        open={formOpen}
        onOpenChange={setFormOpen}
        contact={editContact}
        contactTags={editContactTags}
        onSaved={() => {
          refreshContacts();
          fetchTags();
        }}
        onViewExisting={(id) => {
          setFormOpen(false);
          openDetail(id);
        }}
      />

      {/* Contact Detail Sheet */}
      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={refreshContacts}
      />

      {/* Import Modal */}
      <ImportModal
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={refreshContacts}
      />

      {/* Bulk Add Modal */}
      <BulkAddContactsModal
        open={bulkAddOpen}
        onOpenChange={setBulkAddOpen}
        onImported={refreshContacts}
      />

      {/* Custom Fields Manager (admin+) */}
      {canEditSettings && (
        <CustomFieldsManager
          open={customFieldsOpen}
          onOpenChange={setCustomFieldsOpen}
        />
      )}

      {/* Delete Confirmation */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteContactTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteContactDesc', { name: deleteTarget?.name || deleteTarget?.phone || '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeleteConfirmOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Delete Confirmation */}
      <Dialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => {
          if (!bulkBusy) setBulkDeleteOpen(open);
        }}
      >
        <DialogContent className="bg-popover border-border text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteBulkTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {bulkProgress?.kind === 'delete'
                ? t('bulkProgressDelete', { done: bulkProgress.done, total: bulkProgress.total })
                : t('deleteBulkDesc', { count: selected.size })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              disabled={bulkBusy}
              onClick={() => setBulkDeleteOpen(false)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('deleteBtn')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
