/**
 * Driver phase state machine. Borrowed from the DeepSeek Harness Agent Loop
 * paper — `idle | maintenance | running` with explicit transitions so the
 * driver can never be in two states at once.
 *
 * The state machine guards critical sections:
 *   - only one driver instance can run per session
 *   - background notifications drain only during maintenance
 *   - the user can pause only when not actively streaming a model response
 */
export const Phase = {
  IDLE: 'idle',
  MAINTENANCE: 'maintenance',
  RUNNING: 'running',
} as const

export type Phase = (typeof Phase)[keyof typeof Phase]

export class StateMachine {
  private _phase: Phase = Phase.IDLE
  private readonly listeners = new Set<(p: Phase, prev: Phase) => void>()

  get phase(): Phase {
    return this._phase
  }

  is(p: Phase): boolean {
    return this._phase === p
  }

  transition(next: Phase): void {
    if (this._phase === next) return
    this.assertValidTransition(next)
    const prev = this._phase
    this._phase = next
    for (const fn of this.listeners) fn(next, prev)
  }

  subscribe(fn: (p: Phase, prev: Phase) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Returns true if we acquired the lock (i.e. transitioned idle → running). */
  tryAcquire(): boolean {
    if (this._phase !== Phase.IDLE) return false
    this.transition(Phase.RUNNING)
    return true
  }

  release(): void {
    if (this._phase === Phase.RUNNING) this.transition(Phase.IDLE)
  }

  private assertValidTransition(next: Phase): void {
    const cur = this._phase
    const allowed: Record<Phase, Phase[]> = {
      [Phase.IDLE]: [Phase.MAINTENANCE, Phase.RUNNING],
      [Phase.MAINTENANCE]: [Phase.RUNNING, Phase.IDLE],
      [Phase.RUNNING]: [Phase.MAINTENANCE, Phase.IDLE],
    }
    if (!allowed[cur].includes(next)) {
      throw new Error(`Invalid phase transition: ${cur} → ${next}`)
    }
  }
}
