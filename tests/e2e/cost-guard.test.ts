/**
 * E2E: CostGuard
 *
 * Exercises the real CostGuard against the built-in pricing table.
 * Verifies record / estimate / breakdown / child / grace interaction.
 */
import { describe, it, expect } from 'vitest'
import {
  CostGuard,
  DEFAULT_PRICING,
  computeCost,
} from '../../dist/core/cost-guard.js'

describe('CostGuard (e2e)', () => {
  it('record() accumulates totals and breakdown agrees', () => {
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-1',
    })
    expect(cg.spent()).toBe(0)
    cg.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 500 })
    cg.record('MiniMax-M3', { inputTokens: 2000, outputTokens: 1000 })
    const br = cg.breakdown()
    expect(br.totalInputTokens).toBe(3000)
    expect(br.totalOutputTokens).toBe(1500)
    expect(br.byModel['MiniMax-M3'].costUsd).toBeGreaterThan(0)
    expect(br.records.length).toBe(2)
    expect(cg.spent()).toBeCloseTo(br.totalCostUsd, 6)
  })

  it('isOverBudget flips true after enough usage', () => {
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 0.05,
      model: 'MiniMax-M3',
      sessionId: 'e2e-2',
    })
    expect(cg.isOverBudget()).toBe(false)
    // 500 input + 500 output ≈ 500 * 0.10 / 1000 + 500 * 0.30 / 1000 = $0.20
    cg.record('MiniMax-M3', { inputTokens: 500, outputTokens: 500 })
    expect(cg.isOverBudget()).toBe(true)
  })

  it('grace fraction lets a single over-budget call finish', () => {
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 0.10,
      model: 'MiniMax-M3',
      sessionId: 'e2e-3',
      graceFraction: 0.5,
    })
    cg.record('MiniMax-M3', { inputTokens: 700, outputTokens: 200 })
    // 700*0.10/1000 + 200*0.30/1000 = $0.13 — over $0.10 but under $0.15
    expect(cg.isOverBudget()).toBe(true)
    expect(cg.isOverGrace()).toBe(false)
  })

  it('child() shares records but enforces its own ceiling', () => {
    const parent = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-4',
    })
    parent.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 1000 })
    const child = parent.child({ maxCostUsd: 0.05 })
    child.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 1000 })
    // Child sees parent's pre-existing spend too
    expect(child.spent()).toBe(parent.spent())
    // Both over the child's $0.05 ceiling
    expect(child.isOverBudget()).toBe(true)
    // Parent is well under its own $1.0
    expect(parent.isOverBudget()).toBe(false)
    // Records are shared — parent breakdown sees the child's record
    expect(parent.breakdown().records.length).toBe(2)
  })

  it('estimate() does not record', () => {
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-5',
    })
    const before = cg.spent()
    const est = cg.estimate('MiniMax-M3', { inputTokens: 5000, outputTokens: 2000 })
    expect(cg.spent()).toBe(before)
    expect(est).toBeGreaterThan(0)
  })

  it('computeCost helper matches record() math', () => {
    const usage = { inputTokens: 1000, outputTokens: 1000 }
    const direct = computeCost(usage, DEFAULT_PRICING['MiniMax-M3']!)
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-6',
    })
    const { costUsd } = cg.record('MiniMax-M3', usage)
    expect(costUsd).toBeCloseTo(direct, 6)
  })

  it('maxCostUsd=0 means unlimited', () => {
    const cg = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-7',
    })
    cg.record('MiniMax-M3', { inputTokens: 100_000, outputTokens: 100_000 })
    expect(cg.isOverBudget()).toBe(false)
    expect(cg.spent()).toBeGreaterThan(0)
  })
})