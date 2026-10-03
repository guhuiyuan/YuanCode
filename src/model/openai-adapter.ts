/**
 * OpenAI-compatible adapter.
 *
 * Wraps the official `openai` SDK. Same provider-agnostic interface as the
 * Anthropic adapter — used for providers that speak the OpenAI Chat
 * Completions protocol (OpenAI, Together, Groq, OpenRouter, …).
 */
import OpenAI from 'openai'
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Provider,
  StopReason,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from './provider.js'
import { ProviderError } from './provider.js'

export interface OpenAIAdapterOptions {
  apiKey: string
  baseUrl?: string
  defaultModel: string
  maxTokens?: number
  defaultHeaders?: Record<string, string>
}

export class OpenAIAdapter implements Provider {
  readonly name = 'openai-compat'
  private readonly client: OpenAI
  private readonly defaultModel: string
  private readonly maxTokens: number

  constructor(opts: OpenAIAdapterOptions) {
    if (!opts.apiKey) {
      throw new ProviderError('OpenAIAdapter: apiKey is required')
    }
    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      defaultHeaders: opts.defaultHeaders,
    })
    this.defaultModel = opts.defaultModel
    this.maxTokens = opts.maxTokens ?? 8192
  }

  async healthcheck(): Promise<string | null> {
    try {
      await this.client.chat.completions.create({
        model: this.defaultModel,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      })
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const { system, messages } = splitSystem(req.messages)
    const fullSystem = [req.system, system].filter(Boolean).join('\n\n')

    try {
      const raw = await this.client.chat.completions.create({
        model: this.defaultModel,
        max_tokens: req.maxTokens ?? this.maxTokens,
        temperature: req.temperature,
        messages: [
          ...(fullSystem ? [{ role: 'system' as const, content: fullSystem }] : []),
          ...messages.map(toOpenAIMessage),
        ],
        tools: req.tools?.map(toOpenAITool),
        stop: req.stopSequences,
      }, { signal })

      const choice = raw.choices[0]
      const msg = choice?.message
      const blocks: ContentBlock[] = []

      if (msg?.content) {
        blocks.push({ type: 'text', text: msg.content })
      }
      const toolCalls = msg?.tool_calls ?? []
      for (const tc of toolCalls) {
        if (tc.type !== 'function') continue
        let input: unknown = {}
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {}
        } catch {
          input = tc.function.arguments // pass raw string for debugging
        }
        blocks.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }

      return {
        message: {
          role: 'assistant',
          content: blocks,
          tool_calls: blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'),
        },
        stopReason: toStopReason(choice?.finish_reason),
        usage: {
          inputTokens: raw.usage?.prompt_tokens ?? 0,
          outputTokens: raw.usage?.completion_tokens ?? 0,
        },
      }
    } catch (e) {
      if (e instanceof OpenAI.APIError) {
        throw new ProviderError(
          `OpenAI API error ${e.status}: ${e.message}`,
          e,
          e.status === 429 || (e.status !== undefined && e.status >= 500),
        )
      }
      if (e instanceof Error && e.name === 'AbortError') {
        throw new ProviderError('Request aborted', e, false)
      }
      throw new ProviderError(
        e instanceof Error ? e.message : String(e),
        e,
        false,
      )
    }
  }
}

// --------------------------------------------------------------------------
// Conversion helpers
// --------------------------------------------------------------------------

function splitSystem(messages: ChatMessage[]): { system: string; messages: ChatMessage[] } {
  const sysIdx = messages.findIndex((m) => m.role === 'system')
  if (sysIdx < 0) return { system: '', messages }
  const sys = messages[sysIdx]!
  const sysText =
    typeof sys.content === 'string'
      ? sys.content
      : sys.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
  return { system: sysText, messages: messages.filter((_, i) => i !== sysIdx) }
}

function toOpenAIMessage(m: ChatMessage): OpenAI.ChatCompletionMessageParam {
  if (m.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: m.tool_call_id ?? '',
      content: typeof m.content === 'string' ? m.content : '',
    }
  }
  if (typeof m.content === 'string') {
    return { role: m.role, content: m.content } as OpenAI.ChatCompletionMessageParam
  }
  // ContentBlock[]
  if (m.role === 'assistant') {
    // Mixed text + tool_use → assistant message with tool_calls
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    const toolUses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (toolUses.length) {
      return {
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input ?? {}),
          },
        })),
      }
    }
    return { role: 'assistant', content: text }
  }
  // user role — tool_result blocks flatten to a synthetic message
  if (m.role === 'user') {
    const toolResults = m.content.filter(
      (b): b is { type: 'tool_result'; tool_use_id: string; content: string | { type: 'text'; text: string }[]; is_error?: boolean } =>
        b.type === 'tool_result',
    )
    if (toolResults.length && toolResults.length === m.content.length) {
      // All tool_results — return just the first; OpenAI requires one tool msg per call.
      // The harness is responsible for emitting one user msg per tool call when using
      // OpenAI mode.
      const tr = toolResults[0]!
      return {
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: typeof tr.content === 'string'
          ? tr.content
          : tr.content.map((t) => t.text).join(''),
      }
    }
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('')
    return { role: 'user', content: text }
  }
  // fallback
  return { role: 'user', content: '' }
}

function toOpenAITool(t: ToolSpec): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }
}

function toStopReason(s: string | null | undefined): StopReason {
  switch (s) {
    case 'stop':
      return 'end_turn'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}
