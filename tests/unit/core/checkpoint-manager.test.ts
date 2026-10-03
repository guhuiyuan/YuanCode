/**
 * CheckpointManager — snapshot/restore/pop/list/LRU eviction.
 *
 * Tests use os.tmpdir() with mkdtempSync so each run is isolated and
 * does not pollute the project tree.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CheckpointManager,
  SENTINEL_CREATED,
} from '../../../src/core/checkpoint-manager.js'

let dir: string
let mgr: CheckpointManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-cp-'))
  mgr = new CheckpointManager({ maxSnapshots: 10 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CheckpointManager — snapshot existing files', () => {
  it('captures bytes verbatim', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'hello world', 'utf8')
    const id = await mgr.snapshot(f, 'before edit')
    expect(id).toBeTypeOf('string')
    expect(mgr.size()).toBe(1)
    const listed = mgr.list(f)
    expect(listed[0]?.content.toString('utf8')).toBe('hello world')
    expect(listed[0]?.label).toBe('before edit')
  })

  it('records the file mode', async () => {
    const f = join(dir, 'm.txt')
    writeFileSync(f, 'x')
    await mgr.snapshot(f)
    const [s] = mgr.list(f)
    expect(s?.mode).toBeGreaterThan(0)
  })

  it('snapshot of nonexistent file uses SENTINEL_CREATED', async () => {
    const f = join(dir, 'new.txt')
    await mgr.snapshot(f)
    const [s] = mgr.list(f)
    expect(s?.content).toBe(SENTINEL_CREATED)
    expect(s?.mode).toBe(0)
  })
})

describe('CheckpointManager — restoreLatest', () => {
  it('restores the most recent snapshot, removing the file when sentinel', async () => {
    const f = join(dir, 'del.txt')
    // Snapshot pre-create, then write, then restore
    await mgr.snapshot(f)
    writeFileSync(f, 'created', 'utf8')
    expect(existsSync(f)).toBe(true)
    const restoredId = await mgr.restoreLatest(f)
    expect(restoredId).toBeTypeOf('string')
    expect(existsSync(f)).toBe(false)
  })

  it('restores the original bytes for an existing file', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'ORIGINAL', 'utf8')
    await mgr.snapshot(f)
    writeFileSync(f, 'OVERWRITTEN', 'utf8')
    await mgr.restoreLatest(f)
    expect(readFileSync(f, 'utf8')).toBe('ORIGINAL')
  })

  it('walks back multiple snapshots in LIFO order', async () => {
    const f = join(dir, 'v.txt')
    // Pre-create snapshot (sentinel: file did not exist)
    await mgr.snapshot(f)
    writeFileSync(f, 'v1', 'utf8')
    await mgr.snapshot(f)
    writeFileSync(f, 'v2', 'utf8')
    await mgr.snapshot(f)
    writeFileSync(f, 'v3', 'utf8')

    await mgr.restoreLatest(f)
    expect(readFileSync(f, 'utf8')).toBe('v2')
    await mgr.restoreLatest(f)
    expect(readFileSync(f, 'utf8')).toBe('v1')
    await mgr.restoreLatest(f)
    expect(existsSync(f)).toBe(false) // sentinel → file removed
  })

  it('returns null when there is nothing to restore', async () => {
    const f = join(dir, 'never-snapshotted.txt')
    const r = await mgr.restoreLatest(f)
    expect(r).toBeNull()
  })
})

describe('CheckpointManager — list & pop', () => {
  it('list() without path returns all snapshots newest-first', async () => {
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    writeFileSync(f1, 'a')
    writeFileSync(f2, 'b')
    await mgr.snapshot(f1)
    await mgr.snapshot(f2)
    const all = mgr.list()
    expect(all).toHaveLength(2)
    // Newest first → f2 was snapshotted second
    expect(all[0]?.path).toBe(f2)
    expect(all[1]?.path).toBe(f1)
  })

  it('list(path) filters to a single file', async () => {
    const f1 = join(dir, 'a.txt')
    const f2 = join(dir, 'b.txt')
    writeFileSync(f1, 'a')
    writeFileSync(f2, 'b')
    await mgr.snapshot(f1)
    await mgr.snapshot(f2)
    await mgr.snapshot(f1)
    expect(mgr.list(f1)).toHaveLength(2)
    expect(mgr.list(f2)).toHaveLength(1)
  })

  it('pop() returns the most recent snapshot without applying it', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'A')
    await mgr.snapshot(f)
    writeFileSync(f, 'B')
    const popped = mgr.pop()
    expect(popped?.content.toString('utf8')).toBe('A')
    expect(readFileSync(f, 'utf8')).toBe('B') // file untouched
    expect(mgr.size()).toBe(0)
  })

  it('pop() returns undefined when empty', () => {
    expect(mgr.pop()).toBeUndefined()
  })
})

describe('CheckpointManager — LRU eviction', () => {
  it('evicts the oldest snapshot when over the cap', async () => {
    const tiny = new CheckpointManager({ maxSnapshots: 2 })
    const f = join(dir, 'a.txt')
    writeFileSync(f, '1')
    await tiny.snapshot(f)
    writeFileSync(f, '2')
    await tiny.snapshot(f)
    writeFileSync(f, '3')
    await tiny.snapshot(f)
    expect(tiny.size()).toBe(2)
    const all = tiny.list()
    // Oldest (content '1') should be evicted
    expect(all.map((s) => s.content.toString('utf8'))).toEqual(['3', '2'])
  })
})
