'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';

interface ErrorLogRow {
  id: string;
  request_id: string;
  occurred_at: string;
  source: string;
  route: string | null;
  method: string | null;
  error_name: string | null;
  message: string;
}

export function ErrorLogsPanel() {
  const [logs, setLogs] = useState<ErrorLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/account/error-logs?limit=100', {
        cache: 'no-store',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Falha ao carregar');
      setLogs(Array.isArray(payload.logs) ? payload.logs : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao carregar logs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="Logs de erros"
        description="Erros sanitizados da conta, com identificador para correlacionar com os logs da Hostinger."
        action={
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className={loading ? 'size-4 animate-spin' : 'size-4'} />
            Atualizar
          </Button>
        }
      />

      {error ? (
        <Card>
          <CardContent className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" /> {error}
          </CardContent>
        </Card>
      ) : null}

      {!error && !loading && logs.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum erro registrado para esta conta.
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {logs.map((log) => (
          <Card key={log.id}>
            <CardContent className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {log.request_id}
                </span>
                <time className="text-xs text-muted-foreground">
                  {new Date(log.occurred_at).toLocaleString()}
                </time>
              </div>
              <p className="text-sm font-medium text-foreground">
                {log.message}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {[log.method, log.route, log.source].filter(Boolean).join(' · ')}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

