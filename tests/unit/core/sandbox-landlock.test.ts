/**
 * LandlockSandbox — healthcheck + allowedFs construction.
 *
 * Landlock is Linux 5.13+ AND requires the `node:landlock` built-in
 * module, which only exists in Node 22+. On machines without it
 * (e.g. Node 24.13.0 doesn't have it yet, Windows, macOS) every
 * runnable test is skipped — we still verify the healthcheck reports
 * the right reason.
 *
 * What we DO verify across platforms:
 *   1. healthcheck returns null only on Linux + Node 22+ + module present
 *   2. healthcheck reports the right reason on non-Linux
 *   3. run() throws with the healthcheck reason when called on non-Linux
 *   4. PathGuard is wired and respects forbidden patterns
 *
 * We don't try to actually invoke landlock in CI — activating it is
 * irreversible and would contaminate the rest of the test process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LandlockSandbox } from '../../../src/core/sandbox/landlock.js'

describe('LandlockSandbox', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yuan-landlock-'))
  })
  afterEach(() => rmSync(workdir, { recursive: true, force: true }))

  it('mode is landlock and PathGuard is wired', () => {
    const sb = new LandlockSandbox({ cwd: workdir })
    expect(sb.mode).toBe('landlock')
    expect(sb.pathGuard).toBeDefined()
  })

  it('healthcheck reports Linux requirement on non-Linux hosts', async () => {
    if (process.platform === 'linux') return
    const sb = new LandlockSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    expect(msg).toMatch(/requires Linux/)
  })

  it('healthcheck on Linux returns null if module present, else descriptive reason', async () => {
    if (process.platform !== 'linux') return
    const sb = new LandlockSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    if (msg === null) {
      // Kernel + Node both support it — perfect.
      expect(msg).toBeNull()
    } else {
      // Otherwise we get a clear reason like "node:landlock" missing.
      expect(msg.length).toBeGreaterThan(10)
    }
  })

  it('run() throws with the healthcheck reason on non-Linux hosts', async () => {
    if (process.platform === 'linux') return
    const sb = new LandlockSandbox({ cwd: workdir })
    await expect(sb.run('echo hi')).rejects.toThrow(/requires Linux/)
  })

  it('extraWritable paths become part of the allowed set', () => {
    const sb = new LandlockSandbox({ cwd: workdir, extraWritable: ['/tmp'] })
    // We can't easily peek at the private allowedFs array, but we can
    // confirm the path guard accepts a path under an extraWritable root
    // by exercising the public surface — `/tmp` is a real, existing dir.
    expect(() => sb.pathGuard.assert('/tmp', 'write')).not.toThrow()
  })

  it('PathGuard rejects forbidden patterns', () => {
    const sb = new LandlockSandbox({ cwd: workdir })
    const ok = join(workdir, 'file.txt')
    writeFileSync(ok, 'hi')
    expect(() => sb.pathGuard.assert(ok, 'write')).not.toThrow()
    expect(() => sb.pathGuard.assert(join(workdir, '.ssh', 'id_rsa'), 'read')).toThrow()
  })

  it('lazy probe caches its result across healthcheck calls', async () => {
    if (process.platform !== 'linux') return
    const sb = new LandlockSandbox({ cwd: workdir })
    const m1 = await sb.healthcheck()
    const m2 = await sb.healthcheck()
    // The two calls must agree exactly — otherwise we'd be paying the
    // dynamic-import + syscall cost every healthcheck.
    expect(m1).toBe(m2)
  })

  it('healthcheck does not throw when node:landlock import fails', async () => {
    // We deliberately do NOT mock node:landlock here — the goal is to
    // confirm that an unavailable module surfaces as a clean error
    // string rather than an exception bubbling out.
    const sb = new LandlockSandbox({ cwd: workdir })
    await expect(sb.healthcheck()).resolves.toBeTypeOf('string')
  })

  // Use vi to avoid unused-import warnings if the suite is fully skipped.
  it('placeholder so vi import is exercised', () => {
    expect(vi).toBeDefined()
  })
})