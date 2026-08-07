'use client';

import { useState, useCallback } from 'react';
import { RefreshCw, Smartphone, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function UazapiSyncBar() {
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState(false);

  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    setSynced(false);
    try {
      const res = await fetch('/api/uazapi/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Sync failed');
        return;
      }
      const synced = data.synced ?? 0;
      const imported = data.messagesImported ?? 0;
      if (synced > 0 || imported > 0) {
        toast.success(
          imported > 0
            ? `${synced} conversations synced, ${imported} messages imported.`
            : `${synced} conversations synced from Uazapi.`
        );
        setSynced(true);
        setTimeout(() => setSynced(false), 3000);
      } else {
        toast.info(data.message || 'No new conversations to sync.');
      }
    } catch {
      toast.error('Failed to sync Uazapi conversations');
    } finally {
      setSyncing(false);
    }
  }, [syncing]);

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
        disabled={syncing}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors",
          syncing
            ? "text-muted-foreground cursor-not-allowed"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        )}
      >
        <RefreshCw className={cn("h-3 w-3", syncing && "animate-spin")} />
        {syncing ? 'Syncing...' : 'Sync'}
      </button>
    </div>
  );
}
