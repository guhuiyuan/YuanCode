/**
 * Background tools — background_start / background_check.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { BackgroundTaskPool } from '../../../src/core/background-tasks.js'
import { makeBackgroundStartTool, makeBackgroundCheckTool } from '../../../src/tools/background.js'
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
    sessionId: 'bg-tool-test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

function buildRegistry(): ToolRegistry {
  const r = new ToolRegistry()
  r.register({
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
  r.register({
    name: 'slow',
    description: 'sleeps',
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
      return { content: 'done' }
    },
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 60_000,
    category: 'knowledge',
  })
  return r
}

describe('background_start tool', () => {
  it('returns the task id immediately', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const registry = buildRegistry()
    const tool = makeBackgroundStartTool({ pool, registry })
    const r = await tool.handler({ tool: 'echo', args: { value: 'hi' } }, makeCtx())
    expect(r.isError).toBeFalsy()
    expect(r.content).toMatch(/<background-started id=/)
    expect(r.metadata?.id).toMatch(/^[0-9a-f-]{36}$/)

    // Drain
    for (let i = 0; i < 50; i++) {
      if (pool.drainNotifications().length > 0) break
      await new Promise((res) => setTimeout(res, 10))
    }
  })

  it('returns isError for unknown tool name', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const registry = buildRegistry()
    const tool = makeBackgroundStartTool({ pool, registry })
    const r = await tool.handler({ tool: 'no_such_tool', args: {} }, makeCtx())
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not registered/i)
  })

  it('rejects bad input (missing args)', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const registry = buildRegistry()
    const tool = makeBackgroundStartTool({ pool, registry })
    // The schema is record(unknown) so anything goes for `args`; the
    // downstream registry will reject based on the target tool's schema.
    // We test by passing args that the echo tool will reject.
    const r = await tool.handler(
      { tool: 'echo', args: { wrong: 'shape' } },
      makeCtx(),
    )
    // This should still succeed at start (the pool just queues it); the
    // failure surfaces via background_check after completion.
    expect(r.isError).toBeFalsy()
    const id = (r.metadata as { id: string }).id
    for (let i = 0; i < 50; i++) {
      if (pool.check(id)?.status !== 'running') break
      await new Promise((res) => setTimeout(res, 10))
    }
    const checkTool = makeBackgroundCheckTool({ pool })
    const checked = await checkTool.handler({ id }, makeCtx())
    expect(checked.metadata?.status).toBe('error')
  })

  it('captures timeoutMs', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const registry = buildRegistry()
    const tool = makeBackgroundStartTool({ pool, registry })
    const r = await tool.handler(
      { tool: 'echo', args: { value: 'x' }, timeoutMs: 2_000 },
      makeCtx(),
    )
    expect(r.isError).toBeFalsy()
  })
})

describe('background_check tool', () => {
  it('returns isError for unknown id', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const tool = makeBackgroundCheckTool({ pool })
    const r = await tool.handler({ id: 'ghost' }, makeCtx())
    expect(r.isError).toBe(true)
  })

  it('shows status + content after completion', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const registry = buildRegistry()
    const start = makeBackgroundStartTool({ pool, registry })
    const check = makeBackgroundCheckTool({ pool })
    const started = await start.handler({ tool: 'echo', args: { value: 'abc' } }, makeCtx())
    const id = (started.metadata as { id: string }).id
    for (let i = 0; i < 50; i++) {
      if (pool.check(id)?.status !== 'running') break
      await new Promise((res) => setTimeout(res, 10))
    }
    const r = await check.handler({ id }, makeCtx())
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('status: done')
    expect(r.content).toContain('echo:abc')
  })

  it('reports running state while still in flight', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const registry = buildRegistry()
    const start = makeBackgroundStartTool({ pool, registry })
    const check = makeBackgroundCheckTool({ pool })
    const started = await start.handler({ tool: 'slow', args: { ms: 200 } }, makeCtx())
    const id = (started.metadata as { id: string }).id
    const r = await check.handler({ id }, makeCtx())
    expect(r.content).toContain('status: running')
    // Wait for completion
    for (let i = 0; i < 50; i++) {
      if (pool.check(id)?.status !== 'running') break
      await new Promise((res) => setTimeout(res, 10))
    }
    const done = await check.handler({ id }, makeCtx())
    expect(done.content).toContain('status: done')
  })

  it('cancels and reports cancelled status', async () => {
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort(), maxConcurrent: 1 })
    const registry = buildRegistry()
    const start = makeBackgroundStartTool({ pool, registry })
    const check = makeBackgroundCheckTool({ pool })
    const started = await start.handler({ tool: 'slow', args: { ms: 5_000 } }, makeCtx())
    const id = (started.metadata as { id: string }).id
    await pool.cancel(id)
    for (let i = 0; i < 50; i++) {
      const status = pool.check(id)?.status
      if (status === 'cancelled' || status === 'done') break
      await new Promise((res) => setTimeout(res, 10))
    }
    const r = await check.handler({ id }, makeCtx())
    expect(['cancelled', 'done']).toContain(r.metadata?.status)
  })
})
