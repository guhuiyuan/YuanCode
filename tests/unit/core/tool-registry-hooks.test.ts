/**
 * ToolRegistry × HooksEngine integration.
 *
 * The hooks engine was added in M6 (Step 12) and wired into
 * `ToolRegistry.execute()`: PreToolUse fires before the handler (and a
 * deny short-circuits), PostToolUse fires after (informational only).
 *
 * These tests cover the wiring itself — the HooksEngine unit tests
 * (`tests/unit/hooks/engine.test.ts`) cover the engine's internal logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import type { Logger as PinoLogger } from 'pino'
import type { HooksEngine, HookDecision, FirePayload } from '../../../src/hooks/index.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: function () {
    return this
  },
} as unknown as PinoLogger

function makeCtx() {
  return {
    cwd: process.cwd(),
    sandbox: {} as never,
    abort: new TwoLevelAbort(),
    sessionId: 'sess-1',
    permissionMode: 'auto' as const,
    logger: noopLogger,
  }
}

/**
 * Lightweight HooksEngine stub. We only need to assert that fire() is
 * called with the right payload shape and that a deny result short-circuits.
 */
function makeFakeHooks(opts: { preDecision?: HookDecision } = {}) {
  const fire = vi.fn(async (event: string, payload: FirePayload): Promise<HookDecision> => {
    if (event === 'PreToolUse' && opts.preDecision) return opts.preDecision
    return { allowed: true, results: [] }
  })
  const engine = { fire } as unknown as HooksEngine
  return { engine, fire }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('ToolRegistry + HooksEngine', () => {
  it('does NOT fire hooks when no engine is set (M1-M5 behaviour)', async () => {
    const r = new ToolRegistry()
    const handler = vi.fn(async () => ({ content: 'ok' }))
    r.register({
      name: 'noop',
      description: '',
      schema: z.object({}),
      handler,
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    await r.execute('noop', {}, makeCtx())
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('fires PreToolUse before handler with toolName + toolInput', async () => {
    const r = new ToolRegistry()
    const { engine, fire } = makeFakeHooks()
    r.setHooksEngine(engine)
    const handler = vi.fn(async () => ({ content: 'ok' }))
    r.register({
      name: 'echo',
      description: '',
      schema: z.object({ x: z.number() }),
      handler,
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    await r.execute('echo', { x: 42 }, makeCtx())
    expect(fire).toHaveBeenCalledWith(
      'PreToolUse',
      expect.objectContaining({
        toolName: 'echo',
        toolInput: { x: 42 },
        sessionId: 'sess-1',
        cwd: process.cwd(),
      }),
    )
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('short-circuits the handler when PreToolUse denies', async () => {
    const r = new ToolRegistry()
    const { engine } = makeFakeHooks({
      preDecision: {
        allowed: false,
        reason: 'forbidden tool',
        results: [{ hookId: 'h1', event: 'PreToolUse', type: 'bash', matcher: null, outcome: 'deny', reason: 'forbidden tool', durationMs: 0 }],
      },
    })
    r.setHooksEngine(engine)
    const handler = vi.fn(async () => ({ content: 'never called' }))
    r.register({
      name: 'echo',
      description: '',
      schema: z.object({}),
      handler,
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const out = await r.execute('echo', {}, makeCtx())
    expect(handler).not.toHaveBeenCalled()
    expect(out.isError).toBe(true)
    expect(out.content).toMatch(/blocked by hook/)
    expect(out.content).toMatch(/forbidden tool/)
  })

  it('fires PostToolUse after success with content + durationMs', async () => {
    const r = new ToolRegistry()
    const { engine, fire } = makeFakeHooks()
    r.setHooksEngine(engine)
    r.register({
      name: 'echo',
      description: '',
      schema: z.object({}),
      handler: async () => ({ content: 'result-text' }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    await r.execute('echo', {}, makeCtx())
    // Find the PostToolUse call (fire is called twice: Pre + Post).
    const postCall = fire.mock.calls.find((c) => c[0] === 'PostToolUse')
    expect(postCall).toBeDefined()
    expect(postCall![1]).toMatchObject({
      toolName: 'echo',
      toolOutput: 'result-text',
      toolError: undefined,
      durationMs: expect.any(Number),
      sessionId: 'sess-1',
    })
  })

  it('fires PostToolUse after handler failure, with toolError set', async () => {
    const r = new ToolRegistry()
    const { engine, fire } = makeFakeHooks()
    r.setHooksEngine(engine)
    r.register({
      name: 'boom',
      description: '',
      schema: z.object({}),
      handler: async () => {
        throw new Error('handler exploded')
      },
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const out = await r.execute('boom', {}, makeCtx())
    expect(out.isError).toBe(true)
    const postCall = fire.mock.calls.find((c) => c[0] === 'PostToolUse')
    expect(postCall).toBeDefined()
    expect(postCall![1]).toMatchObject({
      toolName: 'boom',
      toolError: 'handler exploded',
    })
  })

  it('PostToolUse outcome does NOT gate the result', async () => {
    const r = new ToolRegistry()
    // Pre allows, Post denies → final result still surfaces the handler output.
    const fire = vi.fn(async (event: string): Promise<HookDecision> => {
      if (event === 'PostToolUse') {
        return {
          allowed: false,
          reason: 'post-deny (informational)',
          results: [],
        }
      }
      return { allowed: true, results: [] }
    })
    r.setHooksEngine({ fire } as unknown as HooksEngine)
    r.register({
      name: 'echo',
      description: '',
      schema: z.object({}),
      handler: async () => ({ content: 'real-result' }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const out = await r.execute('echo', {}, makeCtx())
    // isError may be false or undefined — either way the model sees the
    // real handler output. We assert on content to be unambiguous.
    expect(out.content).toBe('real-result')
    expect(out.isError).toBeFalsy()
  })

  it('does NOT fire PreToolUse for invalid input (validation runs first)', async () => {
    const r = new ToolRegistry()
    const { engine, fire } = makeFakeHooks()
    r.setHooksEngine(engine)
    r.register({
      name: 'echo',
      description: '',
      schema: z.object({ x: z.number() }),
      handler: async () => ({ content: 'ok' }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const out = await r.execute('echo', { x: 'not-a-number' }, makeCtx())
    expect(out.isError).toBe(true)
    expect(fire).not.toHaveBeenCalled()
  })
})
