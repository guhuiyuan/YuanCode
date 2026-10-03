/**
 * HooksEngine — the orchestrator.
 *
 * Lifecycle:
 *   - `load(config)` — replace current configuration.
 *   - `fire(event, payload)` — run all matching hooks concurrently.
 *     Returns a HookDecision describing whether the action should proceed.
 *   - `dispose()` — cleanup (no-op for production, useful for tests).
 *
 * Per-event semantics (gating):
 *   - Events in `GATING_EVENTS` (PreToolUse, UserPromptSubmit, PreCompact,
 *     SubagentStart) treat a `deny` outcome as "abort the action."
 *   - Other events treat `deny` as informational; results are returned for
 *     logging but the decision is always `allowed: true`.
 *
 * The engine never throws out of `fire()`. Exceptions in individual hooks
 * are caught by `executeBashHook` / `executeHttpHook` and converted to
 * `deny` results (fail-closed).
 *
 * The cycle detector bounds the depth of nested fires: if a hook somehow
 * ends up triggering another hook synchronously (e.g. via a synchronous
 * callback chain), the engine refuses the inner fire rather than spinning.
 * For the typical async case (hook spawns child → child does not re-enter
 * the engine), the detector is never tripped.
 */
import { HookCycleDetector } from './cycle-detector.js'
import { executeBashHook, executeHttpHook } from './executor.js'
import { compileMatcher, type CompiledMatcher } from './matcher.js'
import type {
  BashHookEntry,
  HookDecision,
  HookEntry,
  HookEvent,
  HookPayload,
  HooksConfig,
  HttpHookEntry,
} from './types.js'
import { GATING_EVENTS } from './types.js'

export interface HooksEngineDeps {
  sessionId: string
  cwd: string
  /** Abort signal wired to the session's TwoLevelAbort.hardSignal. */
  hardSignal: AbortSignal
  /** Optional logger (pino-style). If absent, logs go to console. */
  logger?: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

// Internal — discriminated payload shapes are normalized by `fire()`.
export type FirePayload = Omit<HookPayload, 'sessionId' | 'cwd' | 'event' | 'timestamp'>

export class HooksEngine {
  private config: HooksConfig = { hooks: {} }
  private readonly matcherCache = new WeakMap<HookEntry, CompiledMatcher>()
  private readonly cycleDetector = new HookCycleDetector()
  private counter = 0
  private disposed = false

  constructor(private readonly deps: HooksEngineDeps) {}

  /**
   * Replace current config. Pass `{ hooks: {} }` to clear.
   * Matcher compilation happens lazily on first fire per entry.
   */
  load(config: HooksConfig): void {
    this.config = config
  }

  /**
   * Fire an event. Returns a HookDecision:
   *   - `allowed: true` for non-gating events regardless of individual outcomes.
   *   - `allowed: false` for gating events if any hook denied.
   *
   * Concurrent fires share the cycle detector (depth-bounded).
   */
  async fire(event: HookEvent, payload: FirePayload): Promise<HookDecision> {
    if (this.disposed) {
      return { allowed: true, results: [] }
    }

    const fullPayload: HookPayload = {
      ...payload,
      sessionId: this.deps.sessionId,
      cwd: this.deps.cwd,
      event,
      timestamp: Date.now(),
    } as HookPayload

    const entries = this.config.hooks[event] ?? []
    if (entries.length === 0) {
      return { allowed: true, results: [] }
    }

    // Pre-filter by matcher (for PreToolUse / PostToolUse).
    const toolName = (payload as { toolName?: string }).toolName
    const matching = toolName !== undefined
      ? entries.filter((e) => this.getMatcher(e).test(toolName))
      : entries

    if (matching.length === 0) {
      return { allowed: true, results: [] }
    }

    if (!this.cycleDetector.enter()) {
      this.warn(`cycle depth limit exceeded for event ${event}; aborting fire`)
      return {
        allowed: false,
        reason: 'hook cycle depth limit exceeded',
        results: [],
      }
    }

    try {
      const counter = { next: (): number => ++this.counter }
      const results = await Promise.all(
        matching.map((entry, idx) =>
          entry.type === 'bash'
            ? executeBashHook(entry as BashHookEntry, fullPayload, { ...this.deps, counter }, idx)
            : executeHttpHook(entry as HttpHookEntry, fullPayload, { ...this.deps, counter }, idx),
        ),
      )

      const isGating = GATING_EVENTS.has(event)
      const deny = results.find((r) => r.outcome === 'deny')
      const allowed = isGating ? !deny : true
      const decision: HookDecision = {
        allowed,
        results,
      }
      if (deny && isGating) {
        decision.reason = deny.reason ?? 'hook denied'
      }
      return decision
    } finally {
      this.cycleDetector.exit()
    }
  }

  /** Tear-down (idempotent). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cycleDetector.reset()
    this.config = { hooks: {} }
  }

  // ---- internals ----

  private getMatcher(entry: HookEntry): CompiledMatcher {
    let m = this.matcherCache.get(entry)
    if (!m) {
      const matcher = (entry as { matcher?: string }).matcher
      m = compileMatcher(matcher)
      this.matcherCache.set(entry, m)
    }
    return m
  }

  private warn(msg: string): void {
    if (this.deps.logger) this.deps.logger.warn(msg)
    else console.warn(`[hooks] ${msg}`)
  }
}
