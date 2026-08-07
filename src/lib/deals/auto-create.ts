import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Automatic deal creation for inbound leads.
//
// Every new lead (first inbound message from a contact) is added to
// the account's pipeline in its first stage ("New Lead"). The
// pipeline itself is the account's default one — defined as the
// oldest by created_at, mirroring the Pipelines page's selection
// (page.tsx picks list[0] of the created_at-ordered list). When the
// account has no pipeline yet (fresh account, user never visited the
// Pipelines page), we seed the same default pipeline the UI seeds.
// ============================================================

/** Mirrors SPEC_DEFAULT_STAGES in src/app/(dashboard)/pipelines/page.tsx. */
const DEFAULT_PIPELINE_NAME = 'Sales Pipeline'
const DEFAULT_STAGES = [
  { name: 'New Lead', color: '#3b82f6', position: 0 },
  { name: 'Qualified', color: '#eab308', position: 1 },
  { name: 'Proposal Sent', color: '#f97316', position: 2 },
  { name: 'Negotiation', color: '#8b5cf6', position: 3 },
  { name: 'Won', color: '#22c55e', position: 4 },
]

export interface EnsureLeadDealArgs {
  db: SupabaseClient
  /** Tenancy key — every row is stamped with it. */
  accountId: string
  /** Sender-of-record for the deals.user_id NOT NULL FK. */
  userId: string
  contactId: string
  conversationId: string
  /** Deal title — the contact's display name when available. */
  contactName: string
}

/**
 * Make sure the lead has a deal in the pipeline's first stage.
 * Idempotent: if the contact already has an open deal in the
 * account's default pipeline, does nothing (no duplicates on later
 * messages). Returns true when a deal was created.
 *
 * Never throws — the webhook paths that call this must not fail the
 * message ingest because of a pipeline hiccup.
 */
export async function ensureLeadDeal(
  args: EnsureLeadDealArgs,
): Promise<boolean> {
  const { db, accountId, userId, contactId, conversationId, contactName } = args

  try {
    const pipeline = await getOrCreateDefaultPipeline(db, accountId, userId)
    if (!pipeline) return false

    // A contact's existing open deal in this pipeline already covers
    // the lead — re-opening a thread must not create a duplicate.
    const { data: existing, error: existingErr } = await db
      .from('deals')
      .select('id')
      .eq('contact_id', contactId)
      .eq('pipeline_id', pipeline.id)
      .eq('status', 'open')
      .limit(1)
    if (existingErr || (existing && existing.length > 0)) return false

    const stage = await getFirstStage(db, pipeline.id)
    if (!stage) return false

    const { error: insertErr } = await db.from('deals').insert({
      account_id: accountId,
      user_id: userId,
      pipeline_id: pipeline.id,
      stage_id: stage.id,
      contact_id: contactId,
      conversation_id: conversationId,
      title: contactName || 'Novo lead',
      value: 0,
      status: 'open',
    })
    if (insertErr) {
      console.error('[lead-deal] insert failed:', insertErr)
      return false
    }
    return true
  } catch (err) {
    console.error('[lead-deal] ensureLeadDeal failed:', err)
    return false
  }
}

/**
 * The account's default pipeline: the oldest by created_at (same rule
 * the Pipelines page uses). None exists → seed the standard pipeline
 * with its default stages, exactly like the UI's seedDefaultPipeline.
 */
async function getOrCreateDefaultPipeline(
  db: SupabaseClient,
  accountId: string,
  userId: string,
): Promise<{ id: string } | null> {
  const { data: pipelines, error: listErr } = await db
    .from('pipelines')
    .select('id')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (listErr) {
    console.error('[lead-deal] pipeline lookup failed:', listErr)
    return null
  }
  if (pipelines && pipelines.length > 0) return pipelines[0]

  const { data: created, error: createErr } = await db
    .from('pipelines')
    .insert({ user_id: userId, account_id: accountId, name: DEFAULT_PIPELINE_NAME })
    .select('id')
    .single()
  if (createErr || !created) {
    // Two webhook calls can race the seed — treat a unique-violation
    // as "someone else seeded it" and re-read.
    if (createErr) {
      console.warn('[lead-deal] pipeline seed failed (may be a race):', createErr)
    }
    const { data: retry } = await db
      .from('pipelines')
      .select('id')
      .eq('account_id', accountId)
      .order('created_at', { ascending: true })
      .limit(1)
    if (retry && retry.length > 0) return retry[0]
    return null
  }

  await db.from('pipeline_stages').insert(
    DEFAULT_STAGES.map((s) => ({ pipeline_id: created.id, ...s })),
  )
  return created
}

/** The pipeline's first stage by position (the "New Lead" column). */
async function getFirstStage(
  db: SupabaseClient,
  pipelineId: string,
): Promise<{ id: string } | null> {
  const { data: stages, error } = await db
    .from('pipeline_stages')
    .select('id')
    .eq('pipeline_id', pipelineId)
    .order('position', { ascending: true })
    .limit(1)
  if (error) {
    console.error('[lead-deal] stage lookup failed:', error)
    return null
  }
  return stages && stages.length > 0 ? stages[0] : null
}
