/**
 * Two-level abort controller (Codex CLI pattern).
 *
 *   soft abort  — finish the current tool call, then stop accepting new ones
 *   hard abort  — kill the in-flight tool / network request immediately
 *
 * The user hits Esc to soft-abort; Ctrl-C is a hard-abort. Soft is preferred
 * because it leaves the session in a clean state for resume.
 */
export type AbortLevel = 'soft' | 'hard'

/** Event delivered to abort listeners. */
export type AbortEvent = AbortLevel | 'reset'

export class TwoLevelAbort {
  /** Non-private so reset() can replace it. */
  private _hard: AbortController = new AbortController()
  private _soft = false
  private readonly listeners = new Set<(level: AbortEvent) => void>()
  private readonly hardListener = (): void => {
    for (const fn of this.listeners) fn('hard')
  }

  /** Hard signal — wire into fetch / spawn / SDK options. */
  get hardSignal(): AbortSignal {
    return this._hard.signal
  }

  get aborted(): boolean {
    return this._soft || this._hard.signal.aborted
  }

  get softAborted(): boolean {
    return this._soft
  }

  trigger(level: AbortLevel): void {
    if (level === 'hard') {
      this._hard.abort()
      // The hardListener fires through the AbortSignal — nothing more to do.
    }
    this._soft = true
    for (const fn of this.listeners) fn(level)
  }

  reset(): void {
    this._soft = false
    // AbortController is single-shot; allocate a fresh one and re-wire the
    // listener (the old signal is already settled).
    this._hard = new AbortController()
    this._hard.signal.addEventListener('abort', this.hardListener, { once: true })
    for (const fn of this.listeners) fn('reset')
  }

  onAbort(fn: (level: AbortEvent) => void): () => void {
    this.listeners.add(fn)
    if (this._hard.signal.aborted) {
      // The hard signal has already fired before we attached — replay it once.
      fn('hard')
    } else {
      this._hard.signal.addEventListener('abort', this.hardListener, { once: true })
    }
    return () => {
      this.listeners.delete(fn)
    }
  }
}
