/**
 * Provider factory — picks the right adapter based on config.
 *
 * Mapping:
 *
 *   minimax   → MiniMaxAdapter (Anthropic protocol) at api.minimaxi.com/anthropic
 *   anthropic → AnthropicAdapter at api.anthropic.com
 *   openai    → OpenAIAdapter at api.openai.com
 *   custom    → AnthropicAdapter if baseUrl looks like an anthropic-compat
 *               endpoint, else OpenAIAdapter
 *
 * API keys flow from: env (YUANCODE_API_KEY) > config.model.apiKey.
 */
import type { ModelConfig } from '../config/schema.js'
import type { Provider } from './provider.js'
import { AnthropicAdapter } from './anthropic-adapter.js'
import { MiniMaxAdapter, MINIMAX_DEFAULT_BASE_URL } from './minimax-adapter.js'
import { OpenAIAdapter } from './openai-adapter.js'
import { ProviderError } from './provider.js'

const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1'

export function resolveApiKey(model: ModelConfig): string {
  if (model.apiKey) return model.apiKey
  if (process.env.YUANCODE_API_KEY) return process.env.YUANCODE_API_KEY
  throw new ProviderError(
    'No API key found. Set YUANCODE_API_KEY or model.apiKey in config.',
  )
}

export function createProvider(model: ModelConfig): Provider {
  const apiKey = resolveApiKey(model)

  switch (model.provider) {
    case 'minimax':
      return new MiniMaxAdapter({
        apiKey,
        baseUrl: model.baseUrl ?? MINIMAX_DEFAULT_BASE_URL,
        defaultModel: model.model,
        maxTokens: model.maxTokens,
      })
    case 'anthropic':
      return new AnthropicAdapter({
        apiKey,
        baseUrl: model.baseUrl ?? ANTHROPIC_DEFAULT_BASE,
        defaultModel: model.model,
        maxTokens: model.maxTokens,
      })
    case 'openai':
      return new OpenAIAdapter({
        apiKey,
        baseUrl: model.baseUrl ?? OPENAI_DEFAULT_BASE,
        defaultModel: model.model,
        maxTokens: model.maxTokens,
      })
    case 'custom': {
      if (!model.baseUrl) {
        throw new ProviderError(
          'Custom provider requires a baseUrl in config.model.baseUrl',
        )
      }
      // Heuristic: if baseUrl contains "/anthropic" → anthropic protocol.
      if (model.baseUrl.includes('/anthropic')) {
        return new AnthropicAdapter({
          apiKey,
          baseUrl: model.baseUrl,
          defaultModel: model.model,
          maxTokens: model.maxTokens,
        })
      }
      return new OpenAIAdapter({
        apiKey,
        baseUrl: model.baseUrl,
        defaultModel: model.model,
        maxTokens: model.maxTokens,
      })
    }
    default: {
      const _exhaustive: never = model.provider
      throw new ProviderError(`Unknown provider: ${String(_exhaustive)}`)
    }
  }
}
