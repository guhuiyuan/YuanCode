/**
 * TaskManager — DAG CRUD + cycle detection + on-disk persistence.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskManager, TaskError } from '../../../src/core/task-manager.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-tm-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('TaskManager — create', () => {
  it('assigns a UUID, default status pending, and persists to disk', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'do the thing' })
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(t.status).toBe('pending')
    expect(t.deps).toEqual([])
    expect(existsSync(join(dir, '.yuancode', 'sessions', 's', 'tasks', `${t.id}.json`))).toBe(true)
  })

  it('stores description and deps', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', description: 'B desc', deps: [a.id] })
    expect(b.deps).toEqual([a.id])
    expect(b.description).toBe('B desc')
  })

  it('rejects a cycle', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', deps: [a.id] })
    await expect(m.update(a.id, { deps: [b.id] })).rejects.toThrow(/cycle/i)
  })

  it('rejects a self-loop on create', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    await expect(m.update(a.id, { deps: [a.id] })).rejects.toThrow(/cycle/i)
  })

  it('throws TaskError with code "cycle" on cycle', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', deps: [a.id] })
    try {
      await m.update(a.id, { deps: [b.id] })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TaskError)
      expect((e as TaskError).code).toBe('cycle')
    }
  })

  it('allows forward references (deps to tasks not yet created)', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'will be referenced', deps: ['00000000-0000-0000-0000-000000000000'] })
    expect(t.deps).toHaveLength(1)
  })
})

describe('TaskManager — update / status transitions', () => {
  it('transitions pending → in_progress → completed', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'flow' })
    await m.update(t.id, { status: 'in_progress' })
    expect((await m.get(t.id))?.status).toBe('in_progress')
    await m.update(t.id, { status: 'completed', result: 'done' })
    const final = await m.get(t.id)
    expect(final?.status).toBe('completed')
    expect(final?.result).toBe('done')
  })

  it('rejects illegal transition pending → completed', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'x' })
    try {
      await m.update(t.id, { status: 'completed' })
      expect.fail('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(TaskError)
      expect((e as TaskError).code).toBe('invalid_status')
    }
  })

  it('rejects illegal transition completed → in_progress', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'x' })
    await m.update(t.id, { status: 'in_progress' })
    await m.update(t.id, { status: 'completed' })
    try {
      await m.update(t.id, { status: 'in_progress' })
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as TaskError).code).toBe('invalid_status')
    }
  })

  it('allows in_progress → pending (release)', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'x' })
    await m.update(t.id, { status: 'in_progress' })
    await m.update(t.id, { status: 'pending' })
    expect((await m.get(t.id))?.status).toBe('pending')
  })

  it('throws "not_found" on unknown id', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    try {
      await m.update('nope', { status: 'in_progress' })
      expect.fail('should have thrown')
    } catch (e) {
      expect((e as TaskError).code).toBe('not_found')
    }
  })

  it('updates title and owner', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'orig' })
    await m.update(t.id, { title: 'new', owner: 'main' })
    const got = await m.get(t.id)
    expect(got?.title).toBe('new')
    expect(got?.owner).toBe('main')
  })
})

describe('TaskManager — list / get / delete', () => {
  it('list returns all non-deleted tasks, sorted by createdAt', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'first' })
    await new Promise((r) => setTimeout(r, 5))
    const b = await m.create({ title: 'second' })
    const list = await m.list()
    expect(list.map((t) => t.id)).toEqual([a.id, b.id])
  })

  it('list with status filter', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b' })
    await m.update(a.id, { status: 'in_progress' })
    expect((await m.list({ status: 'in_progress' })).map((t) => t.id)).toEqual([a.id])
    expect((await m.list({ status: 'pending' })).map((t) => t.id)).toEqual([b.id])
  })

  it('get returns null for deleted', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'x' })
    await m.delete(t.id)
    expect(await m.get(t.id)).toBeNull()
  })

  it('delete removes the disk file', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const t = await m.create({ title: 'x' })
    const path = join(dir, '.yuancode', 'sessions', 's', 'tasks', `${t.id}.json`)
    expect(existsSync(path)).toBe(true)
    await m.delete(t.id)
    expect(existsSync(path)).toBe(false)
  })

  it('delete returns false for unknown id', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    expect(await m.delete('nope')).toBe(false)
  })
})

describe('TaskManager — nextUnblocked', () => {
  it('returns pending tasks whose deps are all completed', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', deps: [a.id] })

    // a has no deps → unblocked
    let ready = await m.nextUnblocked()
    expect(ready.map((t) => t.id)).toEqual([a.id])

    // a in_progress → not pending → not returned; b is still blocked
    await m.update(a.id, { status: 'in_progress' })
    ready = await m.nextUnblocked()
    expect(ready.map((t) => t.id)).toEqual([])

    // a completed → b unblocked
    await m.update(a.id, { status: 'completed' })
    ready = await m.nextUnblocked()
    expect(ready.map((t) => t.id)).toEqual([b.id])
  })

  it('skips pending tasks with in_progress deps', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', deps: [a.id] })
    await m.update(a.id, { status: 'in_progress' })
    const ready = await m.nextUnblocked()
    // a is no longer pending, b is still blocked → ready is empty
    expect(ready.map((t) => t.id)).toEqual([])
  })

  it('treats deleted deps as resolved', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const a = await m.create({ title: 'a' })
    const b = await m.create({ title: 'b', deps: [a.id] })
    await m.delete(a.id)
    const ready = await m.nextUnblocked()
    expect(ready.map((t) => t.id)).toEqual([b.id])
  })

  it('treats missing deps as resolved (forward refs)', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const b = await m.create({ title: 'b', deps: ['never-existed'] })
    const ready = await m.nextUnblocked()
    expect(ready.map((t) => t.id)).toEqual([b.id])
  })
})

describe('TaskManager — on-disk persistence', () => {
  it('load() reads tasks back from disk', async () => {
    const m1 = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    await m1.create({ title: 'persistent' })
    const m2 = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const list = await m2.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('persistent')
  })

  it('handles missing tasks directory gracefully', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 'never-used' })
    expect(await m.list()).toEqual([])
  })

  it('skips corrupt task files instead of crashing', async () => {
    // Pre-populate the tasks dir with a junk file
    const m1 = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    await m1.create({ title: 'good' })
    const tasksDir = join(dir, '.yuancode', 'sessions', 's', 'tasks')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(tasksDir, 'corrupt.json'), 'not json')

    const m2 = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    const list = await m2.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.title).toBe('good')
    expect(readdirSync(tasksDir).length).toBe(2) // 1 good + 1 corrupt
  })
})

describe('TaskManager — pub/sub', () => {
  it('fires on create/update/delete', async () => {
    const m = await TaskManager.load({ projectRoot: dir, sessionId: 's' })
    let count = 0
    m.subscribe(() => count++)
    await m.create({ title: 'a' })
    await m.create({ title: 'b' })
    expect(count).toBe(2)
  })
})