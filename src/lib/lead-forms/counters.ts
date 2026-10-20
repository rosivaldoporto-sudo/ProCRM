/**
 * Contadores dos cards de resumo (lead_forms.view/response/
 * qualified/booked_count).
 *
 * Os cards leem esses contadores, enquanto a aba Respostas lê as
 * tabelas reais — se o RPC `increment_lead_form_counter` falhar
 * (ex.: migration 055 aplicada sem a função), o sintoma é exatamente
 * "resposta aparece só na aba Respostas". Por isso:
 *  - `bumpFormCounter` NÃO engole erro em silêncio: loga com contexto
 *    para aparecer nos server logs;
 *  - `recountFormCounters` recalcula a partir das tabelas reais e é
 *    exposto no endpoint POST /api/lead-forms/[id]/recount (botão
 *    "Recalcular" no editor) — repara formulários com contador travado.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type CounterField = 'view' | 'response' | 'qualified' | 'booked';

export async function bumpFormCounter(
  db: SupabaseClient,
  formId: string,
  field: CounterField,
): Promise<boolean> {
  const { error } = await db.rpc('increment_lead_form_counter', {
    p_form_id: formId,
    p_field: field,
  });
  if (error) {
    // Visível nos server logs — antes era `void` puro e a falha era
    // invisível, com cards travados em 0.
    console.error('[lead-forms] counter rpc failed:', {
      formId,
      field,
      code: error.code,
      message: error.message,
    });
    return false;
  }
  return true;
}

export interface RecountResult {
  response_count: number;
  qualified_count: number;
  booked_count: number;
}

/**
 * Recalcula contadores a partir das tabelas reais. `view_count` não
 * tem fonte de verdade (é só incremento) e é preservado.
 */
export async function recountFormCounters(
  db: SupabaseClient,
  formId: string,
): Promise<RecountResult> {
  const [{ count: responses }, { count: qualified }, { count: booked }] =
    await Promise.all([
      db
        .from('lead_form_responses')
        .select('id', { count: 'exact', head: true })
        .eq('form_id', formId)
        // Respostas em preenchimento (salvas no WhatsApp) não entram
        // nos cards: só contam quando o formulário é concluído.
        .neq('status', 'started'),
      db
        .from('lead_form_responses')
        .select('id', { count: 'exact', head: true })
        .eq('form_id', formId)
        .eq('is_qualified', true),
      db
        .from('lead_form_bookings')
        .select('id', { count: 'exact', head: true })
        .eq('form_id', formId)
        .neq('status', 'cancelled'),
    ]);

  const result: RecountResult = {
    response_count: responses ?? 0,
    qualified_count: qualified ?? 0,
    booked_count: booked ?? 0,
  };

  const { error } = await db
    .from('lead_forms')
    .update({ ...result, updated_at: new Date().toISOString() })
    .eq('id', formId);
  if (error) {
    console.error('[lead-forms] recount update failed:', error.message);
    throw new Error('Falha ao recalcular contadores');
  }
  return result;
}
