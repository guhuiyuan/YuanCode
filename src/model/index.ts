/**
 * Model layer barrel — re-exports the public API.
 */
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ContentBlock,
  Provider,
  Role,
  StopReason,
  StreamEvent,
  TextBlock,
  ToolResultBlock,
  ToolSpec,
  ToolUseBlock,
  Usage,
} from './provider.js'
export { ProviderError } from './provider.js'
export { AnthropicAdapter } from './anthropic-adapter.js'
export type { AnthropicAdapterOptions } from './anthropic-adapter.js'
export { MiniMaxAdapter, MINIMAX_DEFAULT_BASE_URL, MINIMAX_DEFAULT_MODEL } from './minimax-adapter.js'
export type { MiniMaxAdapterOptions } from './minimax-adapter.js'
export { OpenAIAdapter } from './openai-adapter.js'
export type { OpenAIAdapterOptions } from './openai-adapter.js'
export { createProvider, resolveApiKey } from './factory.js'
