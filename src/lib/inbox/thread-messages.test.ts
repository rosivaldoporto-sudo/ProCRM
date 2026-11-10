import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import {
  applyRealtimeInsert,
  mergeLatestPage,
  prependOlderPage,
} from './thread-messages';

function msg(id: string, minute: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    conversation_id: 'c1',
    sender_type: 'customer',
    content_type: 'text',
    content_text: id,
    status: 'delivered',
    created_at: new Date(Date.UTC(2026, 10, 10, 12, minute)).toISOString(),
    ...extra,
  };
}

const ids = (list: Message[]) => list.map((m) => m.id);

describe('mergeLatestPage', () => {
  it('usa a página como está na primeira carga', () => {
    const page = [msg('a', 1), msg('b', 2)];
    const result = mergeLatestPage([], page, 2);
    expect(ids(result.messages)).toEqual(['a', 'b']);
    expect(result.replaced).toBe(true);
  });

  it('preserva as páginas antigas já carregadas ao ressincronizar', () => {
    const existing = [msg('a', 1), msg('b', 2), msg('c', 3), msg('d', 4)];
    const page = [msg('c', 3), msg('d', 4), msg('e', 5)];
    const result = mergeLatestPage(existing, page, 3);
    expect(ids(result.messages)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(result.replaced).toBe(false);
  });

  it('atualiza o status das mensagens que vieram de novo', () => {
    const existing = [msg('a', 1, { status: 'sent' })];
    const result = mergeLatestPage(existing, [msg('a', 1, { status: 'read' })], 50);
    expect(result.messages[0].status).toBe('read');
  });

  it('substitui tudo quando há um buraco entre a tela e a página nova', () => {
    const existing = [msg('a', 1), msg('b', 2)];
    const page = [msg('x', 10), msg('y', 11)];
    const result = mergeLatestPage(existing, page, 2);
    expect(ids(result.messages)).toEqual(['x', 'y']);
    expect(result.replaced).toBe(true);
  });

  it('mantém bolhas em envio ou com falha e descarta as já confirmadas', () => {
    const existing = [
      msg('a', 1),
      msg('temp-1', 2, { sender_type: 'agent', status: 'sending' }),
      msg('temp-2', 3, { sender_type: 'agent', status: 'failed' }),
      msg('temp-3', 4, { sender_type: 'agent', status: 'sent' }),
    ];
    const result = mergeLatestPage(existing, [msg('a', 1), msg('b', 5)], 50);
    expect(ids(result.messages)).toEqual(['a', 'b', 'temp-1', 'temp-2']);
  });

  it('remove mensagens apagadas no servidor dentro da janela recente', () => {
    const existing = [msg('a', 1), msg('b', 2), msg('c', 3)];
    const result = mergeLatestPage(existing, [msg('a', 1), msg('c', 3)], 50);
    expect(ids(result.messages)).toEqual(['a', 'c']);
  });
});

describe('prependOlderPage', () => {
  it('coloca as antigas antes e ignora repetidas', () => {
    const existing = [msg('c', 3), msg('d', 4)];
    const result = prependOlderPage(existing, [msg('a', 1), msg('b', 2), msg('c', 3)]);
    expect(ids(result)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('devolve a mesma lista quando não há nada novo', () => {
    const existing = [msg('c', 3)];
    expect(prependOlderPage(existing, [msg('c', 3)])).toBe(existing);
    expect(prependOlderPage(existing, [])).toBe(existing);
  });
});

describe('applyRealtimeInsert', () => {
  it('ignora mensagem que já está na lista', () => {
    const existing = [msg('a', 1)];
    expect(applyRealtimeInsert(existing, msg('a', 1))).toBe(existing);
  });

  it('não apaga a bolha em envio quando chega mensagem do cliente', () => {
    const existing = [
      msg('a', 1),
      msg('temp-1', 2, { sender_type: 'agent', status: 'sending' }),
    ];
    const result = applyRealtimeInsert(existing, msg('b', 3));
    expect(ids(result)).toEqual(['a', 'temp-1', 'b']);
  });

  it('troca só a bolha otimista correspondente', () => {
    const existing = [
      msg('temp-1', 2, { sender_type: 'agent', status: 'sending', content_text: 'oi' }),
      msg('temp-2', 3, { sender_type: 'agent', status: 'sending', content_text: 'tudo bem?' }),
    ];
    const confirmed = msg('real', 3, { sender_type: 'agent', content_text: 'tudo bem?' });
    expect(ids(applyRealtimeInsert(existing, confirmed))).toEqual(['temp-1', 'real']);
  });

  it('preserva a bolha com falha', () => {
    const existing = [
      msg('temp-1', 2, { sender_type: 'agent', status: 'failed', content_text: 'oi' }),
    ];
    const confirmed = msg('real', 3, { sender_type: 'agent', content_text: 'oi' });
    expect(ids(applyRealtimeInsert(existing, confirmed))).toEqual(['temp-1', 'real']);
  });
});
