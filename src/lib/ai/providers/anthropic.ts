import {
  AiError,
  type AiToolCall,
  type ChatMessage,
  type ProviderResult,
} from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

interface AnthropicContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[]
  stop_reason?: string | null
  usage?: { input_tokens?: number; output_tokens?: number }
}

/**
 * Anthropic's Messages API requires strictly alternating roles that
 * begin with `user`. Merge consecutive turns, then drop any leading
 * assistant turns (an agent greeting before the customer said anything)
 * so the transcript always starts on the customer. Guarantees a valid,
 * non-empty payload.
 */
function normalizeForAnthropic(messages: ChatMessage[]): ChatMessage[] {
  const merged = mergeConsecutive(messages)
  while (merged.length > 0 && merged[0].role === 'assistant') {
    merged.shift()
  }
  if (merged.length === 0) {
    return [{ role: 'user', content: '(The customer has not sent a message yet.)' }]
  }
  return merged
}

/** Replay completed tool-calling rounds in Anthropic's block format:
 *  assistant turns carrying `tool_use` blocks, then a user turn with
 *  the corresponding `tool_result` blocks. */
function anthropicToolHistory(toolHistory: NonNullable<ProviderArgs['toolHistory']>) {
  const turns: { role: 'user' | 'assistant'; content: unknown[] }[] = []
  for (const round of toolHistory) {
    const blocks: AnthropicContentBlock[] = []
    if (round.text) blocks.push({ type: 'text', text: round.text })
    for (const call of round.calls) {
      blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
    }
    turns.push({ role: 'assistant', content: blocks })
    turns.push({
      role: 'user',
      content: round.calls.map((call, i) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: round.results[i] ?? '',
      })),
    })
  }
  return turns
}

/**
 * Call Anthropic's Messages endpoint with the caller's own key.
 * Returns the raw assistant text + token usage (handoff parsing happens
 * in `generateReply`). When `tools` are offered, `tool_use` blocks are
 * surfaced on the result for the caller to execute.
 */
export async function generateAnthropic(args: ProviderArgs): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, tools, toolHistory } = args

  const body: Record<string, unknown> = {
    model,
    system: systemPrompt,
    max_tokens: MAX_OUTPUT_TOKENS,
    messages: [
      ...(toolHistory && toolHistory.length > 0
        ? anthropicToolHistory(toolHistory)
        : normalizeForAnthropic(messages)),
    ],
  }
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }))
  }

  let res: Response
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('Anthropic', res)
  }

  const data = (await res.json().catch(() => null)) as AnthropicResponse | null
  const text = data?.content
    ?.filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()

  const toolCalls: AiToolCall[] = (data?.content ?? [])
    .filter((b) => b.type === 'tool_use' && b.id && b.name)
    .map((b, i) => ({
      id: b.id ?? `tool_${i}`,
      name: b.name ?? '',
      arguments:
        b.input && typeof b.input === 'object' && !Array.isArray(b.input)
          ? (b.input as Record<string, unknown>)
          : {},
    }))

  // A pure tool turn has no text but a stop_reason of tool_use — only
  // treat as empty when the model asked for nothing at all.
  if (!text && toolCalls.length === 0) {
    throw new AiError('Anthropic returned an empty response.', {
      code: 'empty_response',
    })
  }
  // Anthropic reports input/output but no total — normalizeUsage sums.
  const usage = normalizeUsage({
    prompt: data?.usage?.input_tokens,
    completion: data?.usage?.output_tokens,
  })
  return { text: text ?? '', usage, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
}
