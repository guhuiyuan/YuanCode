/**
 * DockerSandbox — healthcheck + spawn invocation shape.
 *
 * Mirrors the bubblewrap test but for the cross-platform Docker mode.
 *   1. healthcheck returns null when docker CLI + daemon are present
 *   2. healthcheck reports clear errors for missing CLI / dead daemon
 *   3. run() invokes `docker run --rm -i` with the documented flags
 *   4. PathGuard is wired and rejects forbidden writes
 *   5. Custom image + network overrides propagate to spawn args
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const mocks = vi.hoisted(() => {
  return {
    commandExistsMock: vi.fn<(name: string) => boolean>(() => true),
    dockerProbeStatus: 0, // 0 = ok, non-zero = daemon down
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
    spawnSyncStub: vi.fn((_cmd: string, args: string[]) => {
      // docker version probe: status 0 means daemon alive
      if (args[0] === 'version') {
        return { status: mocks.dockerProbeStatus, stdout: Buffer.from('24.0.0') }
      }
      return { status: 0, stdout: Buffer.from('') }
    }),
  }
})

vi.mock('../../../src/utils/command-exists.js', () => ({
  commandExists: (name: string) => mocks.commandExistsMock(name),
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: mocks.spawnStub, spawnSync: mocks.spawnSyncStub }
})

import { DockerSandbox } from '../../../src/core/sandbox/docker.js'

describe('DockerSandbox', () => {
  let workdir: string
  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), 'yuan-docker-'))
    mocks.commandExistsMock.mockImplementation(() => true)
    mocks.dockerProbeStatus = 0
    mocks.spawnArgs.value = null
    mocks.spawnStub.mockClear()
    mocks.spawnSyncStub.mockClear()
  })
  afterEach(() => rmSync(workdir, { recursive: true, force: true }))

  it('mode is docker and PathGuard is wired', () => {
    const sb = new DockerSandbox({ cwd: workdir })
    expect(sb.mode).toBe('docker')
    expect(sb.pathGuard).toBeDefined()
  })

  it('default image is yuancode/sandbox:latest', async () => {
    const sb = new DockerSandbox({ cwd: workdir })
    await sb.run('echo hi')
    expect(mocks.spawnArgs.value?.args).toContain('yuancode/sandbox:latest')
  })

  it('healthcheck returns null when docker CLI + daemon OK', async () => {
    const sb = new DockerSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    expect(msg).toBeNull()
  })

  it('healthcheck reports missing CLI', async () => {
    mocks.commandExistsMock.mockImplementation((name) => name !== 'docker')
    const sb = new DockerSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    expect(msg).toMatch(/docker CLI not found/)
  })

  it('healthcheck reports dead daemon', async () => {
    mocks.dockerProbeStatus = 1
    const sb = new DockerSandbox({ cwd: workdir })
    const msg = await sb.healthcheck()
    expect(msg).toMatch(/daemon is not responding/)
  })

  it('run() invokes docker run with the documented flags', async () => {
    const sb = new DockerSandbox({ cwd: workdir })
    const result = await sb.run('echo hi')
    expect(result.exitCode).toBe(0)
    const args = mocks.spawnArgs.value?.args ?? []
    expect(mocks.spawnArgs.value?.cmd).toBe('docker')
    expect(args[0]).toBe('run')
    expect(args).toContain('--rm')
    expect(args).toContain('-i')
    // Volume + workspace mapping
    expect(args).toContain('-v')
    expect(args).toContain(resolve(workdir) + ':/workspace')
    expect(args).toContain('-w')
    expect(args).toContain('/workspace')
    // Network + resource limits (defaults)
    expect(args).toContain('--network')
    expect(args).toContain('none')
    expect(args).toContain('--memory')
    expect(args).toContain('512m')
    expect(args).toContain('--cpus')
    expect(args).toContain('1')
    // YUAN_INSIDE_SANDBOX marker
    expect(args).toContain('YUAN_INSIDE_SANDBOX=1')
    // Command shim
    expect(args).toContain('/bin/sh')
    expect(args).toContain('-c')
    expect(args).toContain('echo hi')
  })

  it('custom image + network + memory + cpus propagate to spawn args', async () => {
    const sb = new DockerSandbox({
      cwd: workdir,
      image: 'myteam/custom:1.0',
      network: 'host',
      memory: '1g',
      cpus: 2,
    })
    await sb.run('ls')
    const args = mocks.spawnArgs.value?.args ?? []
    expect(args).toContain('myteam/custom:1.0')
    expect(args).toContain('--network')
    expect(args).toContain('host')
    expect(args).toContain('1g')
    expect(args).toContain('2')
  })

  it('run() scrubs YUANCODE_API_KEY from env', async () => {
    process.env.YUANCODE_API_KEY = 'top-secret'
    process.env.NORMAL_VAR = 'keep'
    const sb = new DockerSandbox({ cwd: workdir })
    await sb.run('echo hi')
    const env = (mocks.spawnArgs.value?.opts.env ?? {}) as Record<string, string>
    expect(env.YUANCODE_API_KEY).toBeUndefined()
    expect(env.NORMAL_VAR).toBe('keep')
    delete process.env.YUANCODE_API_KEY
    delete process.env.NORMAL_VAR
  })

  it('PathGuard rejects forbidden patterns', () => {
    const sb = new DockerSandbox({ cwd: workdir })
    const ok = join(workdir, 'file.txt')
    writeFileSync(ok, 'hi')
    expect(() => sb.pathGuard.assert(ok, 'write')).not.toThrow()
    expect(() => sb.pathGuard.assert(join(workdir, '.aws', 'credentials'), 'read')).toThrow()
  })
})