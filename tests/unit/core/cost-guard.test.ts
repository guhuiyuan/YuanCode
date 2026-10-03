/**
 * CostGuard — pricing table + record/estimate/budget/breakdown/child.
 *
 * Tests are deterministic (no real LLM, no clock dependency beyond
 * `Date.now()` monotonicity). The grace window is set tight (1%) to keep
 * assertions predictable.
 */
import { describe, it, expect } from 'vitest'
import { CostGuard, DEFAULT_PRICING, computeCost } from '../../../src/core/cost-guard.js'

const PRICING = DEFAULT_PRICING

function make(opts: Partial<ConstructorParameters<typeof CostGuard>[0]> = {}) {
  return new CostGuard({
    pricing: PRICING,
    maxCostUsd: 1.0,
    model: 'MiniMax-M3',
    sessionId: 'smoke',
    graceFraction: 0.01,
    ...opts,
  })
}

describe('CostGuard', () => {
  it('records usage and accumulates cost', () => {
    const g = make()
    // 1000 input + 500 output at MiniMax-M3 ($0.10 / $0.30 per 1k)
    // expected: 0.10 + 0.15 = 0.25
    const r = g.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 500 })
    expect(r.costUsd).toBeCloseTo(0.25, 6)
    expect(r.totalCostUsd).toBeCloseTo(0.25, 6)
    expect(g.spent()).toBeCloseTo(0.25, 6)
  })

  it('estimate() matches record() to the cent', () => {
    const g = make()
    const usage = { inputTokens: 42_000, outputTokens: 8_000 }
    const est = g.estimate('claude-sonnet-4-5', usage)
    expect(g.spent()).toBe(0) // estimate must not record
    const r = g.record('claude-sonnet-4-5', usage)
    expect(r.costUsd).toBeCloseTo(est, 6)
  })

  it('cacheRead and cacheWrite contribute to cost', () => {
    const g = make()
    const usage = {
      inputTokens: 1000,
      outputTokens: 1000,
      cacheReadTokens: 100_000, // $0.10 (default = inputPrice)
      cacheWriteTokens: 10_000, // $0.40 (default = 4 * inputPrice)
    }
    // 1000/1000*0.10 + 1000/1000*0.30 + 100_000/1000*0.10 + 10_000/1000*0.40
    // = 0.10 + 0.30 + 10.00 + 4.00 = 14.40
    const r = g.record('MiniMax-M3', usage)
    expect(r.costUsd).toBeCloseTo(14.40, 6)
  })

  it('falls back to primaryModel pricing for unknown models', () => {
    const g = make()
    const r = g.record('totally-unknown-model', { inputTokens: 1000, outputTokens: 1000 })
    // Falls back to MiniMax-M3
    expect(r.costUsd).toBeCloseTo(0.10 + 0.30, 6)
  })

  it('isOverBudget triggers once total exceeds ceiling', () => {
    const g = make({ maxCostUsd: 1.0, graceFraction: 0 }) // no grace for clarity
    expect(g.isOverBudget()).toBe(false)
    // 4000 input + 0 output = $0.40 (under)
    g.record('MiniMax-M3', { inputTokens: 4_000, outputTokens: 0 })
    expect(g.isOverBudget()).toBe(false)
    // Add 7000 more = $0.70 + $0.40 = $1.10 (over)
    g.record('MiniMax-M3', { inputTokens: 7_000, outputTokens: 0 })
    expect(g.isOverBudget()).toBe(true)
  })

  it('maxCostUsd=0 means unlimited', () => {
    const g = make({ maxCostUsd: 0 })
    expect(g.isOverBudget()).toBe(false)
    g.record('MiniMax-M3', { inputTokens: 10_000_000, outputTokens: 10_000_000 })
    expect(g.isOverBudget()).toBe(false)
    expect(g.ceiling()).toBe(0)
  })

  it('graceFraction allows one over-budget call to finish', () => {
    // maxCostUsd=1.0, graceFraction=0.05 → effectiveBudget = 1.05
    const g = make({ maxCostUsd: 1.0, graceFraction: 0.05 })
    g.record('MiniMax-M3', { inputTokens: 10_300, outputTokens: 0 }) // $1.03 — over budget but within grace
    expect(g.isOverBudget()).toBe(true)
    expect(g.isOverGrace()).toBe(false)
    g.record('MiniMax-M3', { inputTokens: 5_000, outputTokens: 0 }) // +$0.50 = $1.53 — over grace
    expect(g.isOverGrace()).toBe(true)
  })

  it('breakdown aggregates by model and lists records', () => {
    const g = make()
    g.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 0 })
    g.record('claude-sonnet-4-5', { inputTokens: 1000, outputTokens: 1000 })
    const b = g.breakdown()
    expect(b.byModel['MiniMax-M3']).toBeDefined()
    expect(b.byModel['claude-sonnet-4-5']).toBeDefined()
    expect(b.records.length).toBe(2)
    expect(b.totalInputTokens).toBe(2000)
    expect(b.totalOutputTokens).toBe(1000)
  })

  it('child shares records with parent but enforces own budget', () => {
    const parent = make({ maxCostUsd: 10.0 })
    const child = parent.child({ maxCostUsd: 0.5 })
    // child sees the parent spend (0) + its own
    child.record('MiniMax-M3', { inputTokens: 4_000, outputTokens: 0 }) // $0.40
    expect(parent.spent()).toBeCloseTo(0.40, 6) // shared
    expect(child.isOverBudget()).toBe(false)
    child.record('MiniMax-M3', { inputTokens: 2_000, outputTokens: 0 }) // +$0.20 = $0.60
    expect(child.isOverBudget()).toBe(true)
    // parent is unaffected (well below its $10 ceiling)
    expect(parent.isOverBudget()).toBe(false)
    // parent's breakdown sees the child's records
    const b = parent.breakdown()
    expect(b.records.length).toBe(2)
  })

  it('rejects negative maxCostUsd', () => {
    expect(() => make({ maxCostUsd: -0.01 })).toThrow()
  })

  it('computeCost helper matches inline math', () => {
    const c = computeCost(
      { inputTokens: 1_000, outputTokens: 2_000 },
      { input: 3.0, output: 15.0 },
    )
    expect(c).toBeCloseTo(3.0 / 1000 * 1000 + 15.0 / 1000 * 2000, 6)
    expect(c).toBeCloseTo(3.0 + 30.0, 6)
  })

  it('pricing override via constructor', () => {
    const g = new CostGuard({
      pricing: { 'MiniMax-M3': { input: 0.0, output: 0.0 } }, // free!
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'free-tier',
    })
    const r = g.record('MiniMax-M3', { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(r.costUsd).toBe(0)
  })
})