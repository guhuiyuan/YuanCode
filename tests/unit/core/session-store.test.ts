/**
 * SessionStore — on-disk JSONL + JSON persistence + checkpoint files.
 *
 * Each test uses a fresh mkdtemp directory so the project tree is never
 * polluted and tests run in parallel safely.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStore } from '../../../src/core/session-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-session-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SessionStore — directory layout', () => {
  it('ensure() creates the session + checkpoints directory', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 'abc' })
    store.ensure()
    expect(existsSync(join(store.rootDir, 'events.jsonl'))).toBe(false)
    expect(existsSync(store.rootDir)).toBe(true)
    expect(existsSync(join(store.rootDir, 'checkpoints'))).toBe(true)
  })

  it('rootDir follows the documented layout', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's1' })
    expect(store.rootDir).toBe(join(dir, '.yuancode', 'sessions', 's1'))
  })
})

describe('SessionStore — events', () => {
  it('appends a single JSON-encoded line per call', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    store.appendEvent({
      ts: 1,
      kind: 'session_start',
      sessionId: 's',
      cwd: dir,
      model: 'MiniMax-M3',
    })
    store.appendEvent({
      ts: 2,
      kind: 'user_prompt',
      sessionId: 's',
      text: 'hello',
    })
    const text = readFileSync(join(store.rootDir, 'events.jsonl'), 'utf8')
    const lines = text.split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ kind: 'session_start' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ kind: 'user_prompt', text: 'hello' })
  })

  it('readEvents returns events oldest-first, skipping malformed lines', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    store.appendEvent({ ts: 1, kind: 'user_prompt', sessionId: 's', text: 'a' })
    store.appendEvent({ ts: 2, kind: 'user_prompt', sessionId: 's', text: 'b' })
    // Inject a malformed line — store must skip it gracefully
    const fs = require('node:fs') as typeof import('node:fs')
    fs.appendFileSync(join(store.rootDir, 'events.jsonl'), 'this is not json\n')
    store.appendEvent({ ts: 3, kind: 'user_prompt', sessionId: 's', text: 'c' })

    const events = store.readEvents()
    expect(events.map((e) => (e as { text?: string }).text)).toEqual(['a', 'b', 'c'])
  })

  it('readEvents on a missing log returns []', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    expect(store.readEvents()).toEqual([])
  })
})

describe('SessionStore — state', () => {
  it('getState() lazily creates a default state', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    const s = store.getState()
    expect(s.sessionId).toBe('') // default sentinel
    expect(s.meta).toEqual({})
  })

  it('saveState persists to disk and merges with existing', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    store.saveState({ sessionId: 's', cwd: dir, model: 'MiniMax-M3' })
    store.saveState({ meta: { steps: 5 } })

    const reloaded = new SessionStore({ projectRoot: dir, sessionId: 's' })
    const state = reloaded.getState()
    expect(state.sessionId).toBe('s')
    expect(state.model).toBe('MiniMax-M3')
    expect(state.meta).toEqual({ steps: 5 })
  })
})

describe('SessionStore — checkpoints', () => {
  it('writeCheckpoint + readCheckpoint round-trips bytes', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const manifest = store.writeCheckpoint({
      path: '/tmp/foo.ts',
      content: Buffer.from('hello', 'utf8'),
      mode: 0o644,
      label: 'write',
    })
    const cp = store.readCheckpoint(manifest.id)
    expect(cp).not.toBeNull()
    expect(cp!.manifest.label).toBe('write')
    expect(cp!.content.toString('utf8')).toBe('hello')
  })

  it('sentinel checkpoints restore to "delete"', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const manifest = store.writeCheckpoint({
      path: '/tmp/new.ts',
      content: Buffer.from('placeholder', 'utf8'),
      mode: 0,
      label: 'create',
      sentinelCreated: true,
    })
    const cp = store.readCheckpoint(manifest.id)
    expect(cp!.manifest.sentinelCreated).toBe(true)
  })

  it('listCheckpoints returns manifests newest-first', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const a = store.writeCheckpoint({
      path: '/a.ts',
      content: Buffer.from('1'),
      mode: 0o644,
      label: 'a',
    })
    const b = store.writeCheckpoint({
      path: '/b.ts',
      content: Buffer.from('2'),
      mode: 0o644,
      label: 'b',
    })
    const list = store.listCheckpoints()
    expect(list).toHaveLength(2)
    expect(list[0]!.id).toBe(b.id)
    expect(list[1]!.id).toBe(a.id)
  })

  it('deleteCheckpoint removes the directory', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const cp = store.writeCheckpoint({
      path: '/tmp/x.ts',
      content: Buffer.from('xx'),
      mode: 0o644,
      label: 'x',
    })
    expect(store.deleteCheckpoint(cp.id)).toBe(true)
    expect(store.readCheckpoint(cp.id)).toBeNull()
    // Deleting again returns false
    expect(store.deleteCheckpoint(cp.id)).toBe(false)
  })

  it('gcCheckpoints keeps the newest N', () => {
    const store = new SessionStore({ projectRoot: dir, sessionId: 's' })
    store.ensure()
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const m = store.writeCheckpoint({
        path: `/${i}.ts`,
        content: Buffer.from(String(i)),
        mode: 0o644,
        label: `cp-${i}`,
      })
      ids.push(m.id)
    }
    const dropped = store.gcCheckpoints(2)
    expect(dropped).toBe(3)
    expect(store.listCheckpoints()).toHaveLength(2)
  })
})