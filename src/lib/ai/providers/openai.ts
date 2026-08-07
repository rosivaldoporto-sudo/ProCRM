import { AiError, type AiToolCall, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

interface OpenAiToolCall {
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAiResponse {
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiToolCall[] } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

/** Map a provider-agnostic tool call into the assistant message shape
 *  OpenAI needs to continue the loop. */
function openAiToolHistory(toolHistory: NonNullable<ProviderArgs['toolHistory']>) {
  const turns: Record<string, unknown>[] = []
  for (const round of toolHistory) {
    const calls = round.calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: JSON.stringify(c.arguments) },
    }))
    turns.push({
      role: 'assistant',
      content: round.text || null,
      tool_calls: calls,
    })
    calls.forEach((call, i) => {
      turns.push({
        role: 'tool',
        tool_call_id: call.id,
        content: round.results[i] ?? '',
      })
    })
  }
  return turns
}

/**
 * Call OpenAI's Chat Completions endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`). When `tools` are offered, the response's
 * `tool_calls` are surfaced on the result for the caller to execute.
 */
export async function generateOpenAi(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolHistory } = args

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      ...(toolHistory && toolHistory.length > 0
        ? openAiToolHistory(toolHistory)
        : mergeConsecutive(messages)),
    ],
    max_completion_tokens: MAX_OUTPUT_TOKENS,
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  let res: Response
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI', res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiResponse | null
  const message = data?.choices?.[0]?.message
  const rawToolCalls = message?.tool_calls ?? []
  const toolCalls: AiToolCall[] = rawToolCalls
    .filter((tc) => tc?.function?.name)
    .map((tc, i) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = tc.function?.arguments
          ? (JSON.parse(tc.function.arguments) as Record<string, unknown>)
          : {}
      } catch {
        // Malformed JSON args from the model — surface as empty so the
        // executor can report a clean error back into the loop.
      }
      return {
        id: tc.id ?? `tool_${i}`,
        name: tc.function?.name ?? '',
        arguments: parsed,
      }
    })

  const text = message?.content ?? ''
  // An empty reply is only an error when the model didn't ask for
  // tools either — a pure tool turn legitimately has no text.
  if (!text.trim() && toolCalls.length === 0) {
    throw new AiError('OpenAI returned an empty response.', {
      code: 'empty_response',
    })
  }
  const usage = normalizeUsage({
    prompt: data?.usage?.prompt_tokens,
    completion: data?.usage?.completion_tokens,
    total: data?.usage?.total_tokens,
  })
  return { text: text.trim(), usage, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}
