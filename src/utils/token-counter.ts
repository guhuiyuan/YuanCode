/**
 * Token counter — tiktoken-based with a heuristic fallback.
 *
 * For provider-agnostic budgeting we want a single number that approximates
 * how many tokens a message list will cost. tiktoken (o200k_base) is close
 * enough for Anthropic and OpenAI models, and vastly more accurate than the
 * "characters / 4" rule of thumb.
 *
 * If tiktoken fails (rare — usually network on first model download), we
 * fall back to a char-based heuristic so the harness still functions.
 */
import type { ChatMessage, ContentBlock } from '../model/provider.js'

interface TiktokenLike {
  encode(text: string): number[]
  free?(): void
}

interface TiktokenModule {
  get_encoding(name: string): TiktokenLike
  encoding_for_model?(model: string): TiktokenLike
}

let cached: TiktokenLike | null = null
let tried = false
let failed = false

function get(): TiktokenLike | null {
  if (cached) return cached
  if (failed) return null
  if (tried) return cached
  tried = true
  try {
    // dynamic require so the bundled dist doesn't break on platforms without
    // tiktoken's WASM available at runtime
    const mod = require('tiktoken') as TiktokenModule
    cached = mod.get_encoding('o200k_base')
    return cached
  } catch {
    failed = true
    return null
  }
}

/** Reset the cache — used by tests. */
export function _resetTokenCounter(): void {
  cached?.free?.()
  cached = null
  tried = false
  failed = false
}

/** Estimate the number of tokens in a single string. */
export function countTokens(text: string): number {
  if (!text) return 0
  const enc = get()
  if (enc) return enc.encode(text).length
  // Fallback: ~1 token per 4 chars (English average). Slightly under-counts
  // for code, but good enough as a guard-rail.
  return Math.ceil(text.length / 4)
}

/**
 * Estimate the total tokens used by a message list — matches Anthropic's
 * billing formula:
 *
 *   - Each message has a ~4-token overhead (role + separators)
 *   - tool_use / tool_result blocks add a few extra tokens each
 */
export function countMessageTokens(messages: ChatMessage[]): number {
  let total = 0
  // Per-message overhead for the role + framing
  total += messages.length * 4
  for (const m of messages) {
    total += countContent(m.content)
  }
  return total
}

function countContent(content: ChatMessage['content']): number {
  if (typeof content === 'string') return countTokens(content)
  let total = 0
  for (const b of content as ContentBlock[]) {
    total += 4 // block framing overhead
    if (b.type === 'text') total += countTokens(b.text)
    else if (b.type === 'tool_use') total += countTokens(b.name + JSON.stringify(b.input ?? {}))
    else if (b.type === 'tool_result') {
      if (typeof b.content === 'string') total += countTokens(b.content)
      else {
        for (const tb of b.content) total += countTokens(tb.text)
      }
    }
  }
  return total
}
