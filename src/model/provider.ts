/**
 * Provider-agnostic model interface.
 *
 * Every provider adapter (Anthropic-compatible, OpenAI-compatible, …) implements
 * the same `Provider` interface so the agent loop never depends on a specific
 * SDK. Adapters translate between the wire format of their SDK and the
 * normalized `ChatMessage` / `ContentBlock` types below.
 *
 * Why a normalized type rather than passing SDK messages around:
 *
 *   1. The loop, tool registry, and TUI all consume the same shape.
 *   2. Swapping providers (e.g. for cost / latency / quality reasons) is a
 *      one-line config change.
 *   3. Tests can hand-build messages without standing up an SDK.
 */
import type { JsonSchema } from '../core/zod-to-json.js'

// --------------------------------------------------------------------------
// Messages
// --------------------------------------------------------------------------

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | TextBlock[]
  is_error?: boolean
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock

export interface ChatMessage {
  role: Role
  content: string | ContentBlock[]
  /** Set on role='tool' messages. */
  tool_call_id?: string
  /** Set on role='assistant' messages — list of tool calls issued. */
  tool_calls?: ToolUseBlock[]
}

// --------------------------------------------------------------------------
// Tool spec (sent to the model)
// --------------------------------------------------------------------------

export interface ToolSpec {
  name: string
  description: string
  input_schema: JsonSchema
}

// --------------------------------------------------------------------------
// Request / response
// --------------------------------------------------------------------------

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ToolSpec[]
  maxTokens?: number
  temperature?: number
  /** Optional system message override. If omitted, the adapter may prepend its own. */
  system?: string
  /** Stop sequences. */
  stopSequences?: string[]
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'aborted'

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** Cache hit tokens (Anthropic). Adapter may report 0 if N/A. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface ChatResponse {
  message: ChatMessage
  stopReason: StopReason
  usage: Usage
  /**
   * The model that actually answered. Providers should set this so the
   * CostGuard (M7) can record against the right pricing row. When
   * missing, the CostGuard falls back to its primary model.
   */
  model?: string
}

// --------------------------------------------------------------------------
// Streaming events (M2 — the type is here so the loop can be designed
// against it now; the adapters implement it incrementally)
// --------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'message_start'; messageId: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partialJson: string }
  | { type: 'tool_use_end'; id: string; input: unknown }
  | { type: 'message_end'; stopReason: StopReason; usage: Usage }

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export interface Provider {
  /** Adapter identifier — useful for logs and UI status. */
  readonly name: string
  /** Make a chat request. Throws on transport / auth errors. */
  chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>
  /** Stream events. May be unsupported by some adapters (falls back to chat + replay). */
  stream?(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
  /** Probe the provider — returns null on OK or an error message. */
  healthcheck(): Promise<string | null>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
