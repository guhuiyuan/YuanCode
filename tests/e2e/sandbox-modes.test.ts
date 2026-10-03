/**
 * E2E: sandbox modes
 *
 * Verifies that all 4 sandbox modes can be constructed and that the
 * `local` mode (always available) can actually run a real shell command.
 * bubblewrap / docker / landlock tests are skipped if their preflight
 * fails (binary missing, daemon down, etc.).
 */
import { describe, it, expect } from 'vitest'
import { createSandbox } from '../../dist/core/sandbox/index.js'

describe('sandbox modes (e2e)', () => {
  it('local sandbox runs a real echo command and captures stdout', async () => {
    const sb = createSandbox({ mode: 'local', cwd: process.cwd() })
    const r = await sb.run('echo hello-yuancode')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello-yuancode')
    expect(r.stderr).toBe('')
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(false)
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('local sandbox respects timeout', async () => {
    const sb = createSandbox({ mode: 'local', cwd: process.cwd() })
    const r = await sb.run('sleep 5', { timeoutMs: 200 })
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).not.toBe(0)
  })

  it('local sandbox path guard rejects .ssh', async () => {
    const sb = createSandbox({ mode: 'local', cwd: process.cwd() })
    expect(sb.pathGuard.classify('/home/user/.ssh/id_rsa')).toBe('forbidden')
    expect(sb.pathGuard.classify(process.cwd())).toBe('allow')
  })

  it('docker sandbox: healthcheck runs against real docker CLI', async () => {
    const sb = createSandbox({ mode: 'docker', cwd: process.cwd() })
    const err = await sb.healthcheck()
    if (err) {
      // CI without docker — skip the rest of the test.
      console.warn(`[skip] docker unavailable: ${err}`)
      return
    }
    expect(err).toBeNull()
    expect(sb.mode).toBe('docker')
  })

  it('bubblewrap sandbox: healthcheck runs only on Linux + bwrap present', async () => {
    if (process.platform !== 'linux') {
      // Just verify the constructor refused non-Linux (createSandbox throws)
      expect(() =>
        createSandbox({ mode: 'bubblewrap', cwd: process.cwd() }),
      ).toThrow(/requires Linux/)
      return
    }
    const sb = createSandbox({ mode: 'bubblewrap', cwd: process.cwd() })
    const err = await sb.healthcheck()
    if (err) {
      console.warn(`[skip] bubblewrap unavailable: ${err}`)
      return
    }
    expect(err).toBeNull()
  })

  it('landlock sandbox: healthcheck probe runs', async () => {
    if (process.platform !== 'linux') {
      expect(() =>
        createSandbox({ mode: 'landlock', cwd: process.cwd() }),
      ).toThrow(/requires Linux/)
      return
    }
    const sb = createSandbox({ mode: 'landlock', cwd: process.cwd() })
    const err = await sb.healthcheck()
    // On Linux the kernel may be too old or node:landlock unavailable —
    // either way we get a descriptive string, not a throw.
    if (err) {
      expect(err.length).toBeGreaterThan(10)
    } else {
      expect(err).toBeNull()
    }
  })
})