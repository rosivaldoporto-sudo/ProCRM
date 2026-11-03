import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  checkDistributedRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import { loadAiConfig } from '@/lib/ai/config'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { organizePipeline, applyOrganizeResults } from '@/lib/ai/organize'
import { AiError } from '@/lib/ai/types'

export const maxDuration = 120

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent')

    const userLimit = await checkDistributedRateLimit(
      `ai-organize:${userId}`,
      RATE_LIMITS.aiOrganize
    )
    if (!userLimit.success) return rateLimitResponse(userLimit)

    const accountLimit = await checkDistributedRateLimit(
      `ai-organize-acct:${accountId}`,
      RATE_LIMITS.aiOrganizeAccount
    )
    if (!accountLimit.success) return rateLimitResponse(accountLimit)

    const body = await request.json().catch(() => null)
    const pipelineId =
      body && typeof body.pipeline_id === 'string' ? body.pipeline_id : ''
    const dryRun = body?.dry_run === true

    if (!pipelineId) {
      return NextResponse.json(
        { error: 'Informe o funil' },
        { status: 400 }
      )
    }

    const { data: pipeline, error: pipeErr } = await supabase
      .from('pipelines')
      .select('id')
      .eq('id', pipelineId)
      .maybeSingle()

    if (pipeErr) {
      console.error('[ai/organize-pipeline] pipeline lookup error:', pipeErr)
      return NextResponse.json(
        { error: 'Falha ao carregar o funil' },
        { status: 500 }
      )
    }
    if (!pipeline) {
      return NextResponse.json(
        { error: 'Funil não encontrado' },
        { status: 404 }
      )
    }

    const { data: stages } = await supabase
      .from('pipeline_stages')
      .select('id, name')
      .eq('pipeline_id', pipelineId)
      .order('position')

    if (!stages || stages.length < 2) {
      return NextResponse.json(
        { error: 'O funil precisa de pelo menos 2 etapas para ser organizado' },
        { status: 400 }
      )
    }

    const config = await loadAiConfig(supabaseAdmin(), accountId).catch(
      (err) => {
        console.error('[ai/organize-pipeline] loadAiConfig error:', err)
        throw new AiError('A chave de API salva não pode ser descriptografada.', {
          code: 'key_decrypt_failed',
          status: 400,
        })
      }
    )
    if (!config) {
      return NextResponse.json(
        {
          error:
            'O assistente de IA não está configurado. Ative em Configurações → Assistente de IA.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      )
    }

    console.log(
      `[ai/organize-pipeline] starting organize for pipeline ${pipelineId}, account ${accountId}`
    )

    const results = await organizePipeline({
      db: supabaseAdmin(),
      accountId,
      pipelineId,
      config,
    })

    if (results.length === 0) {
      return NextResponse.json({
        recommendations: [],
        moved: 0,
        message: 'Nenhum negócio aberto com conversa neste funil.',
      })
    }

    if (dryRun) {
      return NextResponse.json({ recommendations: results, moved: 0 })
    }

    const stageIdByName = new Map(
      stages.map((s) => [s.name.toLowerCase(), s.id])
    )
    const movedCount = await applyOrganizeResults(
      supabaseAdmin(),
      accountId,
      results,
      stageIdByName
    )

    console.log(
      `[ai/organize-pipeline] completed: ${results.length} analyzed, ${movedCount} moved`
    )

    return NextResponse.json({ recommendations: results, moved: movedCount })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      )
    }
    console.error('[ai/organize-pipeline] unhandled error:', err)
    return toErrorResponse(err)
  }
}
