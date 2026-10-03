/**
 * State machine + TwoLevelAbort tests.
 */
import { describe, expect, it } from 'vitest'
import { Phase, StateMachine } from '../../../src/core/state-machine.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'

describe('StateMachine', () => {
  it('starts idle', () => {
    const sm = new StateMachine()
    expect(sm.phase).toBe(Phase.IDLE)
    expect(sm.is(Phase.IDLE)).toBe(true)
  })

  it('treats same-state transition as a no-op', () => {
    const sm = new StateMachine()
    expect(() => sm.transition(Phase.RUNNING)).not.toThrow()
    // Same state → silently no-op (does not throw, does not emit)
    let fired = false
    sm.subscribe(() => {
      fired = true
    })
    sm.transition(Phase.RUNNING)
    expect(fired).toBe(false)
  })

  it('allows idle → running → idle', () => {
    const sm = new StateMachine()
    sm.transition(Phase.RUNNING)
    sm.transition(Phase.IDLE)
    expect(sm.phase).toBe(Phase.IDLE)
  })

  it('tryAcquire only succeeds from idle', () => {
    const sm = new StateMachine()
    expect(sm.tryAcquire()).toBe(true)
    expect(sm.tryAcquire()).toBe(false) // already running
    sm.release()
    expect(sm.tryAcquire()).toBe(true)
    sm.release()
  })

  it('emits transition events', () => {
    const sm = new StateMachine()
    const log: Array<[Phase, Phase]> = []
    sm.subscribe((next, prev) => log.push([next, prev]))
    sm.transition(Phase.RUNNING)
    sm.transition(Phase.MAINTENANCE)
    expect(log).toEqual([
      [Phase.RUNNING, Phase.IDLE],
      [Phase.MAINTENANCE, Phase.RUNNING],
    ])
  })

  it('subscribe returns an unsubscribe function', () => {
    const sm = new StateMachine()
    let count = 0
    const off = sm.subscribe(() => count++)
    sm.transition(Phase.RUNNING)
    off()
    sm.transition(Phase.IDLE)
    expect(count).toBe(1)
  })

  it('ignores same-state transition (no emit)', () => {
    const sm = new StateMachine()
    let count = 0
    sm.subscribe(() => count++)
    sm.transition(Phase.IDLE)
    expect(count).toBe(0)
  })
})

describe('TwoLevelAbort', () => {
  it('starts not aborted', () => {
    const a = new TwoLevelAbort()
    expect(a.aborted).toBe(false)
    expect(a.softAborted).toBe(false)
    expect(a.hardSignal.aborted).toBe(false)
  })

  it('soft abort sets softAborted but does NOT trigger hard signal', () => {
    const a = new TwoLevelAbort()
    let hardFired = false
    a.onAbort((lvl) => {
      if (lvl === 'hard') hardFired = true
    })
    a.trigger('soft')
    expect(a.softAborted).toBe(true)
    expect(a.aborted).toBe(true)
    expect(a.hardSignal.aborted).toBe(false)
    expect(hardFired).toBe(false)
  })

  it('hard abort triggers the hard signal AND fires listeners', () => {
    const a = new TwoLevelAbort()
    const seen: string[] = []
    a.onAbort((lvl) => seen.push(lvl))
    a.trigger('hard')
    expect(a.hardSignal.aborted).toBe(true)
    expect(a.aborted).toBe(true)
    expect(seen).toContain('hard')
  })

  it('reset clears soft state and replaces the hard signal', () => {
    const a = new TwoLevelAbort()
    a.trigger('soft')
    expect(a.softAborted).toBe(true)
    a.reset()
    expect(a.softAborted).toBe(false)
    expect(a.hardSignal.aborted).toBe(false)
  })

  it('reset fires a "reset" event to listeners', () => {
    const a = new TwoLevelAbort()
    const seen: string[] = []
    a.onAbort((lvl) => seen.push(lvl))
    a.reset()
    expect(seen).toContain('reset')
  })

  it('onAbort returns an unsubscribe function', () => {
    const a = new TwoLevelAbort()
    let count = 0
    const off = a.onAbort(() => count++)
    a.trigger('soft')
    off()
    a.reset()
    expect(count).toBe(1)
  })

  it('subscribers added after hard abort already fired get replayed', () => {
    const a = new TwoLevelAbort()
    a.trigger('hard')
    let fired = false
    a.onAbort((lvl) => {
      if (lvl === 'hard') fired = true
    })
    expect(fired).toBe(true)
  })
})
