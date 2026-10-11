import { createClient } from '@/lib/supabase/server';
import { getCurrentAccount } from '@/lib/auth/account';

/**
 * Ownership com checagem explícita de tenancy para formulários.
 *
 * Por que não basta o RLS aqui: as mutações usam `supabaseAdmin` (bypassa
 * RLS), então a guarda precisa comparar o `account_id` do formulário com
 * a conta do chamador. Sem isso, qualquer usuário autenticado de QUALQUER
 * conta poderia ler/alterar/excluir formulários alheios (IDOR). Retorna
 * 404 genérico em mismatch para não revelar a existência do recurso.
 *
 * Fica neste módulo (e não exportada de um `route.ts`) porque o Next.js
 * só permite exportar handlers HTTP de arquivos de rota.
 */
export async function requireOwnership(formId: string) {
  let accountId: string;
  let userId: string;
  try {
    const ctx = await getCurrentAccount();
    accountId = ctx.accountId;
    userId = ctx.userId;
  } catch {
    return { ok: false as const, status: 401 as const };
  }
  const supabase = await createClient();
  const { data: form } = await supabase
    .from('lead_forms')
    .select('id, account_id')
    .eq('id', formId)
    .maybeSingle();
  const ownerAccount = (form as { account_id: string } | null)?.account_id;
  if (!ownerAccount || ownerAccount !== accountId) {
    return { ok: false as const, status: 404 as const };
  }
  return { ok: true as const, userId, accountId, supabase };
}
