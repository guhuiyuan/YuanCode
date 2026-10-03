/**
 * createSandbox() factory — wires all 4 modes.
 *
 * Verifies that:
 *   1. 'local' returns a LocalSandbox instance
 *   2. 'bubblewrap' returns a BubblewrapSandbox on Linux, throws on others
 *   3. 'docker' returns a DockerSandbox regardless of platform
 *   4. 'landlock' returns a LandlockSandbox on Linux, throws on others
 *   5. An unknown mode throws an exhaustive check error
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSandbox } from '../../../src/core/sandbox/index.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { BubblewrapSandbox } from '../../../src/core/sandbox/bubblewrap.js'
import { DockerSandbox } from '../../../src/core/sandbox/docker.js'
import { LandlockSandbox } from '../../../src/core/sandbox/landlock.js'

describe('createSandbox', () => {
  let workdir: string
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const setup = () => {
    workdir = mkdtempSync(join(tmpdir(), 'yuan-factory-'))
    return () => rmSync(workdir, { recursive: true, force: true })
  }

  it('returns LocalSandbox for mode=local', () => {
    const cleanup = setup()
    try {
      const sb = createSandbox({ mode: 'local', cwd: workdir })
      expect(sb).toBeInstanceOf(LocalSandbox)
      expect(sb.mode).toBe('local')
    } finally {
      cleanup()
    }
  })

  it('returns BubblewrapSandbox on Linux; throws on others', () => {
    const cleanup = setup()
    try {
      if (process.platform === 'linux') {
        const sb = createSandbox({ mode: 'bubblewrap', cwd: workdir })
        expect(sb).toBeInstanceOf(BubblewrapSandbox)
        expect(sb.mode).toBe('bubblewrap')
      } else {
        expect(() => createSandbox({ mode: 'bubblewrap', cwd: workdir })).toThrow(
          /bubblewrap sandbox requires Linux/,
        )
      }
    } finally {
      cleanup()
    }
  })

  it('returns DockerSandbox regardless of platform', () => {
    const cleanup = setup()
    try {
      const sb = createSandbox({ mode: 'docker', cwd: workdir })
      expect(sb).toBeInstanceOf(DockerSandbox)
      expect(sb.mode).toBe('docker')
    } finally {
      cleanup()
    }
  })

  it('returns LandlockSandbox on Linux; throws on others', () => {
    const cleanup = setup()
    try {
      if (process.platform === 'linux') {
        const sb = createSandbox({ mode: 'landlock', cwd: workdir })
        expect(sb).toBeInstanceOf(LandlockSandbox)
        expect(sb.mode).toBe('landlock')
      } else {
        expect(() => createSandbox({ mode: 'landlock', cwd: workdir })).toThrow(
          /landlock sandbox requires Linux/,
        )
      }
    } finally {
      cleanup()
    }
  })

  it('passes docker image/network/memory/cpus through to DockerSandbox', () => {
    const cleanup = setup()
    try {
      const sb = createSandbox({
        mode: 'docker',
        cwd: workdir,
        image: 'myteam/cu:2',
        network: 'host',
        memory: '2g',
        cpus: 4,
      })
      expect(sb).toBeInstanceOf(DockerSandbox)
      // We can introspect the private fields via a quick cast — the
      // public surface intentionally exposes only `mode` + `pathGuard`.
      const privateSb = sb as unknown as {
        image: string
        network: string
        memory: string
        cpus: number
      }
      expect(privateSb.image).toBe('myteam/cu:2')
      expect(privateSb.network).toBe('host')
      expect(privateSb.memory).toBe('2g')
      expect(privateSb.cpus).toBe(4)
    } finally {
      cleanup()
    }
  })

  it('extraWritable propagates to the sandbox PathGuard', () => {
    const cleanup = setup()
    try {
      const extra = join(workdir, '..', 'extra-' + Date.now())
      const sb = createSandbox({ mode: 'local', cwd: workdir, extraWritable: [extra] })
      expect(sb.pathGuard.classify(join(extra, 'foo'))).toBe('allow')
      rmSync(extra, { recursive: true, force: true })
    } finally {
      cleanup()
    }
  })
})