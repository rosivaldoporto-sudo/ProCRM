import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Entrega o webhook externo de um formulário. A URL é definida por quem
 * edita o formulário e a requisição parte do nosso servidor, então passa
 * pelo mesmo guarda de SSRF do `lib/webhooks/deliver.ts`: destino privado
 * é recusado e redirect não é seguido (um 3xx poderia apontar para a rede
 * interna depois da checagem). Falha só gera log: o lead já foi salvo.
 */
export async function deliverFormWebhook(
  url: string,
  payload: string
): Promise<void> {
  if (!(await isDeliverableUrl(url))) {
    console.warn('[lead-forms] webhook recusado: destino não público');
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[lead-forms] webhook respondeu', res.status);
    }
  } catch (err) {
    console.warn(
      '[lead-forms] webhook falhou:',
      err instanceof Error ? err.message : err
    );
  }
}
