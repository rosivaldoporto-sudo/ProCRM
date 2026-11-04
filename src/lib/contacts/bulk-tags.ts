// ============================================================
// Etiquetar contatos em massa a partir do navegador.
//
// A seleção vai em lotes, um por requisição, em vez de um corpo único:
//   - cada lote é uma única instrução no banco, então ou entra inteiro
//     ou não entra, e a tela sabe exatamente quais contatos ficaram de fora;
//   - o progresso avança a cada lote, e uma falha para o processo em vez
//     de deixar o resto para trás sem aviso;
//   - repetir um lote é seguro: quem já tem a etiqueta só conta como
//     "sem alteração", então a tela pode tentar de novo sem efeito colateral.
// ============================================================

/**
 * Teto de contatos por requisição, na rota e no navegador. A remoção
 * coloca os ids na URL, e 100 UUIDs ocupam cerca de 4 KB, o mesmo valor
 * que `CONTACT_ID_CHUNK` usa nas transmissões.
 */
export const BULK_TAG_BATCH_SIZE = 100;

export type BulkTagAction = 'add' | 'remove';

/** Resposta da rota para um lote. */
export interface BulkTagBatchResult {
  ok: true;
  /** Contatos que ganharam ou perderam a etiqueta. */
  changed: number;
  /** Já tinham (ao adicionar) ou já não tinham (ao remover). */
  unchanged: number;
  /** Não existem mais nesta conta, por exemplo excluídos por outra pessoa. */
  not_found: number;
}

export interface BulkTagProgress {
  done: number;
  total: number;
}

export interface BulkTagOutcome {
  total: number;
  changed: number;
  unchanged: number;
  notFound: number;
  /** O lote que falhou e tudo o que vinha depois dele. */
  failedIds: string[];
  /** Motivo da interrupção, pronto para mostrar. Nulo quando deu tudo certo. */
  error: string | null;
}

type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

interface RunBulkTagInput {
  contactIds: string[];
  tagId: string;
  action: BulkTagAction;
  onProgress?: (progress: BulkTagProgress) => void;
  /** Substituíveis nos testes. */
  request?: Fetcher;
  wait?: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 1000;
const MAX_RETRY_WAIT_MS = 60_000;
const NETWORK_ERROR = 'Sem resposta do servidor. Verifique sua conexão.';

const defaultWait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function isBatchResult(body: unknown): body is BulkTagBatchResult {
  const value = body as Partial<BulkTagBatchResult> | null;
  return (
    typeof value?.changed === 'number' &&
    typeof value.unchanged === 'number' &&
    typeof value.not_found === 'number'
  );
}

function retryDelay(response: Response | null, attempt: number): number {
  const seconds = Number(response?.headers.get('Retry-After'));
  const delay =
    Number.isFinite(seconds) && seconds > 0
      ? seconds * 1000
      : RETRY_BASE_MS * attempt;
  return Math.min(delay, MAX_RETRY_WAIT_MS);
}

/** Só vale repetir o que pode passar sozinho: rede, 429 e erro do servidor. */
function isRetryable(response: Response | null): boolean {
  return !response || response.status === 429 || response.status >= 500;
}

async function sendBatch(
  batch: string[],
  tagId: string,
  action: BulkTagAction,
  request: Fetcher,
  wait: (ms: number) => Promise<void>
): Promise<BulkTagBatchResult | { error: string }> {
  let lastError = NETWORK_ERROR;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response | null = null;
    try {
      response = await request('/api/contacts/bulk-tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: batch, tag_id: tagId, action }),
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: unknown }
        | null;
      if (response.ok && isBatchResult(body)) return body;
      lastError =
        typeof body?.error === 'string'
          ? body.error
          : `O servidor respondeu com erro ${response.status}.`;
    } catch {
      lastError = NETWORK_ERROR;
    }

    if (!isRetryable(response) || attempt === MAX_ATTEMPTS) break;
    await wait(retryDelay(response, attempt));
  }

  return { error: lastError };
}

/**
 * Aplica a ação a todos os contatos, um lote de cada vez, e para no
 * primeiro lote que não conseguir gravar depois das novas tentativas.
 */
export async function runBulkTagAction({
  contactIds,
  tagId,
  action,
  onProgress,
  request = (input, init) => fetch(input, init),
  wait = defaultWait,
}: RunBulkTagInput): Promise<BulkTagOutcome> {
  const ids = [...new Set(contactIds)];
  const outcome: BulkTagOutcome = {
    total: ids.length,
    changed: 0,
    unchanged: 0,
    notFound: 0,
    failedIds: [],
    error: null,
  };

  for (let i = 0; i < ids.length; i += BULK_TAG_BATCH_SIZE) {
    const batch = ids.slice(i, i + BULK_TAG_BATCH_SIZE);
    const result = await sendBatch(batch, tagId, action, request, wait);

    if ('error' in result) {
      outcome.failedIds = ids.slice(i);
      outcome.error = result.error;
      return outcome;
    }

    outcome.changed += result.changed;
    outcome.unchanged += result.unchanged;
    outcome.notFound += result.not_found;
    onProgress?.({ done: i + batch.length, total: ids.length });
  }

  return outcome;
}
