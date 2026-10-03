/**
 * App × HooksEngine — UserPromptSubmit gate.
 *
 * The TUI's `handleSubmit` is a closure inside a React component, hard to
 * exercise without an Ink harness. The hook decision is factored into
 * `checkPromptSubmitGate` in app.tsx — these tests cover that helper.
 */
import { describe, it, expect, vi } from 'vitest'
import { checkPromptSubmitGate } from '../../../src/tui/app.js'
import type { HooksEngine, FirePayload, HookDecision } from '../../../src/hooks/index.js'

function makeFakeHooks(opts: { decision?: HookDecision; throwOnFire?: Error } = {}) {
  const fire = vi.fn(async (_e: string, _p: FirePayload): Promise<HookDecision> => {
    if (opts.throwOnFire) throw opts.throwOnFire
    return opts.decision ?? { allowed: true, results: [] }
  })
  return { engine: { fire } as unknown as HooksEngine, fire }
}

describe('checkPromptSubmitGate', () => {
  it('allows when no hooksEngine is set', async () => {
    const r = await checkPromptSubmitGate(
      { sessionId: 's1', cwd: '/tmp' },
      'hello',
    )
    expect(r.allowed).toBe(true)
  })

  it('fires UserPromptSubmit with the prompt text + session + cwd', async () => {
    const { engine, fire } = makeFakeHooks()
    await checkPromptSubmitGate(
      { hooksEngine: engine, sessionId: 'sess-1', cwd: '/work' },
      'do the thing',
    )
    expect(fire).toHaveBeenCalledWith(
      'UserPromptSubmit',
      expect.objectContaining({
        prompt: 'do the thing',
        sessionId: 'sess-1',
        cwd: '/work',
      }),
    )
  })

  it('returns allowed when hook allows', async () => {
    const { engine } = makeFakeHooks({ decision: { allowed: true, results: [] } })
    const r = await checkPromptSubmitGate(
      { hooksEngine: engine, sessionId: 's', cwd: '/' },
      'p',
    )
    expect(r.allowed).toBe(true)
  })

  it('returns denied with reason when hook denies', async () => {
    const { engine } = makeFakeHooks({
      decision: { allowed: false, reason: 'sensitive content', results: [] },
    })
    const r = await checkPromptSubmitGate(
      { hooksEngine: engine, sessionId: 's', cwd: '/' },
      'p',
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toMatch(/sensitive content/)
  })

  it('returns denied with default reason when hook denies without one', async () => {
    const { engine } = makeFakeHooks({
      decision: { allowed: false, results: [] },
    })
    const r = await checkPromptSubmitGate(
      { hooksEngine: engine, sessionId: 's', cwd: '/' },
      'p',
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason).toBe('no reason given')
  })

  it('fails closed when the hook throws', async () => {
    const { engine } = makeFakeHooks({ throwOnFire: new Error('boom') })
    const r = await checkPromptSubmitGate(
      { hooksEngine: engine, sessionId: 's', cwd: '/' },
      'p',
    )
    expect(r.allowed).toBe(false)
    if (!r.allowed) {
      expect(r.reason).toMatch(/fail-closed/)
      expect(r.reason).toMatch(/boom/)
    }
  })
})
