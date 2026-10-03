/**
 * MiniMax adapter — explicit subclass of AnthropicAdapter.
 *
 * MiniMax exposes the Anthropic Messages protocol at
 *   https://api.minimaxi.com/anthropic
 * so the wire format is identical to Anthropic's. The reason this exists as
 * its own class (instead of just routing through the factory's "minimax →
 * AnthropicAdapter" mapping):
 *
 *   1. **Defaults**: locks the base URL + default headers so a user with no
 *      config can still get a working setup.
 *   2. **Identity**: the adapter reports `name = 'minimax'` for logs / UI
 *      status, which matches the user's mental model ("I'm talking to
 *      MiniMax-M3, not some abstract Anthropic endpoint").
 *   3. **Future divergence**: if MiniMax adds MiniMax-specific extensions
 *      (rate-limit headers, custom thinking, etc.) we have a single place
 *      to put them without polluting the generic AnthropicAdapter.
 */
import { AnthropicAdapter } from './anthropic-adapter.js'
import type { AnthropicAdapterOptions } from './anthropic-adapter.js'

export const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimaxi.com/anthropic'
export const MINIMAX_DEFAULT_MODEL = 'MiniMax-M3'

export interface MiniMaxAdapterOptions extends Omit<AnthropicAdapterOptions, 'baseUrl' | 'defaultModel'> {
  baseUrl?: string
  defaultModel?: string
}

export class MiniMaxAdapter extends AnthropicAdapter {
  constructor(opts: MiniMaxAdapterOptions = { apiKey: '' }) {
    const apiKey = opts.apiKey ?? process.env.YUANCODE_API_KEY ?? ''
    if (!apiKey) {
      // Defer the throw to chat() so the harness can boot before a key is set
      // (matches AnthropicAdapter's contract: apiKey is required at construction).
      throw new Error('MiniMaxAdapter: apiKey is required (set YUANCODE_API_KEY)')
    }
    super({
      ...opts,
      apiKey,
      baseUrl: opts.baseUrl ?? MINIMAX_DEFAULT_BASE_URL,
      defaultModel: opts.defaultModel ?? MINIMAX_DEFAULT_MODEL,
    })
  }

  // Override the readonly `name` from the base class.
  override readonly name: string = 'minimax'
}
