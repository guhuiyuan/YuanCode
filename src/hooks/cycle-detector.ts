/**
 * Hook cycle detector — bounded-depth recursion guard.
 *
 * Hooks are async; an entry might fire its own sub-hook process, which
 * could itself call back into the engine. We don't track per-call identity
 * (that would require a request-scoped context that the engine doesn't
 * own); we instead bound the depth across all concurrent fires.
 *
 * `enter()` increments depth and returns `false` if it would exceed the
 * configured limit. `exit()` decrements. The engine treats a `false` from
 * `enter()` as "abort this fire — too deep."
 *
 * This is conservative: it can falsely reject legitimate deep stacks, but
 * it can't miss a true cycle. Default max depth is 5.
 */

export class HookCycleDetector {
  private depth = 0

  constructor(private readonly maxDepth: number = 5) {}

  /**
   * Attempt to enter a new hook-firing context. Returns `true` if the entry
   * is allowed (depth incremented), `false` if the limit would be exceeded
   * (depth unchanged).
   */
  enter(): boolean {
    if (this.depth >= this.maxDepth) return false
    this.depth++
    return true
  }

  /** Decrement depth. Safe to call after a successful `enter()`. */
  exit(): void {
    if (this.depth > 0) this.depth--
  }

  /** Current active depth (for diagnostics / tests). */
  get current(): number {
    return this.depth
  }

  /** Reset to zero (used by `dispose()` in the engine). */
  reset(): void {
    this.depth = 0
  }
}
