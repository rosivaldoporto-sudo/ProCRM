import type { Message } from '@/types';

/**
 * Janela de mensagens da conversa aberta.
 *
 * A thread carrega só a página mais recente e busca as anteriores sob
 * demanda (rolagem para cima). Antes ela pedia a conversa inteira em ordem
 * crescente: o PostgREST corta em 1000 linhas, então numa conversa longa
 * chegavam as 1000 mensagens MAIS ANTIGAS e as recentes simplesmente não
 * apareciam.
 *
 * Estas funções são puras para poderem ser testadas sem React.
 */
export const THREAD_PAGE_SIZE = 50;

/** Bolha otimista: criada no cliente antes de o servidor confirmar o envio. */
export function isOptimisticMessage(message: Pick<Message, 'id'>): boolean {
  return message.id.startsWith('temp-');
}

function timeOf(message: Pick<Message, 'created_at'>): number {
  return Date.parse(message.created_at);
}

/** Bolhas otimistas que ainda importam: em envio ou com falha visível. */
function pendingOptimistic(messages: Message[]): Message[] {
  return messages.filter(
    (m) => isOptimisticMessage(m) && m.status !== 'sent'
  );
}

export interface MergeResult {
  messages: Message[];
  /**
   * `true` quando a página nova substituiu o que estava na tela (primeira
   * carga, ou tanta coisa chegou enquanto o realtime esteve fora que não há
   * sobreposição). Quem chama deve recalcular "há mensagens anteriores?".
   */
  replaced: boolean;
}

/**
 * Junta a página mais recente (ordem crescente) com o que já está na tela.
 * Preserva as páginas antigas que o agente já carregou rolando para cima.
 */
export function mergeLatestPage(
  existing: Message[],
  page: Message[],
  pageSize: number = THREAD_PAGE_SIZE
): MergeResult {
  const pending = pendingOptimistic(existing);
  const persisted = existing.filter((m) => !isOptimisticMessage(m));

  if (persisted.length === 0 || page.length === 0) {
    return { messages: [...page, ...pending], replaced: true };
  }

  const pageIds = new Set(page.map((m) => m.id));
  const overlaps = persisted.some((m) => pageIds.has(m.id));
  if (!overlaps && page.length >= pageSize) {
    // Buraco entre o que está na tela e a página nova: manter as antigas
    // esconderia mensagens no meio da conversa.
    return { messages: [...page, ...pending], replaced: true };
  }

  const oldestFresh = timeOf(page[0]);
  const older = persisted.filter(
    (m) => !pageIds.has(m.id) && timeOf(m) <= oldestFresh
  );
  return { messages: [...older, ...page, ...pending], replaced: false };
}

/** Coloca uma página mais antiga (ordem crescente) antes das já carregadas. */
export function prependOlderPage(
  existing: Message[],
  olderPage: Message[]
): Message[] {
  if (olderPage.length === 0) return existing;
  const known = new Set(existing.map((m) => m.id));
  const fresh = olderPage.filter((m) => !known.has(m.id));
  return fresh.length === 0 ? existing : [...fresh, ...existing];
}

/**
 * Aplica um INSERT do realtime à lista da conversa aberta.
 *
 * Só a bolha otimista que corresponde à mensagem confirmada é trocada.
 * Antes, qualquer INSERT (inclusive uma mensagem do cliente) apagava todas
 * as bolhas em envio, e o que o agente acabara de mandar sumia da tela até
 * o próprio INSERT chegar.
 */
export function applyRealtimeInsert(
  existing: Message[],
  incoming: Message
): Message[] {
  if (existing.some((m) => m.id === incoming.id)) return existing;
  if (incoming.sender_type !== 'agent') return [...existing, incoming];

  const candidates = existing.filter(
    (m) => isOptimisticMessage(m) && m.status !== 'failed'
  );
  const match =
    candidates.find(
      (m) =>
        m.content_type === incoming.content_type &&
        (m.content_text ?? '') === (incoming.content_text ?? '')
    ) ??
    candidates.find((m) => m.content_type === incoming.content_type) ??
    candidates[0];

  if (!match) return [...existing, incoming];
  return [...existing.filter((m) => m !== match), incoming];
}
