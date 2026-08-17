'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  Smartphone,
  QrCode,
  RotateCcw,
  Plug,
  Unplug,
  RefreshCw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

const MASKED_TOKEN = '••••••••••••••••';
const QR_TTL_MS = 55_000; // UAZAPI QR codes expire after ~60s
const POLL_INTERVAL_MS = 4_000;

type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'qrcode' | 'unknown';
type QrMode = 'connecting' | 'qrcode' | 'connected';

export function UazapiConfig() {
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showAdminToken, setShowAdminToken] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [statusMessage, setStatusMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [adminToken, setAdminToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [pairingPhone, setPairingPhone] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [adminTokenEdited, setAdminTokenEdited] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  // QR connect dialog state
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [qrMode, setQrMode] = useState<QrMode>('connecting');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [qrRefreshing, setQrRefreshing] = useState(false);
  const qrSetAtRef = useRef<number>(0);
  const pollBusyRef = useRef(false);

  // Cada conta do CRM tem uma URL de callback exclusiva
  // (/api/uazapi/webhook/[accountId]) — o webhook resolve a
  // configuração diretamente pela conta, sem ambiguidade entre instâncias.
  const webhookUrl =
    typeof window !== 'undefined' && accountId
      ? `${window.location.origin}/api/uazapi/webhook/${accountId}`
      : '';

  const fetchConfig = useCallback(async (acctId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('uazapi_config')
        .select('*')
        .eq('account_id', acctId)
        .maybeSingle();

      if (error) {
        console.error('Failed to load uazapi config:', error);
      }

      if (data) {
        setInstanceName(data.instance_name || '');
        setServerUrl(data.server_url || '');
        setApiToken(MASKED_TOKEN);
        setAdminToken(data.admin_token ? MASKED_TOKEN : '');
        setWebhookSecret('');
        setPairingPhone(data.pairing_phone || '');
        setTokenEdited(false);
        setAdminTokenEdited(false);
        setQrCode(data.qr_code || null);
        setConnectionStatus(data.status as ConnectionStatus);
      } else {
        setInstanceName('');
        setServerUrl('');
        setApiToken('');
        setAdminToken('');
        setWebhookSecret('');
        setPairingPhone('');
        setTokenEdited(false);
        setAdminTokenEdited(false);
        setQrCode(null);
        setConnectionStatus('disconnected');
      }

      // Health check via API
      if (data) {
        try {
          const res = await fetch('/api/uazapi/instance/status', { method: 'GET' });
          const payload = await res.json();
          if (payload.connected) {
            setConnectionStatus('connected');
            setProfileName(payload.profile_name || null);
            setStatusMessage('');
          } else if (payload.status === 'connecting') {
            setConnectionStatus('connecting');
            setStatusMessage('');
          } else if (payload.status === 'qrcode') {
            setConnectionStatus('qrcode');
            setQrCode(payload.qr_code || data.qr_code);
            setStatusMessage('Escaneie o QR Code com o WhatsApp para conectar.');
          } else {
            setConnectionStatus('disconnected');
            setStatusMessage(payload.message || '');
          }
        } catch {
          setConnectionStatus('disconnected');
        }
      } else {
        setConnectionStatus('disconnected');
        setStatusMessage('');
      }
    } catch (err) {
      console.error('fetchConfig error:', err);
      toast.error('Falha ao carregar configuração do Uazapi');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

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

  async function handleSave() {
    if (!instanceName.trim()) {
      toast.error('Nome da instância é obrigatório');
      return;
    }
    if (!serverUrl.trim()) {
      toast.error('URL do servidor é obrigatória');
      return;
    }

    const payload: Record<string, unknown> = {
      instance_name: instanceName.trim(),
      server_url: serverUrl.trim().replace(/\/+$/, ''),
      webhook_secret: webhookSecret.trim() || null,
      pairing_phone: pairingPhone.trim() || null,
    };

    if (tokenEdited && apiToken !== MASKED_TOKEN && apiToken.trim()) {
      payload.api_token = apiToken.trim();
    }
    if (adminTokenEdited && adminToken !== MASKED_TOKEN && adminToken.trim()) {
      payload.admin_token = adminToken.trim();
    }

    try {
      setSaving(true);
      const res = await fetch('/api/uazapi/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao salvar configuração');
        return;
      }

      toast.success('Configuração do Uazapi salva.');
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Falha ao salvar configuração');
    } finally {
      setSaving(false);
    }
  }

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

  async function handleReset() {
    if (!confirm('Isso excluirá a configuração do Uazapi. Continuar?')) return;

    try {
      setLoading(true);
      const res = await fetch('/api/uazapi/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Falha ao resetar');
        return;
      }
      toast.success('Configuração limpa.');
      setInstanceName('');
      setServerUrl('');
      setApiToken('');
      setAdminToken('');
      setWebhookSecret('');
      setPairingPhone('');
      setTokenEdited(false);
      setAdminTokenEdited(false);
      setConnectionStatus('disconnected');
      setQrCode(null);
      setQrDialogOpen(false);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Falha ao resetar configuração');
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    try {
      setSyncing(true);
      const res = await fetch('/api/uazapi/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Sincronização falhou');
        return;
      }
      toast.success(data.message || `Sincronizadas ${data.synced} conversas.`);
      if (data.synced > 0 && accountId) await fetchConfig(accountId);
    } catch {
      toast.error('Falha ao sincronizar conversas');
    } finally {
      setSyncing(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('URL do webhook copiada');
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="Uazapi WhatsApp"
          description="Configure seu canal WhatsApp não oficial via Uazapi."
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
        title="Uazapi WhatsApp"
        description="Configure seu canal WhatsApp não oficial via Uazapi em paralelo com o canal oficial do Meta."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
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
                  ? `Instância conectada como ${profileName} e pronta para enviar/receber mensagens.`
                  : 'Instância conectada e pronta para enviar/receber mensagens.'
                : connectionStatus === 'connecting'
                  ? 'Estabelecendo conexão com o WhatsApp...'
                  : connectionStatus === 'qrcode'
                    ? 'Escaneie o QR Code com o WhatsApp para conectar.'
                    : statusMessage || 'Configure abaixo e clique em Conectar.'}
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

          {/* API Credentials */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Credenciais da API</CardTitle>
              <CardDescription className="text-muted-foreground">
                Configure as credenciais do seu servidor Uazapi.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">Nome da Instância</Label>
                <Input
                  placeholder="Ex: meu-whatsapp"
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">URL do Servidor Uazapi</Label>
                <Input
                  placeholder="Ex: https://api.uazapi.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">API Token (token da instância)</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Token da instância (opcional se usar o token admin)"
                    value={apiToken}
                    onChange={(e) => {
                      setApiToken(e.target.value);
                      setTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (apiToken === MASKED_TOKEN) {
                        setApiToken('');
                        setTokenEdited(true);
                      }
                    }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Se não preenchido, a instância é criada automaticamente com o token admin abaixo.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Token Admin (admintoken)
                  <span className="ml-1 text-muted-foreground">(opcional)</span>
                </Label>
                <div className="relative">
                  <Input
                    type={showAdminToken ? 'text' : 'password'}
                    placeholder="Token admin do servidor Uazapi"
                    value={adminToken}
                    onChange={(e) => {
                      setAdminToken(e.target.value);
                      setAdminTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (adminToken === MASKED_TOKEN) {
                        setAdminToken('');
                        setAdminTokenEdited(true);
                      }
                    }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowAdminToken(!showAdminToken)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showAdminToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Permite criar a instância automaticamente (POST /instance/init) e o webhook na conexão. Basta o token admin para conectar sem token de instância.
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Telefone para pairing code
                  <span className="ml-1 text-muted-foreground">(opcional)</span>
                </Label>
                <Input
                  placeholder="Ex: 5511999999999"
                  value={pairingPhone}
                  onChange={(e) => setPairingPhone(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Se preenchido, em vez do QR Code será exibido um código de 6 dígitos (WhatsApp {'>'} Aparelhos conectados {'>'} Vincular com número de telefone).
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Webhook Secret
                  <span className="ml-1 text-muted-foreground">(opcional)</span>
                </Label>
                <Input
                  placeholder="Token secreto para verificar webhooks"
                  value={webhookSecret}
                  onChange={(e) => setWebhookSecret(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Usado para verificar que os webhooks vêm do seu servidor Uazapi.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Webhook URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">Configuração do Webhook</CardTitle>
              <CardDescription className="text-muted-foreground">
                Esta URL é exclusiva da sua conta. Ao conectar, o sistema tenta configurá-la automaticamente no servidor Uazapi; se o servidor não suportar, configure manualmente.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">URL de Callback do Webhook</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopyWebhookUrl}
                    className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                'Salvar Configuração'
              )}
            </Button>
            <Button
              variant="outline"
              onClick={handleConnect}
              disabled={connecting || !instanceName}
              className="border-emerald-700 text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/40"
            >
              {connecting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Conectando...
                </>
              ) : (
                <>
                  <Plug className="size-4" />
                  Conectar
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
            {connectionStatus === 'connected' && (
              <Button
                variant="outline"
                onClick={handleSync}
                disabled={syncing}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
              >
                {syncing ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RotateCcw className="size-4" />
                )}
                Sincronizar Conversas
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleReset}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <RotateCcw className="size-4" />
              Resetar
            </Button>
          </div>
        </div>

        {/* Instructions Sidebar */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">Instruções</CardTitle>
              <CardDescription className="text-muted-foreground">
                Siga estes passos para configurar seu WhatsApp não oficial via Uazapi.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-muted-foreground">
              <div className="space-y-2">
                <h4 className="font-medium text-foreground">1. Tenha um servidor Uazapi</h4>
                <p>
                  Você precisa de uma instância do Uazapi rodando. Pode ser auto-hospedada ou usar o serviço cloud em{' '}
                  <a
                    href="https://uazapi.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary hover:text-primary/80"
                  >
                    uazapi.com
                  </a>.
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium text-foreground">2. Obtenha suas credenciais</h4>
                <p>
                  Do seu servidor Uazapi, copie a URL e o <strong className="text-foreground">token admin</strong>. A instância será criada automaticamente ao clicar em Conectar — o token da instância é preenchido sozinho. Você também pode colar o token de uma instância existente.
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium text-foreground">3. Webhook</h4>
                <p>
                  Ao conectar, o sistema configura o webhook automaticamente (URL exclusiva da sua conta, evento <code className="bg-muted px-1 rounded">messages</code>, excluindo <code className="bg-muted px-1 rounded">wasSentByApi</code>). Se o seu servidor não suportar, configure manualmente:
                </p>
                <code className="block bg-muted px-2 py-1 rounded text-xs break-all">
                  {webhookUrl}
                </code>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium text-foreground">4. Conecte o WhatsApp</h4>
                <p>
                  Clique em &ldquo;Conectar&rdquo; e escaneie o QR Code com o WhatsApp do seu celular (WhatsApp {'>'} Menu {'>'} Aparelhos conectados {'>'} Conectar um aparelho). O QR expira em ~1 minuto e é atualizado automaticamente.
                </p>
              </div>

              <div className="pt-2 border-t border-border">
                <a
                  href="https://docs.uazapi.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                >
                  <Smartphone className="size-3.5" />
                  Documentação Uazapi
                </a>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

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
                  ? `Sua instância está conectada como ${profileName}.`
                  : 'Sua instância está conectada e pronta para uso.'
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