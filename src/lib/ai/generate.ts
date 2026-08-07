import {
  AiError,
  type AiConfig,
  type AiToolCall,
  type AiToolDefinition,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
  type ToolHistoryEntry,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'
import type { ProviderArgs } from './providers/shared'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/** Max tool-calling rounds in one generation — a runaway loop (model
 *  keeps requesting tools) must not burn the account's own key. */
const MAX_TOOL_ROUNDS = 4

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

export interface GenerateWithToolsArgs extends GenerateArgs {
  /** Function-calling tools offered to the model. */
  tools: AiToolDefinition[]
  /** Runs one tool invocation. Must never throw — return a stringified
   *  JSON result (including error shapes) so the loop can feed it back
   *  to the model. */
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>
}

/**
 * Like `generateReply`, but with a tool-calling loop: the model may
 * request tools, we run them via `executeTool` and feed the results
 * back, repeating until the model produces a final text (or hits
 * `MAX_TOOL_ROUNDS`, in which case we fall back to whatever text it
 * produced alongside its last tool call — an empty one becomes a
 * handoff, same as a normal empty reply). Usage is summed across all
 * rounds.
 */
export async function generateReplyWithTools(
  args: GenerateWithToolsArgs,
): Promise<GenerateResult> {
  const { config, systemPrompt, messages, tools, executeTool } = args
  const timeoutMs = aiRequestTimeoutMs()

  const toolHistory: ToolHistoryEntry[] = []
  const usages: AiUsage[] = []

  const callProvider = async (): Promise<{
    text: string
    usage: AiUsage | null
    toolCalls?: AiToolCall[]
  }> => {
    const providerArgs: ProviderArgs = {
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt,
      messages,
      timeoutMs,
      tools,
      toolHistory: toolHistory.length > 0 ? toolHistory : undefined,
    }
    let result: { text: string; usage: AiUsage | null; toolCalls?: AiToolCall[] }
    switch (config.provider) {
      case 'openai':
        result = await generateOpenAi(providerArgs)
        break
      case 'anthropic':
        result = await generateAnthropic(providerArgs)
        break
      default:
        throw new AiError(`Unsupported AI provider: ${config.provider}`, {
          code: 'unsupported_provider',
          status: 400,
        })
    }
    if (result.usage) usages.push(result.usage)
    return result
  }

  let result = await callProvider()
  let rounds = 0

  while (result.toolCalls && result.toolCalls.length > 0 && rounds < MAX_TOOL_ROUNDS) {
    rounds++
    const results = await Promise.all(
      result.toolCalls.map((call) => executeTool(call.name, call.arguments)),
    )
    toolHistory.push({ text: result.text, calls: result.toolCalls, results })
    result = await callProvider()
  }

  if (result.toolCalls && result.toolCalls.length > 0) {
    // Loop cap hit — the model still wants tools. Keep the text it
    // produced alongside the last request; empty becomes a handoff.
    console.warn('[ai] tool-calling loop capped at', MAX_TOOL_ROUNDS, 'rounds')
  }

  return parseGeneration(result.text, sumUsages(usages))
}

function sumUsages(items: AiUsage[]): AiUsage | null {
  if (items.length === 0) return null
  return {
    promptTokens: items.reduce((a, u) => a + u.promptTokens, 0),
    completionTokens: items.reduce((a, u) => a + u.completionTokens, 0),
    totalTokens: items.reduce((a, u) => a + u.totalTokens, 0),
  }
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
