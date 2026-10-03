/**
 * ContextCompactor × HooksEngine — PreCompact (gating) + PostCompact (info).
 *
 * The compactor's M6 wiring is plumbed but the loop doesn't call into it
 * yet (M7/M8 follow-up). These tests exercise the wiring directly via
 * `compactor.compact(messages, provider, { hooksEngine, ... })`.
 */
import { describe, it, expect, vi } from 'vitest'
import { ContextCompactor } from '../../../src/core/context-compactor.js'
import type { Provider, ChatResponse } from '../../../src/model/provider.js'
import type { HooksEngine, FirePayload, HookDecision } from '../../../src/hooks/index.js'

class NoopProvider implements Provider {
  readonly name = 'noop'
  async chat(): Promise<ChatResponse> {
    return {
      message: { role: 'assistant', content: 'noop summary' },
      stopReason: 'end_turn',
      usage: { inputTokens: 1, outputTokens: 1 },
    }
  }
}

function makeFakeHooks(opts: { decision?: HookDecision; throwOnFire?: Error } = {}) {
  const fire = vi.fn(async (_e: string, _p: FirePayload): Promise<HookDecision> => {
    if (opts.throwOnFire) throw opts.throwOnFire
    return opts.decision ?? { allowed: true, results: [] }
  })
  return { engine: { fire } as unknown as HooksEngine, fire }
}

describe('ContextCompactor × HooksEngine', () => {
  it('does NOT fire hooks when no engine is set', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const r = await c.compact([], new NoopProvider())
    expect(r.fired).toContain('snip') // sanity — layer 1 always runs
  })

  it('fires PreCompact before any compaction work', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const { engine, fire } = makeFakeHooks({})
    await c.compact([], new NoopProvider(), {
      trigger: 'auto',
      hooksEngine: engine,
      sessionId: 's1',
      cwd: '/work',
    })
    const preCall = fire.mock.calls.find((c) => c[0] === 'PreCompact')
    expect(preCall).toBeDefined()
    expect(preCall![1]).toMatchObject({
      trigger: 'auto',
      tokenCountBefore: expect.any(Number),
      sessionId: 's1',
      cwd: '/work',
    })
  })

  it('PreCompact deny short-circuits — no layers run, messages unchanged', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const { engine } = makeFakeHooks({
      decision: { allowed: false, reason: 'not now', results: [] },
    })
    const messages: import('../../../src/model/provider.js').ChatMessage[] = [
      { role: 'user', content: 'a' },
    ]
    const r = await c.compact(messages, new NoopProvider(), {
      trigger: 'manual',
      hooksEngine: engine,
    })
    // fired is empty — snip, microcompact, collapse all skipped.
    expect(r.fired).toEqual([])
    expect(r.tokensAfter).toBe(r.tokensBefore)
    expect(messages).toHaveLength(1) // unchanged
  })

  it('PreCompact exception fails closed (no compaction)', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const { engine } = makeFakeHooks({ throwOnFire: new Error('boom') })
    const r = await c.compact([], new NoopProvider(), {
      trigger: 'manual',
      hooksEngine: engine,
    })
    expect(r.fired).toEqual([])
  })

  it('fires PostCompact after layers complete', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const { engine, fire } = makeFakeHooks({})
    await c.compact([], new NoopProvider(), {
      trigger: 'auto',
      hooksEngine: engine,
      sessionId: 's2',
    })
    const postCall = fire.mock.calls.find((c) => c[0] === 'PostCompact')
    expect(postCall).toBeDefined()
    expect(postCall![1]).toMatchObject({
      sessionId: 's2',
      tokenCountBefore: expect.any(Number),
      tokenCountAfter: expect.any(Number),
    })
  })

  it('does NOT fire PostCompact when PreCompact denied', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const { engine, fire } = makeFakeHooks({
      decision: { allowed: false, results: [] },
    })
    await c.compact([], new NoopProvider(), { trigger: 'manual', hooksEngine: engine })
    const postCall = fire.mock.calls.find((c) => c[0] === 'PostCompact')
    expect(postCall).toBeUndefined()
  })

  it('PostCompact hook failure does not affect the result', async () => {
    const c = new ContextCompactor({ contextWindow: 10_000 })
    const fire = vi.fn(async (e: string): Promise<HookDecision> => {
      if (e === 'PostCompact') throw new Error('post-fail')
      return { allowed: true, results: [] }
    })
    const r = await c.compact([], new NoopProvider(), {
      trigger: 'auto',
      hooksEngine: { fire } as unknown as HooksEngine,
    })
    expect(r.fired).toContain('snip')
  })
})
