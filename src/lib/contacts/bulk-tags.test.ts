import { describe, expect, it, vi } from 'vitest';

import { runBulkTagAction } from './bulk-tags';

const ok = (changed: number) =>
  Response.json({ ok: true, changed, unchanged: 0, not_found: 0 });

const ids = (n: number) => Array.from({ length: n }, (_, i) => `contact-${i}`);

function run(
  responses: (() => Promise<Response>)[],
  contactIds = ids(150)
) {
  const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    () => {
      const next = responses.shift();
      if (!next) throw new Error('requisição a mais');
      return next();
    }
  );
  const wait = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
  return runBulkTagAction({
    contactIds,
    tagId: 'tag-1',
    action: 'add',
    request,
    wait,
  }).then((outcome) => ({ outcome, request, wait }));
}

describe('runBulkTagAction', () => {
  it('espera o tempo pedido pelo servidor num 429 e continua', async () => {
    const { outcome, wait } = await run([
      async () =>
        new Response('{}', { status: 429, headers: { 'Retry-After': '7' } }),
      async () => ok(100),
      async () => ok(50),
    ]);

    expect(wait).toHaveBeenCalledWith(7000);
    expect(outcome).toMatchObject({ changed: 150, error: null });
  });

  it('não espera mais que o teto, mesmo que o servidor peça', async () => {
    const { wait } = await run([
      async () =>
        new Response('{}', { status: 429, headers: { 'Retry-After': '9999' } }),
      async () => ok(100),
      async () => ok(50),
    ]);

    expect(wait).toHaveBeenCalledWith(60_000);
  });

  it('trata queda de rede como falha que pode ser repetida', async () => {
    const { outcome, request } = await run([
      () => Promise.reject(new TypeError('Failed to fetch')),
      async () => ok(100),
      async () => ok(50),
    ]);

    expect(request).toHaveBeenCalledTimes(3);
    expect(outcome).toMatchObject({ changed: 150, error: null });
  });

  it('diz o motivo quando a rede não volta', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));

    const { outcome, request } = await run([offline, offline, offline]);

    expect(request).toHaveBeenCalledTimes(3);
    expect(outcome.failedIds).toHaveLength(150);
    expect(outcome.error).toBe('Sem resposta do servidor. Verifique sua conexão.');
  });

  it('não confunde a página de erro de um proxy com sucesso', async () => {
    const gateway = async () => new Response('<html>502</html>', { status: 502 });

    const { outcome } = await run([gateway, gateway, gateway]);

    expect(outcome.error).toBe('O servidor respondeu com erro 502.');
    expect(outcome.changed).toBe(0);
  });

  it('não aceita um 200 sem os números do lote', async () => {
    const { outcome } = await run([
      async () => Response.json({ ok: true }),
      async () => Response.json({ ok: true }),
      async () => Response.json({ ok: true }),
    ]);

    expect(outcome.failedIds).toHaveLength(150);
  });

  it('não envia o mesmo contato duas vezes', async () => {
    const { request, outcome } = await run(
      [async () => ok(2)],
      ['a', 'b', 'a', 'b']
    );

    const body = JSON.parse(request.mock.calls[0][1].body as string);
    expect(body.contact_ids).toEqual(['a', 'b']);
    expect(outcome.total).toBe(2);
  });
});
