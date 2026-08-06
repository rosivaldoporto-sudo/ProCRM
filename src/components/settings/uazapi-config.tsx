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
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'qrcode' | 'unknown';

export function UazapiConfig() {
  const supabase = createClient();
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [statusMessage, setStatusMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [instanceName, setInstanceName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/uazapi/webhook`
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
        setWebhookSecret('');
        setTokenEdited(false);
        setQrCode(data.qr_code || null);
        setConnectionStatus(data.status as ConnectionStatus);
      } else {
        setInstanceName('');
        setServerUrl('');
        setApiToken('');
        setWebhookSecret('');
        setTokenEdited(false);
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
            setStatusMessage('');
          } else if (payload.status === 'qrcode') {
            setConnectionStatus('qrcode');
            setQrCode(payload.qr_code || data.qr_code);
            setStatusMessage('Scan the QR code with WhatsApp to connect.');
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
      toast.error('Failed to load Uazapi configuration');
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

  async function handleSave() {
    if (!instanceName.trim()) {
      toast.error('Instance name is required');
      return;
    }
    if (!serverUrl.trim()) {
      toast.error('Server URL is required');
      return;
    }

    const payload: Record<string, unknown> = {
      instance_name: instanceName.trim(),
      server_url: serverUrl.trim().replace(/\/+$/, ''),
      webhook_secret: webhookSecret.trim() || null,
    };

    if (tokenEdited && apiToken !== MASKED_TOKEN && apiToken.trim()) {
      payload.api_token = apiToken.trim();
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
        toast.error(data.error || 'Failed to save configuration');
        return;
      }

      toast.success('Uazapi configuration saved.');
      if (accountId) await fetchConfig(accountId);
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleConnect() {
    try {
      setConnecting(true);
      setQrCode(null);
      const res = await fetch('/api/uazapi/instance/connect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to connect');
        return;
      }

      if (data.qr_code) {
        setQrCode(data.qr_code);
        setConnectionStatus('qrcode');
        toast.success('QR code generated. Scan it with WhatsApp to connect.', { duration: 8000 });
      } else if (data.status === 'connected') {
        setConnectionStatus('connected');
        setQrCode(null);
        toast.success('Instance already connected!');
      }
    } catch (err) {
      console.error('Connect error:', err);
      toast.error('Failed to connect instance');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      setDisconnecting(true);
      const res = await fetch('/api/uazapi/instance/disconnect', { method: 'POST' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to disconnect');
        return;
      }

      setConnectionStatus('disconnected');
      setQrCode(null);
      toast.success('Instance disconnected.');
    } catch (err) {
      console.error('Disconnect error:', err);
      toast.error('Failed to disconnect instance');
    } finally {
      setDisconnecting(false);
    }
  }

  async function handleReset() {
    if (!confirm('This will delete the Uazapi configuration. Continue?')) return;

    try {
      setLoading(true);
      const res = await fetch('/api/uazapi/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to reset');
        return;
      }
      toast.success('Configuration cleared.');
      setInstanceName('');
      setServerUrl('');
      setApiToken('');
      setWebhookSecret('');
      setTokenEdited(false);
      setConnectionStatus('disconnected');
      setQrCode(null);
      setStatusMessage('');
    } catch (err) {
      console.error('Reset error:', err);
      toast.error('Failed to reset configuration');
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
        toast.error(data.error || 'Sync failed');
        return;
      }
      toast.success(data.message || `Synced ${data.synced} conversations.`);
      if (data.synced > 0 && accountId) await fetchConfig(accountId);
    } catch {
      toast.error('Failed to sync conversations');
    } finally {
      setSyncing(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
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
              ) : connectionStatus === 'qrcode' ? (
                <QrCode className="size-4 text-amber-500" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {connectionStatus === 'connected'
                  ? 'Conectado'
                  : connectionStatus === 'qrcode'
                    ? 'Aguardando QR Code'
                    : 'Desconectado'}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {connectionStatus === 'connected'
                ? 'Instância conectada e pronta para enviar/receber mensagens.'
                : connectionStatus === 'qrcode'
                  ? 'Escaneie o QR Code abaixo com o WhatsApp para conectar.'
                  : statusMessage || 'Configure abaixo e clique em Conectar.'}
            </AlertDescription>
          </Alert>

          {/* QR Code Display */}
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
                {qrCode.startsWith('data:') ? (
                  <img
                    src={qrCode}
                    alt="WhatsApp QR Code"
                    className="size-64 border border-border rounded-lg"
                  />
                ) : (
                  <div className="bg-white p-4 rounded-lg max-w-full overflow-auto">
                    <code className="text-xs text-black break-all">{qrCode}</code>
                  </div>
                )}
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
                <Label className="text-muted-foreground">API Token</Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder="Digite seu token da API Uazapi"
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
                Configure esta URL como webhook no seu servidor Uazapi para receber mensagens.
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
                <p>Do seu servidor Uazapi, copie o nome da instância, a URL do servidor e o token de API.</p>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium text-foreground">3. Configure o webhook</h4>
                <p>
                  No seu servidor Uazapi, configure a URL de webhook como:
                </p>
                <code className="block bg-muted px-2 py-1 rounded text-xs break-all">
                  {webhookUrl}
                </code>
                <p className="text-xs text-muted-foreground">
                  Habilite o webhook e selecione o evento <code className="bg-muted px-1 rounded">messages</code>.
                  Em &ldquo;Excluir mensagens&rdquo;, marque <code className="bg-muted px-1 rounded">wasSentByApi</code>{' '}
                  para evitar loop (mensagens enviadas pela própria API voltando pelo webhook).
                </p>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium text-foreground">4. Conecte o WhatsApp</h4>
                <p>Clique em &ldquo;Conectar&rdquo; e escaneie o QR Code com o WhatsApp do seu celular.</p>
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
    </section>
  );
}
