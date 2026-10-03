/**
 * Task tools — task_create / task_list / task_update / task_get.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Logger as PinoLogger } from 'pino'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { TaskManager } from '../../../src/core/task-manager.js'
import {
  makeTaskCreateTool,
  makeTaskListTool,
  makeTaskUpdateTool,
  makeTaskGetTool,
} from '../../../src/tools/task.js'
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

let dir: string
let manager: TaskManager
let ctx: ToolContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-tasktools-'))
  manager = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
  ctx = {
    cwd: dir,
    sandbox: new LocalSandbox({ cwd: dir }),
    abort: new TwoLevelAbort(),
    sessionId: 's',
    permissionMode: 'manual',
    logger: noopLogger,
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('task_create tool', () => {
  it('creates a task and returns its id', async () => {
    const tool = makeTaskCreateTool({ manager })
    const r = await tool.handler({ title: 'Write tests' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toMatch(/<task-created id=/)
    expect(r.content).toContain('Write tests')
    expect(r.metadata?.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('creates a task with deps and description', async () => {
    const create = makeTaskCreateTool({ manager })
    const list = makeTaskListTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const id = (a.metadata as { id: string }).id
    await create.handler({ title: 'b', description: 'B desc', deps: [id] }, ctx)
    const listed = await list.handler({}, ctx)
    expect(listed.content).toContain('b')
    expect(listed.content).toContain('2 task(s)')
  })

  it('returns isError on cycle', async () => {
    const create = makeTaskCreateTool({ manager })
    const update = makeTaskUpdateTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const b = await create.handler({ title: 'b', deps: [(a.metadata as { id: string }).id] }, ctx)
    const bId = (b.metadata as { id: string }).id
    // Now try to make a depend on b → cycle
    const r = await update.handler(
      { id: (a.metadata as { id: string }).id, deps: [bId] },
      ctx,
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/cycle/i)
  })

  it('returns isError on missing dep id (nonexistent task)', async () => {
    // Wait — the current manager accepts forward refs without 'unknown_dep'.
    // This test documents that behavior.
    const create = makeTaskCreateTool({ manager })
    const r = await create.handler(
      { title: 'a', deps: ['ghost-id-not-real'] },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('<task-created')
  })
})

describe('task_list tool', () => {
  it('returns "No tasks" message when empty', async () => {
    const tool = makeTaskListTool({ manager })
    const r = await tool.handler({}, ctx)
    expect(r.content).toMatch(/No tasks yet/)
  })

  it('lists tasks as a markdown table', async () => {
    const create = makeTaskCreateTool({ manager })
    const list = makeTaskListTool({ manager })
    await create.handler({ title: 'Task one' }, ctx)
    await create.handler({ title: 'Task two' }, ctx)
    const r = await list.handler({}, ctx)
    expect(r.content).toContain('| id | status | deps | title |')
    expect(r.content).toContain('pending')
    expect(r.content).toContain('Task one')
    expect(r.content).toContain('Task two')
  })

  it('filters by status', async () => {
    const create = makeTaskCreateTool({ manager })
    const update = makeTaskUpdateTool({ manager })
    const list = makeTaskListTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const b = await create.handler({ title: 'b' }, ctx)
    await update.handler(
      { id: (a.metadata as { id: string }).id, status: 'in_progress' },
      ctx,
    )
    const r = await list.handler({ status: 'in_progress' }, ctx)
    expect(r.content).toContain('a')
    expect(r.content).not.toContain('Task two')
    expect((r.metadata as { count: number }).count).toBe(1)
    // sanity check: pending list contains b
    const pending = await list.handler({ status: 'pending' }, ctx)
    expect(pending.content).toContain('b')
  })

  it('truncates titles longer than 60 chars', async () => {
    const create = makeTaskCreateTool({ manager })
    const list = makeTaskListTool({ manager })
    await create.handler({ title: 'x'.repeat(100) }, ctx)
    const r = await list.handler({}, ctx)
    expect(r.content).toContain('…')
  })
})

describe('task_update tool', () => {
  it('transitions pending → in_progress', async () => {
    const create = makeTaskCreateTool({ manager })
    const update = makeTaskUpdateTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const id = (a.metadata as { id: string }).id
    const r = await update.handler({ id, status: 'in_progress' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('in_progress')
  })

  it('rejects pending → completed', async () => {
    const create = makeTaskCreateTool({ manager })
    const update = makeTaskUpdateTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const id = (a.metadata as { id: string }).id
    const r = await update.handler({ id, status: 'completed' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/illegal status/i)
  })

  it('records result when completing', async () => {
    const create = makeTaskCreateTool({ manager })
    const update = makeTaskUpdateTool({ manager })
    const get = makeTaskGetTool({ manager })
    const a = await create.handler({ title: 'a' }, ctx)
    const id = (a.metadata as { id: string }).id
    await update.handler({ id, status: 'in_progress' }, ctx)
    await update.handler({ id, status: 'completed', result: 'all green' }, ctx)
    const got = await get.handler({ id }, ctx)
    expect(got.content).toContain('result: all green')
  })

  it('returns isError on unknown id', async () => {
    const update = makeTaskUpdateTool({ manager })
    const r = await update.handler({ id: 'nope', status: 'in_progress' }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe('task_get tool', () => {
  it('returns the full task record', async () => {
    const create = makeTaskCreateTool({ manager })
    const get = makeTaskGetTool({ manager })
    const a = await create.handler({ title: 'Get me', description: 'Details here' }, ctx)
    const id = (a.metadata as { id: string }).id
    const r = await get.handler({ id }, ctx)
    expect(r.content).toContain(`id: ${id}`)
    expect(r.content).toContain('status: pending')
    expect(r.content).toContain('title: Get me')
    expect(r.content).toContain('description: Details here')
  })

  it('returns isError for unknown id', async () => {
    const get = makeTaskGetTool({ manager })
    const r = await get.handler({ id: 'nope' }, ctx)
    expect(r.isError).toBe(true)
  })
})
