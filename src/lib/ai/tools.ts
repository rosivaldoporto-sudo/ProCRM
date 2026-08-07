import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiToolDefinition } from './types'

// ============================================================
// Pipeline tools for the AI agent.
//
// The auto-reply agent can inspect and move the *current contact's*
// deals across the pipeline stages. Every tool is scoped to the
// conversation's contact (tenancy): the agent can never read or move
// another contact's deals, and every DB hit is filtered by account.
// ============================================================

export const AI_PIPELINE_TOOLS: AiToolDefinition[] = [
  {
    name: 'get_contact_deals',
    description:
      "List the customer's deals in your sales pipeline: title, stage, value and status. Call this first to learn the deal ids and available stage names before moving anything.",
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'move_deal_to_stage',
    description:
      "Move one of the customer's deals to another stage of the same pipeline, using the exact stage name from get_contact_deals (e.g. 'Qualified', 'Proposal Sent', 'Negotiation', 'Won'). Use it when the conversation clearly indicates the deal should advance (customer qualifies, asks for a proposal, agrees) or retreat (disengaged).",
    parameters: {
      type: 'object',
      properties: {
        deal_id: {
          type: 'string',
          description: "The deal's id from get_contact_deals.",
        },
        stage_name: {
          type: 'string',
          description: "The exact target stage name from get_contact_deals.",
        },
      },
      required: ['deal_id', 'stage_name'],
      additionalProperties: false,
    },
  },
]

export interface ExecutePipelineToolArgs {
  db: SupabaseClient
  /** Tenancy key — every query is filtered by it. */
  accountId: string
  /** Only the deals of this contact may be read or moved. */
  contactId: string
  name: string
  args: Record<string, unknown>
}

/**
 * Run one pipeline tool for the AI agent. Always resolves to a
 * stringified JSON payload the model can act on — errors are returned
 * as `{ error: ... }`, never thrown (a tool failure must not kill the
 * auto-reply turn).
 */
export async function executePipelineTool(
  input: ExecutePipelineToolArgs,
): Promise<string> {
  const { db, accountId, contactId, name, args } = input

  try {
    switch (name) {
      case 'get_contact_deals':
        return await listContactDeals(db, accountId, contactId)
      case 'move_deal_to_stage':
        return await moveDealToStage(db, accountId, contactId, args)
      default:
        return JSON.stringify({ error: `unknown_tool: ${name}` })
    }
  } catch (err) {
    console.error('[ai-tools] pipeline tool failed:', err)
    return JSON.stringify({ error: 'internal_error' })
  }
}

async function listContactDeals(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<string> {
  const { data, error } = await db
    .from('deals')
    .select('id, title, value, currency, status, stage_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('updated_at', { ascending: false })
  if (error) {
    console.error('[ai-tools] listContactDeals failed:', error)
    return JSON.stringify({ error: 'database_error' })
  }
  const deals = data ?? []
  const stageIds = [...new Set(deals.map((d) => d.stage_id).filter(Boolean))] as string[]
  let stageName = new Map<string, string>()
  if (stageIds.length > 0) {
    const { data: stages } = await db
      .from('pipeline_stages')
      .select('id, name')
      .in('id', stageIds)
    stageName = new Map((stages ?? []).map((s) => [s.id, s.name]))
  }
  return JSON.stringify(
    deals.map((d) => ({
      id: d.id,
      title: d.title,
      value: Number(d.value ?? 0),
      currency: d.currency ?? 'USD',
      status: d.status,
      stage: stageName.get(d.stage_id) ?? null,
    })),
  )
}

async function moveDealToStage(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  args: Record<string, unknown>,
): Promise<string> {
  const dealId = typeof args.deal_id === 'string' ? args.deal_id : ''
  const stageName = typeof args.stage_name === 'string' ? args.stage_name.trim() : ''
  if (!dealId || !stageName) {
    return JSON.stringify({ error: 'missing deal_id or stage_name' })
  }

  // The deal must belong to this account AND this contact — the agent
  // is only allowed to move the customer currently in conversation.
  const { data: deal, error: dealErr } = await db
    .from('deals')
    .select('id, pipeline_id, title, status, contact_id, stage_id')
    .eq('id', dealId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (dealErr || !deal || deal.contact_id !== contactId) {
    return JSON.stringify({
      error: 'deal_not_found',
      hint: "The deal does not exist or does not belong to this customer — use get_contact_deals to list valid ids.",
    })
  }

  const { data: stages, error: stagesErr } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', deal.pipeline_id)
  if (stagesErr) {
    console.error('[ai-tools] stage lookup failed:', stagesErr)
    return JSON.stringify({ error: 'database_error' })
  }
  const normalizedTarget = stageName.toLowerCase()
  const target = (stages ?? []).find((s) => s.name.toLowerCase() === normalizedTarget)
  if (!target) {
    return JSON.stringify({
      error: 'stage_not_found',
      available_stages: (stages ?? []).map((s) => s.name),
    })
  }

  if (target.id === deal.stage_id) {
    return JSON.stringify({
      ok: true,
      already_in_stage: true,
      deal_id: deal.id,
      stage: target.name,
    })
  }

  const { error: updateErr } = await db
    .from('deals')
    .update({ stage_id: target.id, updated_at: new Date().toISOString() })
    .eq('id', deal.id)
    .eq('account_id', accountId)
  if (updateErr) {
    console.error('[ai-tools] moveDealToStage update failed:', updateErr)
    return JSON.stringify({ error: 'database_error' })
  }

  return JSON.stringify({
    ok: true,
    deal_id: deal.id,
    title: deal.title,
    moved_from: null, // old stage name not loaded — the model already knows it
    stage: target.name,
  })
}
