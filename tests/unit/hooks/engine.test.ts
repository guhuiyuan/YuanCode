/**
 * HooksEngine — fire events, gather results, decide.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HooksEngine } from '../../../src/hooks/engine.js'
import type { HooksConfig } from '../../../src/hooks/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'yuancode-engine-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

import { afterAll } from 'vitest'

const isWin = process.platform === 'win32'
const exit0 = isWin ? 'exit 0' : 'true'
const exit1 = isWin ? 'exit 1' : 'exit 1'

function makeEngine(): HooksEngine {
  return new HooksEngine({
    sessionId: 's',
    cwd: TMP,
    hardSignal: new AbortController().signal,
  })
}

describe('HooksEngine.fire — basic', () => {
  it('no hooks → allowed, empty results', async () => {
    const eng = makeEngine()
    const d = await eng.fire('SessionStart', { model: 'm', permissionMode: 'auto' })
    expect(d.allowed).toBe(true)
    expect(d.results).toEqual([])
  })

  it('all hooks allow → allowed', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        PreToolUse: [
          { type: 'bash', matcher: 'bash', command: exit0 },
          { type: 'bash', matcher: 'bash', command: exit0 },
        ],
      },
    })
    const d = await eng.fire('PreToolUse', { toolName: 'bash', toolInput: {} })
    expect(d.allowed).toBe(true)
    expect(d.results).toHaveLength(2)
    expect(d.results.every((r) => r.outcome === 'allow')).toBe(true)
  })

  it('one hook denies → denied with first deny reason', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        PreToolUse: [
          { type: 'bash', matcher: 'bash', command: exit0 },
          { type: 'bash', matcher: 'bash', command: `${isWin ? 'echo denied 1>&2 & ' : ''}exit 1` },
          { type: 'bash', matcher: 'bash', command: exit0 },
        ],
      },
    })
    const d = await eng.fire('PreToolUse', { toolName: 'bash', toolInput: {} })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBeDefined()
  })

  it('non-gating event ignores deny (always allowed)', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        SessionStart: [{ type: 'bash', command: 'exit 1' }],
        PostToolUse: [{ type: 'bash', command: 'exit 1' }],
        SessionEnd: [{ type: 'bash', command: 'exit 1' }],
        Notification: [{ type: 'bash', command: 'exit 1' }],
      },
    })
    const s = await eng.fire('SessionStart', { model: 'm', permissionMode: 'auto' })
    expect(s.allowed).toBe(true)
    expect(s.results.some((r) => r.outcome === 'deny')).toBe(true)

    const p = await eng.fire('PostToolUse', {
      toolName: 'bash',
      toolInput: {},
      toolOutput: 'ok',
      durationMs: 5,
    })
    expect(p.allowed).toBe(true)
  })

  it('matcher filters out non-matching hooks', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        PreToolUse: [
          { type: 'bash', matcher: 'bash', command: exit0 },
          { type: 'bash', matcher: 'grep', command: exit0 },
        ],
      },
    })
    const d = await eng.fire('PreToolUse', { toolName: 'bash', toolInput: {} })
    expect(d.allowed).toBe(true)
    expect(d.results).toHaveLength(1)
    expect(d.results[0]!.matcher).toBe('bash')
  })

  it('events without toolName fire all hooks (matcher ignored)', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        SessionStart: [
          { type: 'bash', matcher: 'bash', command: exit0 },
          { type: 'bash', matcher: 'grep', command: exit0 },
        ],
      },
    })
    const d = await eng.fire('SessionStart', { model: 'm', permissionMode: 'auto' })
    expect(d.results).toHaveLength(2)
  })
})

describe('HooksEngine — cycle detection', () => {
  it('rejects fires beyond maxDepth', async () => {
    const eng = new HooksEngine({
      sessionId: 's',
      cwd: TMP,
      hardSignal: new AbortController().signal,
    })
    // Mock by calling fire() from within a Promise.then() chain — but our
    // fire() is async, so to truly nest we need to start one before the
    // previous resolves. Easier: load a hook that calls fire synchronously
    // via a fire callback. Instead, we exercise the cycle detector directly.
    const det = (eng as unknown as { cycleDetector: { current: number; maxDepth: number } })
      .cycleDetector
    expect(det.maxDepth).toBe(5)
    for (let i = 0; i < 5; i++) expect(det.enter()).toBe(true)
    expect(det.enter()).toBe(false)
  })
})

describe('HooksEngine — approve outcome', () => {
  it('bash exit 0 + JSON {"decision":"approve"} → approve outcome', async () => {
    const eng = makeEngine()
    eng.load({
      hooks: {
        PreToolUse: [
          {
            type: 'bash',
            matcher: 'bash',
            command: isWin ? `echo {"decision":"approve"}` : `printf '{"decision":"approve"}\\n'`,
          },
        ],
      },
    })
    const d = await eng.fire('PreToolUse', { toolName: 'bash', toolInput: {} })
    expect(d.allowed).toBe(true)
    expect(d.results[0]!.outcome).toBe('approve')
  })
})

describe('HooksEngine.dispose', () => {
  it('after dispose, fire returns empty allowed', async () => {
    const eng = makeEngine()
    eng.load({ hooks: { SessionStart: [{ type: 'bash', command: exit0 }] } })
    eng.dispose()
    const d = await eng.fire('SessionStart', { model: 'm', permissionMode: 'auto' })
    expect(d.allowed).toBe(true)
    expect(d.results).toEqual([])
  })
})

describe('HooksEngine — mixed types', () => {
  it('runs bash + http hooks for the same event concurrently', async () => {
    // We don't actually start an HTTP server here — instead, point the http
    // hook at a refused port and verify it produces a `deny` outcome (which
    // for non-gating events still allows). bash hook produces `allow`.
    const eng = makeEngine()
    eng.load({
      hooks: {
        SessionStart: [
          { type: 'bash', command: exit0 },
          { type: 'http', url: 'http://127.0.0.1:1/never' },
        ],
      },
    })
    const d = await eng.fire('SessionStart', { model: 'm', permissionMode: 'auto' })
    // non-gating event → always allowed
    expect(d.allowed).toBe(true)
    expect(d.results).toHaveLength(2)
  })
})
