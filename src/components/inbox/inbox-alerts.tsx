'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { useAuth } from '@/hooks/use-auth';
import { getInboxAlertPrefs } from '@/lib/inbox/alert-prefs';
import { playMessageChime, primeAlertSound } from '@/lib/inbox/alert-sound';
import { isPushSubscribed, showLocalNotification } from '@/lib/push/client';
import { messagePreview } from '@/lib/push/preview';
import { createClient } from '@/lib/supabase/client';
import type { Message } from '@/types';

/**
 * Mensagens importadas do histórico (sincronização Uazapi) também geram
 * INSERT, mas com a data original. Só alerta o que acabou de chegar; a
 * folga cobre relógio do computador adiantado ou atrasado.
 */
const FRESH_WINDOW_MS = 10 * 60 * 1000;
const MAX_REMEMBERED_IDS = 200;

/** O agente está com esta conversa aberta e olhando para ela? */
function isReadingConversation(conversationId: string): boolean {
  if (document.visibilityState !== 'visible' || !document.hasFocus()) {
    return false;
  }
  if (window.location.pathname !== '/conversas') return false;
  return (
    new URLSearchParams(window.location.search).get('c') === conversationId
  );
}

/**
 * Alertas de nova mensagem enquanto o app está aberto em alguma aba —
 * complementa o Web Push, que cobre o app fechado.
 *
 *  - Aba visível, fora do inbox: aviso na tela com atalho para a conversa.
 *  - Aba visível: som curto (mesmo no inbox, se for outra conversa).
 *  - Aba em segundo plano sem push ativo neste navegador (permissão dada,
 *    mas servidor sem VAPID ou inscrição com erro): notificação do sistema
 *    disparada pela própria página, para o computador não ficar mudo.
 *
 * Segue a mesma regra do push: conversa atribuída avisa só o responsável.
 * Não renderiza nada.
 */
export function InboxAlerts() {
  const t = useTranslations('Inbox.alerts');
  const router = useRouter();
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;

    const supabase = createClient();
    const seen = new Set<string>();
    let active = true;

    const prime = () => primeAlertSound();
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });

    const handle = async (message: Message) => {
      if (!message?.id || seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > MAX_REMEMBERED_IDS) {
        const oldest = seen.values().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }

      const age = Date.now() - Date.parse(message.created_at);
      if (!Number.isFinite(age) || Math.abs(age) > FRESH_WINDOW_MS) return;
      if (isReadingConversation(message.conversation_id)) return;

      const { data } = await supabase
        .from('conversations')
        .select('id, assigned_agent_id, contact:contacts(name, phone)')
        .eq('id', message.conversation_id)
        .maybeSingle();
      if (!active) return;

      const assignedTo = data?.assigned_agent_id as string | null | undefined;
      if (assignedTo && assignedTo !== userId) return;

      const rawContact = data?.contact as
        | { name?: string | null; phone?: string | null }
        | { name?: string | null; phone?: string | null }[]
        | null
        | undefined;
      const contact = Array.isArray(rawContact) ? rawContact[0] : rawContact;
      const title = contact?.name || contact?.phone || t('newMessage');
      const body = messagePreview(message.content_type, message.content_text);
      const url = `/conversas?c=${message.conversation_id}`;
      const prefs = getInboxAlertPrefs();
      const visible = document.visibilityState === 'visible';

      if (visible) {
        if (prefs.sound) playMessageChime();
        // No inbox a lista já sobe a conversa com o contador; o aviso
        // seria ruído em cima da própria informação.
        if (prefs.toast && window.location.pathname !== '/conversas') {
          toast(title, {
            id: `inbox-${message.conversation_id}`,
            description: body,
            duration: 7000,
            action: { label: t('open'), onClick: () => router.push(url) },
          });
        }
        return;
      }

      // Aba em segundo plano: com push ativo, o service worker já mostra a
      // notificação do sistema (com o som do próprio sistema).
      if (isPushSubscribed()) return;
      if (prefs.sound) playMessageChime();
      void showLocalNotification({
        title,
        body,
        url,
        tag: `conversation-${message.conversation_id}`,
      });
    };

    const channel = supabase
      .channel('inbox-alerts')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: 'sender_type=eq.customer',
        },
        (payload) => {
          void handle(payload.new as Message);
        }
      )
      .subscribe();

    return () => {
      active = false;
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
      supabase.removeChannel(channel);
    };
  }, [userId, router, t]);

  return null;
}
