/**
 * Sandbox tests (local runner + path guard).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { PathGuard, SandboxPathError } from '../../../src/core/sandbox/path-guard.js'

const TMP = join(tmpdir(), `yuancode-sandbox-${Date.now()}`)
mkdirSync(TMP, { recursive: true })

const isWin = process.platform === 'win32'

describe('PathGuard', () => {
  it('classifies cwd and descendants as allow', () => {
    const g = new PathGuard({ cwd: TMP })
    expect(g.classify(TMP)).toBe('allow')
    expect(g.classify(join(TMP, 'sub', 'file.txt'))).toBe('allow')
  })

  it('rejects paths outside the allow list', () => {
    const g = new PathGuard({ cwd: TMP })
    const outside = join(TMP, '..', 'outside-' + Date.now(), 'foo')
    expect(g.classify(outside)).toBe('forbidden')
  })

  it('forbidden pattern (e.g. .ssh) beats the cwd allow-list', () => {
    const g = new PathGuard({ cwd: TMP })
    const fakeSsh = join(TMP, '.ssh', 'id_rsa')
    expect(g.classify(fakeSsh)).toBe('forbidden')
  })

  it('assert throws SandboxPathError on forbidden', () => {
    const g = new PathGuard({ cwd: TMP })
    expect(() => g.assert(join(TMP, '.aws', 'credentials'), 'read')).toThrow(
      SandboxPathError,
    )
  })

  it('honors extraWritable roots', () => {
    const extra = join(TMP, '..', 'extra-' + Date.now())
    mkdirSync(extra, { recursive: true })
    try {
      const g = new PathGuard({ cwd: TMP, extraWritable: [extra] })
      expect(g.classify(join(extra, 'foo'))).toBe('allow')
    } finally {
      rmSync(extra, { recursive: true, force: true })
    }
  })
})

describe('LocalSandbox.run', () => {
  const sandbox = new LocalSandbox({ cwd: TMP })

  it('runs a simple command and captures stdout', async () => {
    const r = await sandbox.run('echo hello')
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.stderr).toBe('')
  })

  it('captures stderr separately', async () => {
    // Use node -e for cross-platform stderr write — avoids shell redirection
    // differences between bash and cmd.exe.
    const cmd = isWin
      ? 'node -e "process.stderr.write(\'to stderr\')"'
      : 'echo to stderr 1>&2'
    const r = await sandbox.run(cmd)
    expect(r.exitCode).toBe(0)
    expect(r.stderr).toMatch(/stderr/)
  })

  it('reports non-zero exit codes without throwing', async () => {
    const r = await sandbox.run(isWin ? 'exit 7' : 'exit 7')
    expect(r.exitCode).toBe(7)
  })

  it('kills long-running processes when timeout fires', async () => {
    const cmd = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30'
    const start = Date.now()
    const r = await sandbox.run(cmd, { timeoutMs: 200 })
    expect(Date.now() - start).toBeLessThan(2000)
    expect(r.timedOut || r.exitCode === null).toBe(true)
  })

  it('respects abort signal (hard abort)', async () => {
    const cmd = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30'
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 100)
    const r = await sandbox.run(cmd, { signal: ctrl.signal })
    expect(r.aborted || r.timedOut || r.exitCode === null).toBe(true)
  })

  it('refuses to spawn commands referencing ~/.ssh', async () => {
    await expect(sandbox.run('cat ~/.ssh/id_rsa')).rejects.toThrow(/blocked path/)
  })

  it('caps stdout to maxOutputBytes and sets truncated flag', async () => {
    const cmd = isWin
      ? 'for /L %i in (1,1,200) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
      : 'yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx | head -c 10240'
    const r = await sandbox.run(cmd, { maxOutputBytes: 512 })
    expect(r.truncated.stdout || r.truncated.stderr).toBe(true)
  })

  it('scrubs sensitive env vars from the child environment', async () => {
    process.env.YUANCODE_API_KEY = 'sk-secret-12345'
    try {
      const cmd = isWin ? 'echo %YUANCODE_API_KEY%' : 'echo "$YUANCODE_API_KEY"'
      const r = await sandbox.run(cmd)
      // Sensitive var must be empty in the child env (not contain the secret).
      expect(r.stdout).not.toContain('sk-secret-12345')
    } finally {
      delete process.env.YUANCODE_API_KEY
    }
  })
})

describe('LocalSandbox.healthcheck', () => {
  it('returns null (local has no external dep)', async () => {
    const s = new LocalSandbox({ cwd: TMP })
    expect(await s.healthcheck()).toBeNull()
  })
})

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})
