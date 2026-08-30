import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiConfig, ChatMessage } from './types'
import { generateReply } from './generate'
import { logAiUsage } from './usage'

interface DealWithContext {
  dealId: string
  title: string
  currentStageId: string
  currentStageName: string
  conversationId: string | null
}

interface StageInfo {
  id: string
  name: string
}

interface AiRecommendation {
  deal_id: string
  title: string
  stage_name: string
  reason: string
}

export interface OrganizeResult {
  deal_id: string
  title: string
  from_stage: string
  to_stage: string
  reason: string
  moved: boolean
}

interface OrganizePipelineArgs {
  db: SupabaseClient
  accountId: string
  pipelineId: string
  config: AiConfig
}

export async function organizePipeline(
  args: OrganizePipelineArgs,
): Promise<OrganizeResult[]> {
  const { db, accountId, pipelineId, config } = args

  const { data: stages } = await db
    .from('pipeline_stages')
    .select('id, name')
    .eq('pipeline_id', pipelineId)
    .order('position')

  const stageList = (stages ?? []) as StageInfo[]
  const stageNameById = new Map(stageList.map((s) => [s.id, s.name]))
  const stageIdByName = new Map(stageList.map((s) => [s.name.toLowerCase(), s.id]))

  const { data: deals } = await db
    .from('deals')
    .select('id, title, stage_id, conversation_id')
    .eq('account_id', accountId)
    .eq('pipeline_id', pipelineId)
    .eq('status', 'open')

  const dealsWithContext: DealWithContext[] = (deals ?? []).map((d: Record<string, unknown>) => ({
    dealId: d.id as string,
    title: d.title as string,
    currentStageId: d.stage_id as string,
    currentStageName: stageNameById.get(d.stage_id as string) ?? '',
    conversationId: d.conversation_id as string | null,
  }))

  if (dealsWithContext.length === 0) return []

  const stageListStr = stageList.map((s) => `  - "${s.name}"`).join('\n')
  const results: OrganizeResult[] = []

  for (const deal of dealsWithContext) {
    if (!deal.conversationId) {
      results.push({
        deal_id: deal.dealId,
        title: deal.title,
        from_stage: deal.currentStageName,
        to_stage: deal.currentStageName,
        reason: 'Sem conversa associada',
        moved: false,
      })
      continue
    }

    const { data: msgs } = await db
      .from('messages')
      .select('sender_type, content_text')
      .eq('conversation_id', deal.conversationId)
      .eq('content_type', 'text')
      .order('created_at', { ascending: false })
      .limit(30)

    const messages: ChatMessage[] = ((msgs ?? []) as Array<{ sender_type: string; content_text: string | null }>)
      .reverse()
      .filter((m) => m.content_text?.trim())
      .map((m) => ({
        role: m.sender_type === 'customer' ? ('user' as const) : ('assistant' as const),
        content: m.content_text!.trim(),
      }))

    if (messages.length === 0) {
      results.push({
        deal_id: deal.dealId,
        title: deal.title,
        from_stage: deal.currentStageName,
        to_stage: deal.currentStageName,
        reason: 'Sem mensagens de texto na conversa',
        moved: false,
      })
      continue
    }

    const conversationText = messages
      .map((m) => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.content}`)
      .join('\n')

    const systemPrompt = [
      'Você é um analista de vendas inteligente. Analise a conversa de atendimento ao cliente e determine em qual etapa do pipeline de vendas o card deveria estar.',
      'Considere o conteúdo da conversa, o nível de interesse do cliente, se houve proposta, negociação, fechamento, etc.',
      'Responda APENAS com um JSON válido (sem markdown, sem ```), no formato:',
      '{ "stage_name": "<nome exato da etapa>", "reason": "<breve justificativa em português>" }',
      '',
      'Etapas disponíveis:',
      stageListStr,
      '',
      'IMPORTANTE: O stage_name deve ser exatamente um dos nomes listados acima. Não invente nomes.',
    ].join('\n')

    const userPrompt = `Conversa com o cliente sobre "${deal.title}":\n\n${conversationText}\n\nEtapa atual: "${deal.currentStageName}"\nQual é a etapa correta para este card?`

    try {
      const { text, usage } = await generateReply({
        config,
        systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      })

      void logAiUsage(db, {
        accountId,
        conversationId: deal.conversationId,
        mode: 'auto_reply',
        provider: config.provider,
        model: config.model,
        usage,
      })

      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
      const parsed = JSON.parse(cleaned) as AiRecommendation
      const targetName = parsed.stage_name?.trim()
      const targetId = targetName ? stageIdByName.get(targetName.toLowerCase()) : null

      if (targetId && targetId !== deal.currentStageId) {
        results.push({
          deal_id: deal.dealId,
          title: deal.title,
          from_stage: deal.currentStageName,
          to_stage: targetName!,
          reason: parsed.reason ?? '',
          moved: false,
        })
      } else {
        results.push({
          deal_id: deal.dealId,
          title: deal.title,
          from_stage: deal.currentStageName,
          to_stage: deal.currentStageName,
          reason: targetId ? 'Já está na etapa correta' : (parsed.reason ?? 'Sem recomendação'),
          moved: false,
        })
      }
    } catch (err) {
      console.error('[ai-organize] failed for deal', deal.dealId, err)
      results.push({
        deal_id: deal.dealId,
        title: deal.title,
        from_stage: deal.currentStageName,
        to_stage: deal.currentStageName,
        reason: 'Erro ao analisar conversa',
        moved: false,
      })
    }
  }

  return results
}

export async function applyOrganizeResults(
  db: SupabaseClient,
  accountId: string,
  results: OrganizeResult[],
  stageIdByName: Map<string, string>,
): Promise<number> {
  let movedCount = 0
  for (const r of results) {
    if (r.from_stage === r.to_stage) continue
    const targetId = stageIdByName.get(r.to_stage.toLowerCase())
    if (!targetId) continue

    const { error } = await db
      .from('deals')
      .update({ stage_id: targetId, updated_at: new Date().toISOString() })
      .eq('id', r.deal_id)
      .eq('account_id', accountId)

    if (!error) {
      r.moved = true
      movedCount++
    }
  }
  return movedCount
}
