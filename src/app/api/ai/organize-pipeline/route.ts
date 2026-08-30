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

export const maxDuration = 60

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
        { error: 'pipeline_id is required' },
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
        { error: 'Failed to load pipeline' },
        { status: 500 }
      )
    }
    if (!pipeline) {
      return NextResponse.json(
        { error: 'Pipeline not found' },
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
        { error: 'Pipeline needs at least 2 stages to organize' },
        { status: 400 }
      )
    }

    const config = await loadAiConfig(supabaseAdmin(), accountId).catch(
      (err) => {
        console.error('[ai/organize-pipeline] loadAiConfig error:', err)
        throw new AiError('Stored API key could not be decrypted.', {
          code: 'key_decrypt_failed',
          status: 400,
        })
      }
    )
    if (!config) {
      return NextResponse.json(
        {
          error:
            'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      )
    }

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
        message: 'No open deals with conversations found in this pipeline.',
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

    return NextResponse.json({ recommendations: results, moved: movedCount })
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      )
    }
    return toErrorResponse(err)
  }
}
