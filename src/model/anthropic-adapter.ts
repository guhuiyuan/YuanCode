/**
 * Anthropic-compatible adapter.
 *
 * Wraps the official `@anthropic-ai/sdk` client. The base URL is configurable,
 * so the same adapter covers:
 *
 *   - anthropic  → https://api.anthropic.com
 *   - minimax    → https://api.minimaxi.com/anthropic
 *   - custom     → any user-provided OpenAI/Anthropic-compatible endpoint
 *
 * Only Anthropic-protocol endpoints are supported here. For OpenAI-compatible
 * endpoints use the openai-adapter.
 */
import Anthropic from '@anthropic-ai/sdk'
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

export interface AnthropicAdapterOptions {
  apiKey: string
  baseUrl?: string
  defaultModel: string
  maxTokens?: number
  /** Extra headers (e.g. for proxies). */
  defaultHeaders?: Record<string, string>
}

export class AnthropicAdapter implements Provider {
  readonly name: string = 'anthropic-compat'
  private readonly client: Anthropic
  private readonly defaultModel: string
  private readonly maxTokens: number

  constructor(opts: AnthropicAdapterOptions) {
    if (!opts.apiKey) {
      throw new ProviderError('AnthropicAdapter: apiKey is required')
    }
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseUrl,
      defaultHeaders: opts.defaultHeaders,
    })
    this.defaultModel = opts.defaultModel
    this.maxTokens = opts.maxTokens ?? 8192
  }

  async healthcheck(): Promise<string | null> {
    // Cheap probe: 1-token completion
    try {
      await this.client.messages.create({
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
    const tools = req.tools?.map(toAnthropicTool)

    try {
      // Use streaming under the hood. Anthropic SDK refuses non-streaming
      // calls when max_tokens is large enough that the request could exceed
      // 10 minutes. The SDK's `messages.stream()` returns a MessageStream;
      // we collect the final aggregated message via finalMessage().
      //
      // This is a no-op for callers (loop / tests) since they only see the
      // final ChatResponse. M2 will replace this with real incremental
      // event delivery by switching the loop to call stream() directly.
      const stream = this.client.messages.stream({
        model: this.defaultModel,
        max_tokens: req.maxTokens ?? this.maxTokens,
        temperature: req.temperature,
        system: req.system ?? system,
        messages: messages.map(toAnthropicMessage),
        tools,
        stop_sequences: req.stopSequences,
      }, { signal })

      const raw = await stream.finalMessage()

      const blocks: ContentBlock[] = (raw.content ?? []).map((b) => {
        if (b.type === 'text') {
          return { type: 'text', text: b.text }
        }
        if (b.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: b.id,
            name: b.name,
            input: b.input,
          } satisfies ToolUseBlock
        }
        // thinking / redacted_thinking — surface as empty text so the model
        // still sees a well-formed assistant message
        return { type: 'text', text: '' }
      })

      const message: ChatMessage = {
        role: 'assistant',
        content: blocks,
        tool_calls: blocks.filter((b): b is ToolUseBlock => b.type === 'tool_use'),
      }

      return {
        message,
        stopReason: toStopReason(raw.stop_reason),
        usage: {
          inputTokens: raw.usage?.input_tokens ?? 0,
          outputTokens: raw.usage?.output_tokens ?? 0,
          cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: raw.usage?.cache_creation_input_tokens ?? 0,
        },
      }
    } catch (e) {
      if (e instanceof Anthropic.APIError) {
        throw new ProviderError(
          `Anthropic API error ${e.status}: ${e.message}`,
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

function toAnthropicTool(t: ToolSpec): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool.InputSchema,
  }
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  if (typeof m.content === 'string') {
    return { role: m.role as 'user' | 'assistant', content: m.content }
  }
  // ContentBlock[]
  const blocks: Anthropic.ContentBlockParam[] = m.content.map((b) => {
    if (b.type === 'text') return { type: 'text', text: b.text }
    if (b.type === 'tool_use') {
      return {
        type: 'tool_use',
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Anthropic.ToolUseBlockParam['input'],
      }
    }
    // tool_result
    if (typeof b.content === 'string') {
      return {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
        is_error: b.is_error,
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: b.tool_use_id,
      content: b.content.map((tb) =>
        tb.type === 'text' ? { type: 'text', text: tb.text } : { type: 'text', text: '' },
      ),
      is_error: b.is_error,
    }
  })
  return { role: m.role as 'user' | 'assistant', content: blocks }
}

function toStopReason(s: string | null | undefined): StopReason {
  switch (s) {
    case 'end_turn':
      return 'end_turn'
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'refusal':
      return 'end_turn' // treat refusal as terminal end_turn
    default:
      return 'end_turn'
  }
}
