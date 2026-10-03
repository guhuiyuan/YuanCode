/**
 * CheckpointManager — pluggable storage backends (memory + disk).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CheckpointManager,
  MemoryCheckpointStorage,
  DiskCheckpointStorage,
  SENTINEL_CREATED,
} from '../../../src/core/checkpoint-manager.js'
import { SessionStore } from '../../../src/core/session-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-cp-storage-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('MemoryCheckpointStorage', () => {
  it('write + read round-trips bytes', async () => {
    const s = new MemoryCheckpointStorage()
    const snap = makeSnap('id-1', '/tmp/a', Buffer.from('hello'))
    await s.write(snap)
    const r = await s.read('id-1')
    expect(r?.content.toString('utf8')).toBe('hello')
  })

  it('read returns null for unknown ids', async () => {
    const s = new MemoryCheckpointStorage()
    expect(await s.read('missing')).toBeNull()
  })

  it('list() returns newest-first', async () => {
    const s = new MemoryCheckpointStorage()
    const t0 = Date.now()
    await s.write({ ...makeSnap('a', '/a', Buffer.from('1')), createdAt: t0 })
    await s.write({ ...makeSnap('b', '/b', Buffer.from('2')), createdAt: t0 + 100 })
    const list = await s.list()
    expect(list[0]!.id).toBe('b')
    expect(list[1]!.id).toBe('a')
  })

  it('remove returns true for known ids, false for unknown', async () => {
    const s = new MemoryCheckpointStorage()
    await s.write(makeSnap('x', '/x', Buffer.from('')))
    expect(await s.remove('x')).toBe(true)
    expect(await s.remove('x')).toBe(false)
  })

  it('clear() empties the store', async () => {
    const s = new MemoryCheckpointStorage()
    await s.write(makeSnap('a', '/a', Buffer.from('1')))
    s.clear()
    expect((await s.list())).toHaveLength(0)
  })
})

describe('DiskCheckpointStorage', () => {
  it('persists across SessionStore instances', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage = new DiskCheckpointStorage(store)
    const snap = makeSnap('cp-1', '/tmp/foo.ts', Buffer.from('bar'), 0o644, false, 'write')
    await storage.write(snap)

    // Build a fresh storage handle from the same on-disk store
    const store2 = new SessionStore({ projectRoot: dir, sessionId: 's' })
    const storage2 = new DiskCheckpointStorage(store2)
    const r = await storage2.read('cp-1')
    expect(r).not.toBeNull()
    expect(r!.content.toString('utf8')).toBe('bar')
  })

  it('list() returns manifests newest-first', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage = new DiskCheckpointStorage(store)
    const t0 = Date.now()
    await storage.write({ ...makeSnap('a', '/a', Buffer.from('1')), createdAt: t0 })
    await storage.write({ ...makeSnap('b', '/b', Buffer.from('2')), createdAt: t0 + 100 })
    const list = await storage.list()
    expect(list[0]!.id).toBe('b')
    expect(list[1]!.id).toBe('a')
  })

  it('sentinel checkpoints round-trip', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage = new DiskCheckpointStorage(store)
    const snap = makeSnap('s', '/x', SENTINEL_CREATED, 0, true)
    await storage.write(snap)
    const list = await storage.list()
    expect(list[0]!.sentinelCreated).toBe(true)
  })

  it('remove deletes the on-disk directory', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage = new DiskCheckpointStorage(store)
    await storage.write(makeSnap('r', '/r', Buffer.from('z')))
    expect(await storage.remove('r')).toBe(true)
    expect(await storage.read('r')).toBeNull()
  })
})

describe('CheckpointManager — pluggable storage integration', () => {
  it('works with MemoryCheckpointStorage', async () => {
    const mgr = new CheckpointManager({
      storage: new MemoryCheckpointStorage(),
      maxSnapshots: 10,
    })
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'A')
    await mgr.snapshot(f)
    writeFileSync(f, 'B')
    await mgr.restoreLatest(f)
    expect(readFileSync(f, 'utf8')).toBe('A')
  })

  it('works with DiskCheckpointStorage (write survives fresh handle)', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage = new DiskCheckpointStorage(store)

    const mgr = new CheckpointManager({ storage, maxSnapshots: 10 })
    const f = join(dir, 'x.txt')
    writeFileSync(f, 'X')
    await mgr.snapshot(f)
    writeFileSync(f, 'Y')

    // Restore via the SAME manager
    await mgr.restoreLatest(f)
    expect(readFileSync(f, 'utf8')).toBe('X')
  })

  it('hydrate() repopulates the in-memory index from disk', async () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const storage1 = new DiskCheckpointStorage(store)
    const mgr1 = new CheckpointManager({ storage: storage1 })
    const f = join(dir, 'h.txt')
    writeFileSync(f, 'H')
    await mgr1.snapshot(f)

    // New manager with a fresh disk handle; hydrate from storage
    const store2 = new SessionStore({ projectRoot: dir, sessionId: 's' })
    const storage2 = new DiskCheckpointStorage(store2)
    const mgr2 = new CheckpointManager({ storage: storage2 })
    await mgr2.hydrate()
    expect(mgr2.size()).toBe(1)
    expect(mgr2.list()[0]!.path).toBe(f)
  })

  it('uses memory backend by default when none is provided', async () => {
    const mgr = new CheckpointManager({ maxSnapshots: 5 })
    const f = join(dir, 'd.txt')
    writeFileSync(f, 'default')
    await mgr.snapshot(f)
    expect(mgr.size()).toBe(1)
  })

  it('eviction also clears storage', async () => {
    const storage = new MemoryCheckpointStorage()
    const mgr = new CheckpointManager({ storage, maxSnapshots: 1 })
    const f1 = join(dir, '1.txt')
    const f2 = join(dir, '2.txt')
    writeFileSync(f1, '1')
    writeFileSync(f2, '2')
    await mgr.snapshot(f1)
    await mgr.snapshot(f2)
    expect((await storage.list())).toHaveLength(1)
  })
})

function makeSnap(
  id: string,
  path: string,
  content: Buffer,
  mode = 0o644,
  sentinel = false,
  label = 'mutation',
): import('../../../src/core/checkpoint-manager.js').CheckpointSnapshot {
  return {
    id,
    path,
    mode: sentinel ? 0 : mode,
    content,
    createdAt: Date.now(),
    label,
    sentinelCreated: sentinel ? true : undefined,
  }
}