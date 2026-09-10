'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastRecipient, RecipientStatus } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  Loader2,
  Users,
  Send,
  CheckCheck,
  Eye,
  AlertCircle,
  MessageCircle,
  Clock,
  Play,
  Filter,
  Download,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Rows3,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getBroadcastStatus,
  getRecipientStatus,
} from '@/lib/broadcast-status';
import { sendPendingRecipients } from '@/lib/broadcast-send';
import { useTranslations } from 'next-intl';

const PAGE_SIZE_OPTIONS = [100, 500, 1000, 2000, 3000] as const;

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-foreground">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <h3 className="mb-4 text-sm font-medium text-foreground">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfSent =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted-foreground">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-muted">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-foreground">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-muted-foreground/80">
                    ({pctOfSent}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RECIPIENT_STATUSES: readonly RecipientStatus[] = [
  'pending',
  'sent',
  'delivered',
  'read',
  'replied',
  'failed',
];

function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function BroadcastDetailPage() {
  const params = useParams();
  const router = useRouter();
  const t = useTranslations('Broadcasts.detail');
  const tStatus = useTranslations('Broadcasts.status');
  const broadcastId = params.id as string;

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [recipients, setRecipients] = useState<BroadcastRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingRecipients, setLoadingRecipients] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | 'all'>(
    'all',
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [resumeProgress, setResumeProgress] = useState(0);

  // Pagination state
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [totalCount, setTotalCount] = useState(0);

  const totalPages = Math.ceil(totalCount / pageSize);

  const fetchBroadcast = useCallback(async () => {
    try {
      const supabase = createClient();
      const { data: bc, error: bcError } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcError) throw bcError;
      setBroadcast(bc);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notFound'));
    } finally {
      setLoading(false);
    }
  }, [broadcastId, t]);

  const fetchRecipients = useCallback(async () => {
    try {
      setLoadingRecipients(true);
      const supabase = createClient();

      const from = page * pageSize;
      const to = from + pageSize - 1;

      let query = supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)', { count: 'exact' })
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false });

      if (statusFilter !== 'all') {
        query = query.eq('status', statusFilter);
      }

      query = query.range(from, to);

      const { data: recs, error: recsError, count } = await query;

      if (recsError) throw recsError;
      setRecipients(recs ?? []);
      setTotalCount(count ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('notFound'));
    } finally {
      setLoadingRecipients(false);
    }
  }, [broadcastId, page, pageSize, statusFilter, t]);

  useEffect(() => {
    fetchBroadcast();
  }, [fetchBroadcast]);

  useEffect(() => {
    fetchRecipients();
  }, [fetchRecipients]);

  // Reset to page 1 when filter changes
  const handleFilterChange = useCallback((newFilter: RecipientStatus | 'all') => {
    setStatusFilter(newFilter);
    setPage(0);
  }, []);

  // Reset to page 1 when page size changes
  const handlePageSizeChange = useCallback((newSize: number) => {
    setPageSize(newSize);
    setPage(0);
  }, []);

  const handleResume = useCallback(async () => {
    if (resuming) return;
    setResuming(true);
    setResumeProgress(0);
    try {
      const result = await sendPendingRecipients(
        createClient(),
        broadcastId,
        setResumeProgress,
      );
      if (result.sent === 0 && result.failed === 0) {
        toast.info(t('toastResumeNothing'));
      } else {
        toast.success(
          t('toastResumeDone', {
            sent: result.sent,
            failed: result.failed,
          }),
        );
      }
      await fetchBroadcast();
      await fetchRecipients();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('toastResumeFailed'),
      );
      await fetchBroadcast();
      await fetchRecipients();
    } finally {
      setResuming(false);
      setResumeProgress(0);
    }
  }, [resuming, broadcastId, fetchBroadcast, fetchRecipients, t]);

  // Export all recipients (fetches all pages)
  const handleExport = useCallback(async () => {
    if (!broadcast) return;
    const supabase = createClient();

    let allRecipients: BroadcastRecipient[] = [];
    let from = 0;
    let hasMore = true;

    while (hasMore) {
      const { data, error } = await supabase
        .from('broadcast_recipients')
        .select('*, contact:contacts(*)')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false })
        .range(from, from + pageSize - 1);

      if (error) break;
      if (data && data.length > 0) {
        allRecipients = [...allRecipients, ...data];
        from += pageSize;
        hasMore = data.length === pageSize;
      } else {
        hasMore = false;
      }
    }

    const header = [
      t('table.contact'),
      t('table.phone'),
      t('table.status'),
      t('table.sent'),
      t('table.delivered'),
      t('table.read'),
      t('table.error'),
    ];
    const rows = allRecipients.map((r) => [
      r.contact?.name ?? '',
      r.contact?.phone ?? '',
      r.status,
      r.sent_at ?? '',
      r.delivered_at ?? '',
      r.read_at ?? '',
      r.error_message ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = broadcast.name.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(`broadcast-${safeName}-${broadcastId.slice(0, 8)}.csv`, csv);
  }, [broadcast, broadcastId, pageSize, t]);

  async function handleDelete() {
    setDeleting(true);
    const supabase = createClient();
    const { error: delErr } = await supabase
      .from('broadcasts')
      .delete()
      .eq('id', broadcastId);
    setDeleting(false);
    if (delErr) {
      toast.error(t('toastFailedDelete', { error: delErr.message }));
      return;
    }
    toast.success(t('toastDeleted'));
    router.push('/broadcasts');
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !broadcast) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? t('notFound')}</p>
        <Button variant="outline" onClick={() => router.push('/broadcasts')}>
          {t('backToBroadcasts')}
        </Button>
      </div>
    );
  }

  const status = getBroadcastStatus(broadcast.status);

  const pendingCount = Math.max(
    0,
    broadcast.total_recipients - broadcast.sent_count - broadcast.failed_count,
  );

  const funnelSteps: FunnelStep[] = [
    { label: t('stats.sent'), value: broadcast.sent_count, color: 'bg-primary' },
    { label: t('stats.delivered'), value: broadcast.delivered_count, color: 'bg-teal-500' },
    { label: t('stats.read'), value: broadcast.read_count, color: 'bg-blue-500' },
    { label: t('stats.replied'), value: broadcast.replied_count, color: 'bg-indigo-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/broadcasts')}
            className="border-border"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-foreground">{broadcast.name}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {tStatus(status.label)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
              <span>{t('template', { name: broadcast.template_name })}</span>
              <span>-</span>
              <span>
                {t('createdAt', { date: new Date(broadcast.created_at).toLocaleDateString() })}
              </span>
            </div>
          </div>
        </div>

        {pendingCount > 0 && (
          <Button
            size="sm"
            onClick={handleResume}
            disabled={resuming}
            className="h-8 gap-1.5"
            title={t('resumeHover')}
          >
            {resuming ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {resuming
              ? t('resuming', { pct: resumeProgress })
              : t('resume', { count: pendingCount })}
          </Button>
        )}
        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">{t('deletePrompt')}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="h-7 border-border bg-transparent text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? t('deleting') : t('confirm')}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={broadcast.status === 'sending' || resuming}
            onClick={() => setConfirmDelete(true)}
            title={
              broadcast.status === 'sending' || resuming
                ? t('cannotDeleteSending')
                : t('deleteHover')
            }
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t('delete')}
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-7">
        <StatCard
          label={t('stats.totalRecipients')}
          value={broadcast.total_recipients}
          total={broadcast.total_recipients}
          icon={<Users className="h-4 w-4" />}
          color="bg-muted text-muted-foreground"
        />
        <StatCard
          label={t('stats.sent')}
          value={broadcast.sent_count}
          total={broadcast.total_recipients}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label={t('stats.delivered')}
          value={broadcast.delivered_count}
          total={broadcast.total_recipients}
          icon={<CheckCheck className="h-4 w-4" />}
          color="bg-teal-500/10 text-teal-400"
        />
        <StatCard
          label={t('stats.read')}
          value={broadcast.read_count}
          total={broadcast.total_recipients}
          icon={<Eye className="h-4 w-4" />}
          color="bg-blue-500/10 text-blue-400"
        />
        <StatCard
          label={t('stats.replied')}
          value={broadcast.replied_count}
          total={broadcast.total_recipients}
          icon={<MessageCircle className="h-4 w-4" />}
          color="bg-indigo-500/10 text-indigo-400"
        />
        <StatCard
          label={t('stats.failed')}
          value={broadcast.failed_count}
          total={broadcast.total_recipients}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
        <StatCard
          label={t('stats.pending')}
          value={pendingCount}
          total={broadcast.total_recipients}
          icon={<Clock className="h-4 w-4" />}
          color="bg-amber-500/10 text-amber-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <h2 className="text-sm font-medium text-foreground">
            {statusFilter !== 'all'
              ? t('recipientsHeader', { filtered: totalCount, total: broadcast.total_recipients })
              : t('recipientsHeaderAll', { total: broadcast.total_recipients })}
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? t('allStatuses')
                  : tStatus(getRecipientStatus(statusFilter).label)}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                <DropdownMenuItem
                  onClick={() => handleFilterChange('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-popover-foreground'
                  }
                >
                  {t('allStatuses')}
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => handleFilterChange(s)}
                    className={
                      statusFilter === s
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {tStatus(getRecipientStatus(s).label)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border text-muted-foreground hover:bg-muted"
                  />
                }
              >
                <Rows3 className="h-3.5 w-3.5" />
                {pageSize}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-border bg-popover">
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <DropdownMenuItem
                    key={size}
                    onClick={() => handlePageSizeChange(size)}
                    className={
                      pageSize === size
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    }
                  >
                    {size}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={totalCount === 0}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              <Download className="h-3.5 w-3.5" />
              {t('exportCsv')}
            </Button>
          </div>
        </div>

        {loadingRecipients ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : recipients.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              {totalCount === 0
                ? t('noRecipients')
                : t('noRecipientsFilter')}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">{t('table.contact')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.phone')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.status')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.sent')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.delivered')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.read')}</TableHead>
                    <TableHead className="text-muted-foreground">{t('table.error')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recipients.map((recipient) => {
                    const rStatus = getRecipientStatus(recipient.status);
                    return (
                      <TableRow key={recipient.id} className="border-border">
                        <TableCell className="font-medium text-foreground">
                          {recipient.contact?.name ?? 'Unknown'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.contact?.phone ?? '-'}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                          >
                            {tStatus(rStatus.label)}
                          </span>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.sent_at
                            ? new Date(recipient.sent_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.delivered_at
                            ? new Date(recipient.delivered_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {recipient.read_at
                            ? new Date(recipient.read_at).toLocaleString()
                            : '-'}
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-red-400">
                          {recipient.error_message ?? '-'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination Controls */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  {t('pageInfo', {
                    from: page * pageSize + 1,
                    to: Math.min((page + 1) * pageSize, totalCount),
                    total: totalCount,
                  })}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="h-8 border-border"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    {t('previous')}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('pageOf', { current: page + 1, total: totalPages })}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="h-8 border-border"
                  >
                    {t('next')}
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
