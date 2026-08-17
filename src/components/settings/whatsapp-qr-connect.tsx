'use client';

// ============================================================
// WhatsAppQrConnect — Settings → WhatsApp QR Code
//
// Connection-only companion to the Uazapi credentials screen
// (Settings → WhatsApp (Uazapi)). This panel is a single-purpose
// surface: click "Conectar WhatsApp", scan the QR code, done.
//
// Flow:
//   1. POST /api/uazapi/instance/connect — the server creates the
//      instance via /instance/init when needed (admin token), calls
//      /instance/connect, normalizes the base64 QR and configures
//      the webhook (best-effort).
//   2. While the dialog is open we poll /api/uazapi/instance/status
//      every few seconds to detect the phone scanning the code and
//      auto-refresh the QR when it expires (~60s on UAZAPI).
//   3. On success the dialog flips to a "Conectado" state with the
//      WhatsApp profile name and closes by itself.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  CheckCircle2,
  Loader2,
  Plug,
  QrCode,
  RefreshCw,
  Smartphone,
  Unplug,
  XCircle,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from './settings-panel-head';

const QR_TTL_MS = 55_000; // UAZAPI QR codes expire after ~60s
const POLL_INTERVAL_MS = 4_000;

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'qrcode' | 'unknown';
type QrMode = 'connecting' | 'qrcode' | 'connected';

export function WhatsAppQrConnect() {
  const supabase = createClient();
  const { accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [statusMessage, setStatusMessage] = useState('');
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);

  // QR connect dialog state
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrMode, setQrMode] = useState<QrMode>('connecting');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [qrRefreshing, setQrRefreshing] = useState(false);
  const qrSetAtRef = useRef<number>(0);
  const pollBusyRef = useRef(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  // Check that credentials exist and read the current connection state.
  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!accountId) {
      setConfigured(false);
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('uazapi_config')
          .select('status, server_url, api_token, qr_code')
          .eq('account_id', accountId)
          .maybeSingle();

        setConfigured(!!data && !!data.server_url);

        if (data) {
          const res = await fetch('/api/uazapi/instance/status', { method: 'GET' });
          const payload = await res.json();
          if (payload.connected) {
            setConnectionStatus('connected');
            setProfileName(payload.profile_name || null);
          } else if (payload.status === 'connecting') {
            setConnectionStatus('connecting');
          } else if (payload.status === 'qrcode') {
            setConnectionStatus('qrcode');
            setQrCode(payload.qr_code || data.qr_code || null);
          } else {
            setConnectionStatus('disconnected');
            setStatusMessage(payload.message || '');
          }
        } else {
          setConnectionStatus('disconnected');
        }
      } catch {
        setConnectionStatus('disconnected');
      } finally {
        setLoading(false);
      }
    })();
  }, [authLoading, profileLoading, accountId, supabase]);

  /**
   * POST /instance/connect (via our route) and render the returned QR
   * code (or pairing code) in the dialog.
   */
  const requestQr = useCallback(async (): Promise<boolean> => {
    setConnecting(true);
    setQrRefreshing(true);
    try {
      const res = await fetch('/api/uazapi/instance/connect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Falha ao conectar');
        setQrMode('connecting');
        return false;
      }

      if (data.status === 'connected') {
        setQrMode('connected');
        setProfileName(data.profile_name || null);
        setConnectionStatus('connected');
        setQrCode(null);
        setPairingCode(null);
        toast.success('WhatsApp já conectado!');
        return true;
      }

      setQrMode('qrcode');
      if (data.qr_code) {
        setQrCode(data.qr_code);
        qrSetAtRef.current = Date.now();
        setConnectionStatus('qrcode');
        setStatusMessage('Escaneie o QR Code com o WhatsApp para conectar.');
      }
      if (data.pairing_code) {
        setPairingCode(data.pairing_code);
      }
      return true;
    } catch (err) {
      console.error('Connect error:', err);
      toast.error('Falha ao conectar instância');
      return false;
    } finally {
      setConnecting(false);
      setQrRefreshing(false);
    }
  }, []);

  /**
   * Poll /instance/status while the QR dialog is open: detects when
   * the phone scanned the code (→ connected), tracks the 'connecting'
   * state, and auto-refreshes the QR when it expires (~60s).
   */
  useEffect(() => {
    if (!qrDialogOpen || qrMode === 'connected') return;
    let stopped = false;

    const poll = async () => {
      if (pollBusyRef.current) return;
      pollBusyRef.current = true;
      try {
        // QR expired — request a fresh one
        if (
          qrMode === 'qrcode' &&
          qrCode &&
          qrSetAtRef.current > 0 &&
          Date.now() - qrSetAtRef.current > QR_TTL_MS
        ) {
          qrSetAtRef.current = 0; // avoid double-refresh
          await requestQr();
          return;
        }

        const res = await fetch('/api/uazapi/instance/status', { method: 'GET' });
        const data = await res.json();
        if (stopped) return;

        if (data.connected) {
          setQrMode('connected');
          setProfileName(data.profile_name || null);
          setConnectionStatus('connected');
          setQrCode(null);
          setTimeout(() => {
            if (!stopped) {
              setQrDialogOpen(false);
              toast.success('WhatsApp conectado!');
            }
          }, 1500);
          return;
        }

        if (data.status === 'connecting') {
          setQrMode('connecting');
        } else if (data.status === 'qrcode') {
          setQrMode('qrcode');
          if (data.qr_code && data.qr_code !== qrCode) {
            setQrCode(data.qr_code);
            qrSetAtRef.current = Date.now();
            setConnectionStatus('qrcode');
          }
          if (data.pairing_code && data.pairing_code !== pairingCode) {
            setPairingCode(data.pairing_code);
          }
        } else if (data.status === 'disconnected') {
          setQrMode('connecting');
        }
      } catch {
        // transient error — keep polling
      } finally {
        pollBusyRef.current = false;
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [qrDialogOpen, qrMode, qrCode, pairingCode, requestQr]);

  async function handleConnect() {
    setQrCode(null);
    setPairingCode(null);
    setProfileName(null);
    setQrMode('connecting');
    setQrDialogOpen(true);
    await requestQr();
  }

  async function handleDisconnect() {
    try {
      setDisconnecting(true);
      const res = await fetch('/api/uazapi/instance/disconnect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Falha ao desconectar');
        return;
      }

      setConnectionStatus('disconnected');
      setQrCode(null);
      setQrDialogOpen(false);
      setProfileName(null);
      setPairingCode(null);
      toast.success('Instância desconectada.');
    } catch (err) {
      console.error('Disconnect error:', err);
      toast.error('Falha ao desconectar instância');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="WhatsApp QR Code"
          description="Conecte seu WhatsApp automaticamente escaneando um QR Code."
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="WhatsApp QR Code"
        description="Conecte seu WhatsApp não oficial escaneando um QR Code — sem digitar tokens."
      />

      {!configured ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base flex items-center gap-2">
              <QrCode className="size-5" />
              Conexão ainda não configurada
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Antes de conectar pelo QR Code, informe as credenciais do servidor Uazapi na tela{' '}
              <a
                href="/settings?tab=uazapi"
                className="text-primary hover:text-primary/80 underline underline-offset-2"
              >
                WhatsApp (Uazapi)
              </a>
              .
            </CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href="/settings?tab=uazapi"
              className={buttonVariants({
                variant: 'outline',
                className: 'border-border text-muted-foreground hover:text-foreground hover:bg-muted',
              })}
            >
              Ir para WhatsApp (Uazapi)
            </a>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Connection Status */}
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {connectionStatus === 'connected' ? (
                <CheckCircle2 className="size-4 text-emerald-500" />
              ) : connectionStatus === 'connecting' ? (
                <Loader2 className="size-4 animate-spin text-amber-500" />
              ) : connectionStatus === 'qrcode' ? (
                <QrCode className="size-4 text-amber-500" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {connectionStatus === 'connected'
                  ? 'Conectado'
                  : connectionStatus === 'connecting'
                    ? 'Conectando...'
                    : connectionStatus === 'qrcode'
                      ? 'Aguardando QR Code'
                      : 'Desconectado'}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {connectionStatus === 'connected'
                ? profileName
                  ? `WhatsApp conectado como ${profileName} — pronto para enviar/receber mensagens.`
                  : 'WhatsApp conectado — pronto para enviar/receber mensagens.'
                : connectionStatus === 'connecting'
                  ? 'Estabelecendo conexão com o WhatsApp...'
                  : connectionStatus === 'qrcode'
                    ? 'Escaneie o QR Code com o WhatsApp para conectar.'
                    : statusMessage || 'Clique em Conectar WhatsApp e escaneie o QR Code.'}
            </AlertDescription>
          </Alert>

          {/* QR Code Display (persisted while awaiting scan) */}
          {qrCode && connectionStatus === 'qrcode' && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground text-base flex items-center gap-2">
                  <QrCode className="size-5" />
                  QR Code
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  Escaneie este QR Code com o WhatsApp no seu celular: Abra o WhatsApp {'>'} Menu {'>'} Aparelhos conectados {'>'} Conectar um aparelho.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex justify-center">
                <img
                  src={qrCode}
                  alt="WhatsApp QR Code"
                  className="size-64 border border-border rounded-lg"
                />
              </CardContent>
            </Card>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleConnect}
              disabled={connecting}
              className="bg-emerald-700 hover:bg-emerald-600 text-white"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Conectando...
                </>
              ) : (
                <>
                  <Plug className="size-4" />
                  Conectar WhatsApp
                </>
              )}
            </Button>
            {connectionStatus !== 'disconnected' && (
              <Button
                variant="outline"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Desconectando...
                  </>
                ) : (
                  <>
                    <Unplug className="size-4" />
                    Desconectar
                  </>
                )}
              </Button>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            <Smartphone className="inline size-3.5 mr-1" />
            O QR Code expira em ~1 minuto e é renovado automaticamente enquanto a janela de conexão estiver aberta. As credenciais do servidor são gerenciadas na tela{' '}
            <a
              href="/settings?tab=uazapi"
              className="text-primary hover:text-primary/80 underline underline-offset-2"
            >
              WhatsApp (Uazapi)
            </a>
            .
          </p>
        </div>
      )}

      {/* QR Connect Dialog */}
      <Dialog
        open={qrDialogOpen}
        onOpenChange={(open) => {
          setQrDialogOpen(open);
          if (!open) setQrMode('connecting');
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {qrMode === 'connected' ? (
                <CheckCircle2 className="size-5 text-emerald-500" />
              ) : qrMode === 'qrcode' ? (
                <QrCode className="size-5" />
              ) : (
                <Loader2 className="size-5 animate-spin" />
              )}
              {qrMode === 'connected'
                ? 'Conectado!'
                : qrMode === 'qrcode'
                  ? 'Escaneie o QR Code'
                  : 'Conectando ao WhatsApp...'}
            </DialogTitle>
            <DialogDescription>
              {qrMode === 'connected'
                ? profileName
                  ? `Seu WhatsApp está conectado como ${profileName}.`
                  : 'Seu WhatsApp está conectado e pronto para uso.'
                : qrMode === 'qrcode'
                  ? 'Abra o WhatsApp no celular: Menu > Aparelhos conectados > Conectar um aparelho.'
                  : 'Gerando o QR Code...'}
            </DialogDescription>
          </DialogHeader>

          {qrMode === 'qrcode' && qrCode && (
            <div className="flex flex-col items-center gap-3 py-2">
              <img
                src={qrCode}
                alt="WhatsApp QR Code"
                className="size-64 border border-border rounded-lg"
              />
              {pairingCode && (
                <div className="text-center space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Ou use o código de 6 dígitos (Vincular com número de telefone):
                  </p>
                  <p className="font-mono text-2xl font-semibold tracking-widest">
                    {pairingCode}
                  </p>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                O QR Code expira em ~1 minuto e é renovado automaticamente.
              </p>
            </div>
          )}

          {qrMode === 'connecting' && (
            <div className="flex flex-col items-center gap-2 py-8">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="text-sm text-muted-foreground">
                {qrRefreshing ? 'Renovando QR Code...' : 'Estabelecendo conexão...'}
              </p>
            </div>
          )}

          {qrMode === 'connected' && (
            <div className="flex flex-col items-center gap-2 py-6">
              <CheckCircle2 className="size-10 text-emerald-500" />
              <p className="text-sm text-muted-foreground">
                {profileName ? `Conectado como ${profileName}` : 'Conexão estabelecida'}
              </p>
            </div>
          )}

          <DialogFooter className="gap-2 sm:justify-between">
            {qrMode === 'qrcode' && (
              <Button
                variant="outline"
                onClick={() => {
                  qrSetAtRef.current = 0;
                  setQrRefreshing(true);
                  setQrMode('connecting');
                  void requestQr();
                }}
                disabled={qrRefreshing}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {qrRefreshing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                Gerar novo QR
              </Button>
            )}
            <Button
              variant="outline"
              onClick={() => setQrDialogOpen(false)}
              disabled={qrMode === 'connecting' && connecting}
            >
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}