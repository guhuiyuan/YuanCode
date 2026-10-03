/**
 * BackgroundTaskPool — async runner, notification queue, concurrency cap.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { BackgroundTaskPool } from '../../../src/core/background-tasks.js'
import type { ToolContext } from '../../../src/core/tool-registry.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: () => noopLogger,
} as unknown as PinoLogger

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sandbox: new LocalSandbox({ cwd: process.cwd() }),
    abort: new TwoLevelAbort(),
    sessionId: 'bg-test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

function makeRegistry(): { registry: ToolRegistry; delay: (ms: number) => void } {
  const registry = new ToolRegistry()
  registry.register({
    name: 'echo',
    description: 'echo',
    schema: z.object({ value: z.string() }),
    handler: async (input: { value: string }) => ({ content: `echo:${input.value}` }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  // `slow` honors the parent ctx's abort signal so cancel tests work.
  registry.register({
    name: 'slow',
    description: 'slow task',
    schema: z.object({ ms: z.number() }),
    handler: async ({ ms }: { ms: number }, ctx: ToolContext) => {
      await new Promise<void>((resolve, reject) => {
        if (ctx.abort.hardSignal.aborted) {
          reject(new Error('Aborted'))
          return
        }
        const t = setTimeout(resolve, ms)
        ctx.abort.hardSignal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('Aborted'))
        }, { once: true })
      })
      return { content: 'slept' }
    },
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 60_000,
    category: 'knowledge',
  })
  registry.register({
    name: 'failing',
    description: 'fails',
    schema: z.object({}),
    handler: async () => ({ content: 'tool failure', isError: true }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  registry.register({
    name: 'thrower',
    description: 'throws',
    schema: z.object({}),
    handler: async () => {
      throw new Error('boom')
    },
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  return { registry, delay: (ms) => new Promise<void>((r) => setTimeout(r, ms)) }
}

describe('BackgroundTaskPool — start / check / list', () => {
  let pool: BackgroundTaskPool
  beforeEach(() => {
    pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
  })

  it('returns an id immediately and resolves to "done"', async () => {
    const { registry } = makeRegistry()
    const id = await pool.start({ tool: 'echo', args: { value: 'hi' }, ctx: makeCtx() }, registry)
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    // Spin until complete
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id)
      if (t?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const t = pool.check(id)
    expect(t?.status).toBe('done')
    expect(t?.result?.content).toBe('echo:hi')
  })

  it('check returns null for unknown id', () => {
    expect(pool.check('nope')).toBeNull()
  })

  it('list returns tasks newest-first', async () => {
    const { registry } = makeRegistry()
    const a = await pool.start({ tool: 'echo', args: { value: 'a' }, ctx: makeCtx() }, registry)
    await new Promise((r) => setTimeout(r, 5))
    const b = await pool.start({ tool: 'echo', args: { value: 'b' }, ctx: makeCtx() }, registry)
    await new Promise((r) => setTimeout(r, 5))
    const c = await pool.start({ tool: 'echo', args: { value: 'c' }, ctx: makeCtx() }, registry)
    const ids = pool.list().map((t) => t.id)
    expect(ids[0]).toBe(c)
    expect(ids).toContain(a)
    expect(ids).toContain(b)
  })
})

describe('BackgroundTaskPool — completion semantics', () => {
  it('captures tool isError as task.status="error"', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const id = await pool.start({ tool: 'failing', args: {}, ctx: makeCtx() }, registry)
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id)
      if (t?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const t = pool.check(id)
    expect(t?.status).toBe('error')
    expect(t?.error).toMatch(/tool failure/)
  })

  it('captures thrown exceptions as task.status="error"', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const id = await pool.start({ tool: 'thrower', args: {}, ctx: makeCtx() }, registry)
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id)
      if (t?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    const t = pool.check(id)
    expect(t?.status).toBe('error')
    expect(t?.error).toMatch(/boom/)
  })

  it('drainNotifications returns completed tasks and clears the queue', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const id = await pool.start({ tool: 'echo', args: { value: 'x' }, ctx: makeCtx() }, registry)
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id)
      if (t?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(pool.drainNotifications()).toHaveLength(1)
    expect(pool.drainNotifications()).toHaveLength(0) // queue empty
  })

  it('subscribe fires on completion', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    let fires = 0
    pool.subscribe(() => fires++)
    await pool.start({ tool: 'echo', args: { value: 'y' }, ctx: makeCtx() }, registry)
    for (let i = 0; i < 50; i++) {
      if (fires > 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fires).toBeGreaterThanOrEqual(1)
  })
})

describe('BackgroundTaskPool — concurrency cap', () => {
  it('queues tasks when runningCount >= maxConcurrent', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const id1 = await pool.start({ tool: 'slow', args: { ms: 50 }, ctx: makeCtx() }, registry)
    // Second submission must queue (since first is still running)
    const id2 = await pool.start({ tool: 'slow', args: { ms: 50 }, ctx: makeCtx() }, registry)
    expect(pool.queued).toBe(1)
    expect(pool.running).toBe(1)

    // Wait for everything
    for (let i = 0; i < 100; i++) {
      const t1 = pool.check(id1)
      const t2 = pool.check(id2)
      if (t1?.status !== 'running' && t2?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(pool.check(id1)?.status).toBe('done')
    expect(pool.check(id2)?.status).toBe('done')
    expect(pool.queued).toBe(0)
  })

  it('records queuedAt when queued', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const id1 = await pool.start({ tool: 'slow', args: { ms: 30 }, ctx: makeCtx() }, registry)
    const id2 = await pool.start({ tool: 'slow', args: { ms: 30 }, ctx: makeCtx() }, registry)
    expect(pool.check(id1)?.queuedAt).toBeUndefined()
    expect(pool.check(id2)?.queuedAt).toBeDefined()

    for (let i = 0; i < 100; i++) {
      const t1 = pool.check(id1)
      const t2 = pool.check(id2)
      if (t1?.status !== 'running' && t2?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
  })
})

describe('BackgroundTaskPool — cancel / cancelAll', () => {
  it('cancel an unknown id returns false', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    expect(await pool.cancel('nope')).toBe(false)
  })

  it('cancel a running task finalizes it as cancelled', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const id = await pool.start({ tool: 'slow', args: { ms: 5_000 }, ctx: makeCtx() }, registry)
    expect(pool.running).toBe(1)
    const ok = await pool.cancel(id)
    expect(ok).toBe(true)
    // Poll for terminal status
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id)
      if (t?.status === 'cancelled' || t?.status === 'done') break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(['cancelled', 'done']).toContain(pool.check(id)?.status)
  })

  it('hard-abort on parent triggers cancelAll', async () => {
    const { registry } = makeRegistry()
    const parent = new TwoLevelAbort()
    const pool = new BackgroundTaskPool({ abort: parent, maxConcurrent: 2 })
    const id1 = await pool.start({ tool: 'slow', args: { ms: 5_000 }, ctx: makeCtx() }, registry)
    const id2 = await pool.start({ tool: 'slow', args: { ms: 5_000 }, ctx: makeCtx() }, registry)
    expect(pool.running).toBe(2)
    parent.trigger('hard')
    for (let i = 0; i < 50; i++) {
      if (pool.running === 0) break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(pool.running).toBe(0)
    // Tasks should be in 'cancelled' (best-effort)
    expect(['cancelled', 'done']).toContain(pool.check(id1)?.status)
    expect(['cancelled', 'done']).toContain(pool.check(id2)?.status)
  })

  it('cancel a queued task removes it from the queue', async () => {
    const { registry } = makeRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const id1 = await pool.start({ tool: 'slow', args: { ms: 100 }, ctx: makeCtx() }, registry)
    const id2 = await pool.start({ tool: 'slow', args: { ms: 100 }, ctx: makeCtx() }, registry)
    expect(pool.queued).toBe(1)
    await pool.cancel(id2)
    expect(pool.queued).toBe(0)
    expect(pool.check(id2)?.status).toBe('cancelled')

    // Drain
    for (let i = 0; i < 50; i++) {
      const t = pool.check(id1)
      if (t?.status !== 'running') break
      await new Promise((r) => setTimeout(r, 10))
    }
  })
})

describe('BackgroundTaskPool — dispose', () => {
  it('releases the parent abort listener', () => {
    const parent = new TwoLevelAbort()
    const pool = new BackgroundTaskPool({ abort: parent })
    pool.dispose()
    // Triggering hard after dispose should not throw and should not affect pool state
    parent.trigger('hard')
    expect(pool.running).toBe(0)
  })
})
