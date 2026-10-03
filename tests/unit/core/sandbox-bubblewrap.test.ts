/**
 * BubblewrapSandbox — healthcheck + spawn invocation shape.
 *
 * The real bwrap binary is Linux-only. We verify:
 *   1. healthcheck returns null when Linux + bwrap is present (skip otherwise)
 *   2. healthcheck returns clear errors when missing
 *   3. run() refuses when healthcheck fails
 *   4. run() invokes `bwrap` with the expected bind layout when healthy
 *   5. PathGuard rejects forbidden writes
 *
 * Tests that actually invoke `bwrap` are skipIf'd on non-Linux or when
 * the binary isn't installed. Everything else (healthcheck shape, run()
 * arg construction via stubbed spawn) is platform-agnostic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mocks = vi.hoisted(() => {
  return {
    commandExistsMock: vi.fn<(name: string) => boolean>(() => true),
    spawnArgs: { value: null as null | { cmd: string; args: string[]; opts: Record<string, unknown> } },
    spawnStub: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      mocks.spawnArgs.value = { cmd, args, opts }
      const { PassThrough } = require('node:stream') as typeof import('node:stream')
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      const child = Object.assign(new PassThrough(), {
        stdout,
        stderr,
        kill: () => true,
      }) as unknown as import('node:child_process').ChildProcess
      process.nextTick(() => child.emit('close', 0))
      return child
    }),
  }
})

vi.mock('../../../src/utils/command-exists.js', () => ({
  commandExists: (name: string) => mocks.commandExistsMock(name),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mocks.spawnStub }
})

import { BubblewrapSandbox } from '../../../src/core/sandbox/bubblewrap.js'

describe('BubblewrapSandbox', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yuan-bwrap-'))
    mocks.commandExistsMock.mockImplementation(() => true)
    mocks.spawnArgs.value = null
    mocks.spawnStub.mockClear()
  })
  afterEach(() => rmSync(workdir, { recursive: true, force: true }))

  it('mode is bubblewrap and PathGuard is wired', () => {
    const sb = new BubblewrapSandbox({ cwd: workdir })
    expect(sb.mode).toBe('bubblewrap')
    expect(sb.pathGuard).toBeDefined()
  })

  it('healthcheck returns null on Linux when bwrap installed, error on non-Linux', async () => {
    const sb = new BubblewrapSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    if (process.platform !== 'linux') {
      expect(msg).toMatch(/requires Linux/)
    } else {
      expect(msg).toBeNull()
    }
  })

  it('healthcheck returns clear error when bwrap missing', async () => {
    mocks.commandExistsMock.mockImplementation(() => false)
    if (process.platform !== 'linux') return // platform check fires first
    const sb = new BubblewrapSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    expect(msg).toMatch(/bubblewrap \(bwrap\) is not installed/)
  })

  it('run() invokes bwrap with the expected bind layout', async () => {
    if (process.platform !== 'linux') return
    const sb = new BubblewrapSandbox({ cwd: workdir })
    const result = await sb.run('echo hi')
    expect(result.exitCode).toBe(0)
    const args = mocks.spawnArgs.value?.args ?? []
    expect(mocks.spawnArgs.value?.cmd).toBe('bwrap')
    expect(args).toContain('--ro-bind')
    expect(args).toContain('--bind')
    expect(args).toContain('--tmpfs')
    expect(args).toContain('--proc')
    expect(args).toContain('--dev')
    expect(args).toContain('--unshare-pid')
    expect(args).toContain('--unshare-net')
    expect(args).toContain('--unshare-ipc')
    expect(args).toContain('--die-with-parent')
    const bindIdx = args.indexOf('--bind')
    expect(args[bindIdx + 1]).toBe(resolve(workdir))
    expect(args[bindIdx + 2]).toBe('/workspace')
    const shIdx = args.indexOf('/bin/sh')
    expect(args[shIdx + 1]).toBe('-c')
    expect(args[shIdx + 2]).toBe('echo hi')
  })

  it('run() throws when bwrap is missing', async () => {
    mocks.commandExistsMock.mockImplementation(() => false)
    if (process.platform !== 'linux') return
    const sb = new BubblewrapSandbox({ cwd: workdir })
    await expect(sb.run('echo hi')).rejects.toThrow(/bubblewrap \(bwrap\) is not installed/)
  })

  it('run() scrubs sensitive env vars', async () => {
    if (process.platform !== 'linux') return
    process.env.YUANCODE_API_KEY = 'secret-key'
    process.env.NORMAL_VAR = 'ok'
    const sb = new BubblewrapSandbox({ cwd: workdir })
    await sb.run('echo hi')
    const env = (mocks.spawnArgs.value?.opts.env ?? {}) as Record<string, string>
    expect(env.YUANCODE_API_KEY).toBeUndefined()
    expect(env.NORMAL_VAR).toBe('ok')
    delete process.env.YUANCODE_API_KEY
    delete process.env.NORMAL_VAR
  })

  it('PathGuard rejects writes outside cwd via forbidden patterns', () => {
    const sb = new BubblewrapSandbox({ cwd: workdir })
    const innerFile = join(workdir, 'hello.txt')
    writeFileSync(innerFile, 'hi')
    expect(() => sb.pathGuard.assert(innerFile, 'write')).not.toThrow()
    expect(() => sb.pathGuard.assert(join(workdir, '.ssh', 'id_rsa'), 'read')).toThrow()
  })
})