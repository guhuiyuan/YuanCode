/**
 * BackgroundTaskPool × HooksEngine — Notification hook on finalization.
 *
 * The pre-existing tests in `background-tasks.test.ts` cover dispatch,
 * concurrency, cancel, and drain. This file covers the M6 Notification
 * wiring only.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { BackgroundTaskPool } from '../../../src/core/background-tasks.js'
import type { ToolContext } from '../../../src/core/tool-registry.js'
import type { HooksEngine, FirePayload } from '../../../src/hooks/index.js'

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
} as unknown as import('pino').Logger

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sandbox: new LocalSandbox({ cwd: process.cwd() }),
    abort: new TwoLevelAbort(),
    sessionId: 'bg-hooks-test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register({
    name: 'echo',
    description: 'echo',
    schema: z.object({ value: z.string() }),
    handler: async (i: { value: string }) => ({ content: `echo:${i.value}` }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  r.register({
    name: 'always_fail',
    description: 'fails',
    schema: z.object({}),
    handler: async () => ({ content: 'failed intentionally', isError: true }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  return r
}

function makeFakeHooks() {
  const fire = vi.fn(async (_e: string, _p: FirePayload) => ({ allowed: true, results: [] }))
  return { engine: { fire } as unknown as HooksEngine, fire }
}

async function waitForNotification(pool: BackgroundTaskPool): Promise<void> {
  // The hook fires from a `void ... .catch()` microtask; allow it a tick.
  for (let i = 0; i < 20; i++) {
    if (pool.drainNotifications().length > 0) return
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('BackgroundTaskPool × HooksEngine', () => {
  it('does NOT fire Notification when no engine is set', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const id = await pool.start({ tool: 'echo', args: { value: 'hi' }, ctx: makeCtx() }, makeRegistry())
    await waitForNotification(pool)
    expect(pool.check(id)?.status).toBe('done')
  })

  it('fires Notification with taskStatus=completed on success', async () => {
    const { engine, fire } = makeFakeHooks()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), hooksEngine: engine })
    const id = await pool.start({ tool: 'echo', args: { value: 'hi' }, ctx: makeCtx() }, makeRegistry())
    await waitForNotification(pool)
    const notifCall = fire.mock.calls.find((c) => c[0] === 'Notification')
    expect(notifCall).toBeDefined()
    expect(notifCall![1]).toMatchObject({
      channel: 'background-task',
      taskId: id,
      taskStatus: 'completed',
      sessionId: 'bg-hooks-test',
      cwd: process.cwd(),
    })
    expect(notifCall![1]!.message).toMatch(/echo:hi/)
  })

  it('fires Notification with taskStatus=failed when tool returns isError', async () => {
    const { engine, fire } = makeFakeHooks()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), hooksEngine: engine })
    const id = await pool.start({ tool: 'always_fail', args: {}, ctx: makeCtx() }, makeRegistry())
    await waitForNotification(pool)
    const notifCall = fire.mock.calls.find((c) => c[0] === 'Notification')
    expect(notifCall).toBeDefined()
    expect(notifCall![1]).toMatchObject({
      taskId: id,
      taskStatus: 'failed',
    })
  })

  it('fires Notification with taskStatus=cancelled when pool is hard-aborted', async () => {
    const { engine, fire } = makeFakeHooks()
    const abort = new TwoLevelAbort()
    const pool = new BackgroundTaskPool({ abort, hooksEngine: engine })
    // Use a slow-ish tool so we have time to cancel.
    const slowRegistry = new ToolRegistry()
    slowRegistry.register({
      name: 'pause',
      description: 'pauses',
      schema: z.object({ ms: z.number() }),
      handler: async ({ ms }, ctx: ToolContext) => {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, ms)
          ctx.abort.hardSignal.addEventListener('abort', () => {
            clearTimeout(t)
            reject(new Error('cancelled'))
          })
        })
        return { content: 'never' }
      },
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 5_000,
      category: 'knowledge',
    })
    const id = await pool.start({ tool: 'pause', args: { ms: 5_000 }, ctx: makeCtx() }, slowRegistry)
    // Trigger hard-abort which cascades to cancelAll → cancel(id)
    abort.trigger('hard')
    await waitForNotification(pool)
    const notifCall = fire.mock.calls.find((c) => c[0] === 'Notification')
    expect(notifCall).toBeDefined()
    expect(notifCall![1]).toMatchObject({ taskId: id, taskStatus: 'cancelled' })
  })

  it('does not throw when the hook itself throws', async () => {
    const fire = vi.fn(async () => {
      throw new Error('hook boom')
    })
    const pool = new BackgroundTaskPool({
      abort: new TwoLevelAbort(),
      hooksEngine: { fire } as unknown as HooksEngine,
    })
    await expect(
      pool.start({ tool: 'echo', args: { value: 'x' }, ctx: makeCtx() }, makeRegistry()),
    ).resolves.toBeDefined()
    // Give the hook microtask a chance to fail silently.
    await new Promise((r) => setTimeout(r, 30))
    // Pool state remains healthy.
    expect(pool.list()).toHaveLength(1)
  })
})
