/**
 * CostGuard — real USD accounting for LLM usage.
 *
 * Replaces M6's "1M tokens ≈ $1" heuristic with a per-model pricing table
 * the user can override via `pricing:` in config.yaml.
 *
 * Design:
 *   - Flat PricingTable (USD per 1k tokens, by model name).
 *   - Per-session totals broken down by model + by record (timestamped).
 *   - `isOverBudget()` returns true once `totalCostUsd > maxCostUsd`.
 *   - Grace fraction (default 5%) lets one in-flight call complete instead
 *     of truncating mid-response.
 *   - `child()` derives a tighter-budget sub-scope for subagents; the
 *     child shares the parent's records (so a `breakdown()` on the parent
 *     still sees subagent usage), but enforces its own ceiling.
 *
 * Pricing is best-effort — provider pricing pages change, and we don't make
 * any network calls. The README + cost-and-limits doc spell this out.
 */
import { randomUUID } from 'node:crypto'

/** USD per 1 000 tokens. */
export interface ModelPricing {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
}

export type PricingTable = Record<string, ModelPricing>

/** Built-in defaults. Prices are conservative best-guesses as of mid-2026. */
export const DEFAULT_PRICING: PricingTable = {
  // MiniMax M3 — friendly default for clone-and-go
  'MiniMax-M3': { input: 0.10, output: 0.30 },

  // Anthropic
  'claude-opus-4-5': { input: 15.0, output: 75.0 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 0.80, output: 4.0 },

  // OpenAI
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CostGuardOptions {
  pricing: PricingTable
  /** USD ceiling. 0 = unlimited. */
  maxCostUsd: number
  /** Primary model — used by `estimate()` and for `breakdown().byModel`. */
  model: string
  sessionId: string
  /** Source label for diagnostics. */
  source?: 'loop' | 'subagent' | 'background' | 'doctor'
  /** Allow in-flight call to finish after budget exceeded (default 0.05). */
  graceFraction?: number
}

/** A single `record()` entry, kept for diagnostic breakdowns. */
export interface UsageRecord {
  id: string
  source: 'loop' | 'subagent' | 'background' | 'doctor'
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  at: number
}

export interface ModelUsage {
  costUsd: number
  inputTokens: number
  outputTokens: number
}

export interface CostBreakdown {
  totalCostUsd: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  byModel: Record<string, ModelUsage>
  records: UsageRecord[]
}

export interface CostRecordResult {
  /** Cost incurred by THIS record. */
  costUsd: number
  /** Total session cost after this record. */
  totalCostUsd: number
}

export class CostGuard {
  private readonly pricing: PricingTable
  private readonly maxCostUsd: number
  private readonly primaryModel: string
  private readonly sessionId: string
  private readonly source: 'loop' | 'subagent' | 'background' | 'doctor'
  private readonly graceFraction: number
  /** Effective budget including grace. */
  private readonly effectiveBudget: number

  /** All records (parent + children share these via `parent`). */
  private readonly records: UsageRecord[]
  /** Weak reference to parent for breakdowns. */
  private readonly parent: CostGuard | null
  /** Self-id so children know their lineage. */
  private readonly id: string
  /** Per-model totals (parent + children accumulate here). */
  private readonly totals: Map<string, ModelUsage>
  /** Cost so far (parent + children). */
  private totalCostUsd: number

  constructor(opts: CostGuardOptions, parent?: CostGuard) {
    if (opts.maxCostUsd < 0) {
      throw new Error(`maxCostUsd must be >= 0, got ${opts.maxCostUsd}`)
    }
    this.pricing = opts.pricing
    this.maxCostUsd = opts.maxCostUsd
    this.primaryModel = opts.model
    this.sessionId = opts.sessionId
    this.source = opts.source ?? 'loop'
    this.graceFraction = opts.graceFraction ?? 0.05
    this.effectiveBudget =
      opts.maxCostUsd === 0 ? Number.POSITIVE_INFINITY : opts.maxCostUsd * (1 + this.graceFraction)

    if (parent) {
      // Child shares records + totals with parent.
      this.parent = parent
      this.records = parent.records
      this.totals = parent.totals
      this.totalCostUsd = parent.totalCostUsd
      this.id = randomUUID()
    } else {
      this.parent = null
      this.records = []
      this.totals = new Map()
      this.totalCostUsd = 0
      this.id = randomUUID()
    }
  }

  /**
   * Add a usage record. Returns the cost this record incurred and the new
   * total. Always succeeds — callers should call `isOverBudget()` to decide
   * whether to short-circuit further work.
   */
  record(model: string, usage: TokenUsage): CostRecordResult {
    const pricing = this.resolvePricing(model)
    const costUsd = computeCost(usage, pricing)
    const at = Date.now()

    const rec: UsageRecord = {
      id: randomUUID(),
      source: this.source,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      costUsd,
      at,
    }
    this.records.push(rec)

    const t = this.totals.get(model) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 }
    t.costUsd += costUsd
    t.inputTokens += usage.inputTokens
    t.outputTokens += usage.outputTokens
    this.totals.set(model, t)

    this.totalCostUsd += costUsd
    if (this.parent) this.parent.totalCostUsd = this.totalCostUsd

    return { costUsd, totalCostUsd: this.totalCostUsd }
  }

  /** Cheap estimate without recording. Useful for "would this break budget?". */
  estimate(model: string, usage: TokenUsage): number {
    return computeCost(usage, this.resolvePricing(model))
  }

  /** True once we've exceeded `maxCostUsd` (grace excluded). */
  isOverBudget(): boolean {
    if (this.maxCostUsd === 0) return false
    return this.totalCostUsd > this.maxCostUsd
  }

  /** True once we've exceeded even the grace budget. */
  isOverGrace(): boolean {
    return this.totalCostUsd > this.effectiveBudget
  }

  /** USD ceiling configured at construction. 0 = unlimited. */
  ceiling(): number {
    return this.maxCostUsd
  }

  /** Effective ceiling (with grace). */
  effectiveCeiling(): number {
    return this.effectiveBudget
  }

  /** Current session spend. */
  spent(): number {
    return this.totalCostUsd
  }

  /** Per-model totals + flat record log. */
  breakdown(): CostBreakdown {
    let totalIn = 0
    let totalOut = 0
    let totalCacheRead = 0
    let totalCacheWrite = 0
    const byModel: Record<string, ModelUsage> = {}
    for (const [model, t] of this.totals) {
      byModel[model] = { ...t }
      totalIn += t.inputTokens
      totalOut += t.outputTokens
    }
    for (const rec of this.records) {
      totalCacheRead += rec.cacheReadTokens
      totalCacheWrite += rec.cacheWriteTokens
    }
    return {
      totalCostUsd: this.totalCostUsd,
      totalInputTokens: totalIn,
      totalOutputTokens: totalOut,
      totalCacheReadTokens: totalCacheRead,
      totalCacheWriteTokens: totalCacheWrite,
      byModel,
      records: [...this.records],
    }
  }

  /**
   * Derive a child scope sharing records + totals but enforcing its own
   * (usually tighter) budget. The child sees the parent's accumulated
   * spend in its `isOverBudget()` check, so the effective ceiling is the
   * parent's `totalCostUsd` at child-spawn time + child's own budget.
   */
  child(opts: { maxCostUsd?: number; model?: string; source?: 'subagent' | 'background' }): CostGuard {
    const childBudget = opts.maxCostUsd ?? this.maxCostUsd * 0.1
    return new CostGuard(
      {
        pricing: this.pricing,
        maxCostUsd: childBudget,
        model: opts.model ?? this.primaryModel,
        sessionId: this.sessionId,
        source: opts.source ?? 'subagent',
        graceFraction: this.graceFraction,
      },
      this,
    )
  }

  // ----- internals -----

  /** Resolve pricing for a model — falls back to `primaryModel` then to a flat $3/$15 default. */
  private resolvePricing(model: string): ModelPricing {
    return (
      this.pricing[model] ??
      this.pricing[this.primaryModel] ??
      { input: 3.0, output: 15.0 }
    )
  }
}

/**
 * Compute USD cost for a single usage record.
 *
 *   cost = (input / 1000) * inputPrice
 *         + (output / 1000) * outputPrice
 *         + (cacheRead / 1000) * cacheReadPrice  (default = inputPrice)
 *         + (cacheWrite / 1000) * cacheWritePrice (default = 4 * inputPrice)
 *
 * Cache-write is more expensive than cache-read because it forces the
 * provider to store the prefix; for Anthropic the ratio is ~4x. For other
 * providers the cache-write field may be missing or priced differently —
 * adjust the override table accordingly.
 */
export function computeCost(usage: TokenUsage, pricing: ModelPricing): number {
  const input = (usage.inputTokens / 1000) * pricing.input
  const output = (usage.outputTokens / 1000) * pricing.output
  const cacheReadPrice = pricing.cacheRead ?? pricing.input
  const cacheWritePrice = pricing.cacheWrite ?? pricing.input * 4
  const cacheRead = ((usage.cacheReadTokens ?? 0) / 1000) * cacheReadPrice
  const cacheWrite = ((usage.cacheWriteTokens ?? 0) / 1000) * cacheWritePrice
  return input + output + cacheRead + cacheWrite
}