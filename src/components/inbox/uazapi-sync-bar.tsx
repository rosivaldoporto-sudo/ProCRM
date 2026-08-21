'use client';

import { useState, useCallback, useEffect } from 'react';
import { RefreshCw, Smartphone, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface SyncJobStatus {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  totalChats: number;
  syncedChats: number;
  importedMessages: number;
  currentChat: string | null;
  errorMessage: string | null;
  progress: number;
}

export function UazapiSyncBar() {
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<SyncJobStatus | null>(null);
  const [polling, setPolling] = useState(false);

  const pollStatus = useCallback(async () => {
    if (!jobId) return;
    try {
      const res = await fetch(`/api/uazapi/sync/status?jobId=${jobId}`);
      const data = await res.json();
      if (!res.ok) {
        console.error('Poll error:', data.error);
        return;
      }
      setJobStatus(data);
      if (data.status === 'running' || data.status === 'pending') {
        setTimeout(pollStatus, 2000);
      } else {
        setPolling(false);
        if (data.status === 'completed') {
          const synced = data.syncedChats ?? 0;
          const imported = data.importedMessages ?? 0;
          if (synced > 0 || imported > 0) {
            toast.success(
              imported > 0
                ? `${synced} conversations synced, ${imported} messages imported.`
                : `${synced} conversations synced from Uazapi.`
            );
            setSynced(true);
            setTimeout(() => setSynced(false), 3000);
          } else {
            toast.info('No new conversations to sync.');
          }
        } else if (data.status === 'failed') {
          toast.error(data.errorMessage || 'Sync failed');
        }
        setJobId(null);
        setJobStatus(null);
      }
    } catch {
      console.error('Poll failed');
    }
  }, [jobId]);

  useEffect(() => {
    if (polling && jobId) {
      pollStatus();
    }
  }, [polling, jobId, pollStatus]);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSynced(false);
    try {
      const res = await fetch('/api/uazapi/sync/background', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to start sync');
        return;
      }
      if (data.jobId) {
        setJobId(data.jobId);
        setPolling(true);
        toast.info(`Sync started for ${data.totalChats} conversations in background.`);
      } else {
        toast.info(data.message || 'No conversations to sync.');
      }
    } catch {
      toast.error('Failed to start background sync');
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await fetch(`/api/uazapi/sync/background?jobId=${jobId}`, { method: 'DELETE' });
      setPolling(false);
      setJobId(null);
      setJobStatus(null);
      toast.info('Sync cancelled');
    } catch {
      toast.error('Failed to cancel sync');
    }
  }, [jobId]);

  if (jobStatus && polling) {
    return (
      <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border bg-card px-4 py-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Smartphone className="h-3 w-3 text-violet-400" />
          <span>Uazapi</span>
          <Loader2 className="h-3 w-3 animate-spin text-violet-400" />
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:block w-48">
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-violet-400 transition-all duration-300"
                style={{ width: `${jobStatus.progress}%` }}
              />
            </div>
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {jobStatus.syncedChats}/{jobStatus.totalChats} ({jobStatus.progress}%)
          </span>
          {jobStatus.currentChat && (
            <span className="hidden md:inline text-xs text-muted-foreground font-mono">
              {jobStatus.currentChat}
            </span>
          )}
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <XCircle className="h-3 w-3" />
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-b border-border bg-card px-4 py-1.5">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Smartphone className="h-3 w-3 text-violet-400" />
        <span>Uazapi</span>
        {synced ? (
          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
        ) : null}
      </div>
      <button
        type="button"
        onClick={handleSync}
        disabled={syncing || polling}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
          syncing || polling
            ? "text-muted-foreground cursor-not-allowed"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        )}
      >
        <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
        {syncing ? 'Starting...' : polling ? 'Syncing...' : 'Sync'}
      </button>
    </div>
  );
}