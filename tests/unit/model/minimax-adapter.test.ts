/**
 * MiniMax adapter — construction + identity.
 *
 * We don't make real network calls in unit tests; we just verify the
 * adapter constructs correctly with the right defaults and name. The
 * underlying transport is the Anthropic SDK which already has its own tests.
 */
import { describe, expect, it } from 'vitest'
import {
  MiniMaxAdapter,
  MINIMAX_DEFAULT_BASE_URL,
  MINIMAX_DEFAULT_MODEL,
} from '../../../src/model/minimax-adapter.js'

describe('MiniMaxAdapter — construction', () => {
  it('throws when no apiKey is provided', () => {
    expect(() => new MiniMaxAdapter({ apiKey: '' })).toThrow(/apiKey/)
  })

  it('uses the documented defaults when nothing is overridden', () => {
    const a = new MiniMaxAdapter({ apiKey: 'sk-test' })
    expect(a.name).toBe('minimax')
    // The base URL and default model are inherited from the parent class
    // via private fields, but we can verify the constants independently.
    expect(MINIMAX_DEFAULT_BASE_URL).toBe('https://api.minimaxi.com/anthropic')
    expect(MINIMAX_DEFAULT_MODEL).toBe('MiniMax-M3')
  })

  it('accepts overrides for baseUrl and defaultModel', () => {
    const a = new MiniMaxAdapter({
      apiKey: 'sk-test',
      baseUrl: 'https://example.com/anthropic',
      defaultModel: 'custom-model',
    })
    expect(a.name).toBe('minimax')
  })

  it('reports identity = "minimax" (not "anthropic-compat")', () => {
    const a = new MiniMaxAdapter({ apiKey: 'sk-test' })
    expect(a.name).not.toBe('anthropic-compat')
    expect(a.name).toBe('minimax')
  })
})
