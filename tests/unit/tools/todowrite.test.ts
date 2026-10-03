/**
 * todowrite tool — store + tool handler.
 */
import { describe, expect, it } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { makeTodowriteTool, makeTodoStore } from '../../../src/tools/todowrite.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'

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

function ctx(): import('../../../src/core/tool-registry.js').ToolContext {
  return {
    cwd: process.cwd(),
    sandbox: new LocalSandbox({ cwd: process.cwd() }) as unknown as import('../../../src/core/sandbox/runner.js').SandboxRunner,
    abort: new TwoLevelAbort(),
    sessionId: 'test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

describe('TodoStore', () => {
  it('starts empty', () => {
    const s = makeTodoStore()
    expect(s.items).toHaveLength(0)
    expect(s.activeForm()).toBeUndefined()
  })

  it('replaces the full list on set()', () => {
    const s = makeTodoStore()
    s.set([
      { status: 'completed', content: 'A', activeForm: 'a' },
      { status: 'in_progress', content: 'B', activeForm: 'Doing B' },
    ])
    expect(s.items).toHaveLength(2)
    expect(s.activeForm()).toBe('Doing B')
    s.set([{ status: 'pending', content: 'C', activeForm: 'c' }])
    expect(s.items).toHaveLength(1)
    expect(s.items[0]?.content).toBe('C')
  })
})

describe('todowrite tool', () => {
  it('replaces the store and renders a markdown checklist', async () => {
    const store = makeTodoStore()
    const tool = makeTodowriteTool({ store })
    const r = await tool.handler(
      {
        items: [
          { status: 'completed', content: 'Plan', activeForm: 'Planning' },
          { status: 'in_progress', content: 'Build', activeForm: 'Building' },
          { status: 'pending', content: 'Test', activeForm: 'Testing' },
        ],
      },
      ctx(),
    )
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('[x] Plan')
    expect(r.content).toContain('[~] Build')
    expect(r.content).toContain('[ ] Test')
    expect(r.content).toContain('1/3 done')
    expect(store.activeForm()).toBe('Building')
  })

  it('returns isError when more than one item is in_progress', async () => {
    const store = makeTodoStore()
    const tool = makeTodowriteTool({ store })
    const r = await tool.handler(
      {
        items: [
          { status: 'in_progress', content: 'A', activeForm: 'a' },
          { status: 'in_progress', content: 'B', activeForm: 'b' },
        ],
      },
      ctx(),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/At most one/)
    // store should be untouched
    expect(store.items).toHaveLength(0)
  })

  it('rejects empty item list', async () => {
    const store = makeTodoStore()
    const tool = makeTodowriteTool({ store })
    const r = await tool.handler({ items: [] }, ctx())
    expect(r.isError).toBe(true)
  })
})
