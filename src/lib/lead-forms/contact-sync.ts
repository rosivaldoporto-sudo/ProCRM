/**
 * Sincronização de contato + deal de um lead de formulário.
 *
 * O formulário agora salva o lead assim que a pessoa responde o
 * WhatsApp (status `started`) e reaproveita a mesma resposta no envio
 * final. Este módulo concentra a criação/atualização do contato e do
 * deal para que os dois momentos usem exatamente as mesmas regras:
 *
 *  - contato é deduplicado por telefone normalizado (e depois e-mail);
 *  - quando já existe um contato ligado à resposta, ele é atualizado
 *    em vez de criar outro;
 *  - o deal criado no salvamento parcial é reaproveitado no final
 *    (sem duplicar card no pipeline).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { findExistingContact } from '@/lib/contacts/dedupe';
import { normalizePhone } from '@/lib/whatsapp/phone-utils';

export interface LeadContactFields {
  name?: string;
  email?: string;
  phone?: string;
}

export interface LeadSyncSettings {
  create_contact?: boolean;
  create_deal?: boolean;
  qualified_pipeline_stage_id?: string | null;
}

export interface SyncLeadArgs {
  accountId: string;
  /** Dono do formulário — vira `user_id` do contato/deal. */
  ownerId: string;
  formName: string;
  contact: LeadContactFields;
  company?: string | null;
  tracking: Record<string, unknown>;
  settings: LeadSyncSettings;
  existingContactId?: string | null;
  existingDealId?: string | null;
}

export interface SyncLeadResult {
  contactId: string | null;
  dealId: string | null;
}

const UTM_KEYS = [
  'utm_source',
  'utm_campaign',
  'utm_medium',
  'utm_term',
  'utm_content',
] as const;

function utmPatch(tracking: Record<string, unknown>): Partial<Record<(typeof UTM_KEYS)[number], string>> {
  const out: Partial<Record<(typeof UTM_KEYS)[number], string>> = {};
  for (const key of UTM_KEYS) {
    const value = tracking[key];
    if (typeof value === 'string' && value) out[key] = value;
  }
  return out;
}

async function findContactId(
  db: SupabaseClient,
  accountId: string,
  contact: LeadContactFields,
): Promise<string | null> {
  if (contact.phone) {
    // 1) Bate exato pelo índice único (ignora formatação: o banco
    //    guarda os dígitos em `phone_normalized`).
    const normalized = normalizePhone(contact.phone);
    if (normalized) {
      const { data } = await db
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .eq('phone_normalized', normalized)
        .limit(1)
        .maybeSingle();
      if (data) return (data as { id: string }).id;
    }
    // 2) Tolera variantes de DDI/tronco, como o webhook e o import.
    const existing = await findExistingContact(db, accountId, contact.phone);
    if (existing) return existing.id;
  }
  if (contact.email) {
    const { data } = await db
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('email', contact.email)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return (data as { id: string }).id;
  }
  return null;
}

async function updateContact(
  db: SupabaseClient,
  contactId: string,
  contact: LeadContactFields,
  company: string | null | undefined,
  tracking: Record<string, unknown>,
): Promise<boolean> {
  const patch: Record<string, unknown> = { ...utmPatch(tracking) };
  if (contact.name) patch.name = contact.name;
  if (contact.email) patch.email = contact.email;
  if (company) patch.company = company;
  // Telefone não é sobrescrito: o contato pode ter vindo do WhatsApp
  // com outro formato/DDI e o número já foi capturado no salvamento
  // parcial. Alterar aqui poderia quebrar o envio pelo WhatsApp.
  if (Object.keys(patch).length === 0) return true;

  const { error } = await db.from('contacts').update(patch).eq('id', contactId);
  return !error;
}

async function ensureDeal(
  db: SupabaseClient,
  args: SyncLeadArgs,
  contactId: string,
  existingDealId: string | null,
): Promise<string | null> {
  // Deal já criado no salvamento parcial: mantém o mesmo card, só
  // atualiza o título quando o nome real chega no envio final.
  if (existingDealId) {
    if (args.contact.name) {
      await db
        .from('deals')
        .update({ title: `${args.contact.name} — ${args.formName}` })
        .eq('id', existingDealId);
    }
    return existingDealId;
  }

  if (args.settings.create_deal === false) return null;

  // Pipeline: usa o stage configurado no formulário; senão o primeiro
  // stage do primeiro pipeline da conta (mesma regra do submit antigo).
  let stageId = args.settings.qualified_pipeline_stage_id ?? null;
  let pipelineId: string | null = null;
  if (stageId) {
    const { data: stage } = await db
      .from('pipeline_stages')
      .select('id, pipeline_id')
      .eq('id', stageId)
      .maybeSingle();
    if (stage) pipelineId = (stage as { pipeline_id: string }).pipeline_id;
    else stageId = null;
  }
  if (!stageId) {
    const { data: pipelines } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', args.accountId)
      .order('created_at')
      .limit(1);
    pipelineId = ((pipelines?.[0] as { id: string } | undefined)?.id) ?? null;
    if (pipelineId) {
      const { data: stages } = await db
        .from('pipeline_stages')
        .select('id')
        .eq('pipeline_id', pipelineId)
        .order('position')
        .limit(1);
      stageId = ((stages?.[0] as { id: string } | undefined)?.id) ?? null;
    }
  }
  if (!stageId || !pipelineId) return null;

  const { data: deal } = await db
    .from('deals')
    .insert({
      account_id: args.accountId,
      user_id: args.ownerId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      contact_id: contactId,
      title: `${args.contact.name ?? 'Lead'} — ${args.formName}`,
      value: 0,
      status: 'open',
    })
    .select('id')
    .single();
  return ((deal as { id: string } | null)?.id) ?? null;
}

export async function syncLeadRecords(
  db: SupabaseClient,
  args: SyncLeadArgs,
): Promise<SyncLeadResult> {
  const { contact, settings, tracking } = args;
  let contactId = args.existingContactId ?? null;

  const canTouchContact = settings.create_contact !== false || Boolean(contactId);

  if (canTouchContact) {
    if (contactId) {
      const updated = await updateContact(db, contactId, contact, args.company, tracking);
      // Falha ao atualizar (ex.: erro transitório): tenta localizar o
      // contato pelo telefone/e-mail antes de criar outro.
      if (!updated) contactId = await findContactId(db, args.accountId, contact) ?? contactId;
    } else {
      contactId = await findContactId(db, args.accountId, contact);
      if (contactId) {
        await updateContact(db, contactId, contact, args.company, tracking);
      } else if (contact.phone) {
        const { data: created, error } = await db
          .from('contacts')
          .insert({
            account_id: args.accountId,
            user_id: args.ownerId,
            name: contact.name ?? 'Lead via formulário',
            phone: contact.phone,
            email: contact.email ?? null,
            company: args.company ?? null,
            ...utmPatch(tracking),
          })
          .select('id')
          .single();
        if (!error) {
          contactId = (created as { id: string } | null)?.id ?? null;
        } else {
          // Corrida com outro submit do mesmo telefone: usa o vencedor.
          contactId = await findContactId(db, args.accountId, contact);
        }
      }
    }
  }

  const dealId = contactId
    ? await ensureDeal(db, args, contactId, args.existingDealId ?? null)
    : null;

  return { contactId, dealId };
}
