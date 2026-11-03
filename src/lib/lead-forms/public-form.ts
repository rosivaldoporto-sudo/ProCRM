import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Formulário publicado para um slug público.
 *
 * `UNIQUE (account_id, slug)` só garante unicidade dentro da conta, e o
 * cadastro é aberto. Um `.eq('slug', slug).maybeSingle()` puro devolve
 * erro quando duas contas usam o mesmo slug, então bastava outra conta
 * criar um rascunho homônimo para derrubar o formulário público da
 * vítima. Filtrar por `published` e ficar com o mais antigo mantém no ar
 * quem chegou primeiro; a criação e a renomeação (`/api/lead-forms`) já
 * recusam colisões novas.
 */
export async function findPublishedFormBySlug(
  db: SupabaseClient,
  slug: string,
  columns = '*'
): Promise<Record<string, unknown> | null> {
  const { data } = await db
    .from('lead_forms')
    .select(columns)
    .eq('slug', slug)
    .eq('status', 'published')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as unknown as Record<string, unknown> | null) ?? null;
}
