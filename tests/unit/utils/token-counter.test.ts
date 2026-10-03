/**
 * TokenCounter — tiktoken + char-fallback estimation.
 */
import { describe, expect, it } from 'vitest'
import {
  _resetTokenCounter,
  countTokens,
  countMessageTokens,
} from '../../../src/utils/token-counter.js'

describe('countTokens — basic', () => {
  it('returns 0 for empty strings', () => {
    expect(countTokens('')).toBe(0)
  })

  it('returns a positive count for non-empty strings', () => {
    const n = countTokens('hello world this is a test')
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(100)
  })

  it('handles unicode without throwing', () => {
    expect(() => countTokens('你好 🌍 日本語 — café')).not.toThrow()
  })

  it('produces a stable count for the same input', () => {
    const a = countTokens('The quick brown fox jumps over the lazy dog.')
    const b = countTokens('The quick brown fox jumps over the lazy dog.')
    expect(a).toBe(b)
  })

  it('larger inputs use more tokens', () => {
    const small = countTokens('hi')
    const big = countTokens('hi '.repeat(50).trim())
    expect(big).toBeGreaterThan(small)
  })
})

describe('countMessageTokens — message shape', () => {
  it('includes per-message overhead', () => {
    const one = countMessageTokens([{ role: 'user', content: 'hi' }])
    const two = countMessageTokens([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
    expect(two).toBeGreaterThan(one)
  })

  it('counts tool_use blocks', () => {
    const a = countMessageTokens([{ role: 'user', content: 'do it' }])
    const b = countMessageTokens([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'x', name: 'bash', input: { cmd: 'ls' } }],
      },
    ])
    expect(b).toBeGreaterThan(a)
  })

  it('counts tool_result blocks with string content', () => {
    const n = countMessageTokens([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: 'OK',
            is_error: false,
          },
        ],
      },
    ])
    expect(n).toBeGreaterThan(4)
  })

  it('counts tool_result blocks with array content', () => {
    const n = countMessageTokens([
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'x',
            content: [{ type: 'text', text: 'multi-line result' }],
            is_error: false,
          },
        ],
      },
    ])
    expect(n).toBeGreaterThan(4)
  })
})

describe('_resetTokenCounter', () => {
  it('does not throw when called fresh', () => {
    expect(() => _resetTokenCounter()).not.toThrow()
  })

  it('can be called repeatedly', () => {
    _resetTokenCounter()
    _resetTokenCounter()
    _resetTokenCounter()
    expect(countTokens('x')).toBeGreaterThan(0)
  })
})