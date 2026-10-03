/**
 * LightSandbox — minimal subprocess runner for hook commands.
 *
 * Uses `cmd /c` on Windows, `sh -c` on POSIX (Node handles the platform
 * choice when `shell: true` is passed).
 */
import { describe, expect, it, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLightSandbox } from '../../../src/hooks/light-sandbox.js'

const TMP = mkdtempSync(join(tmpdir(), 'yuancode-light-sandbox-'))

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

// Use a portable echo so tests pass on both POSIX (echo "x") and Windows
// (write is built into cmd). We branch by platform.
const isWin = process.platform === 'win32'
const echoCmd = (s: string): string =>
  isWin ? `echo ${s}` : `echo "${s}"`

describe('runLightSandbox', () => {
  it('returns exit code 0 for a successful command', async () => {
    const r = await runLightSandbox({
      command: echoCmd('hello'),
      cwd: TMP,
    })
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe('hello')
    expect(r.stderr).toBe('')
    expect(r.timedOut).toBe(false)
    expect(r.aborted).toBe(false)
  })

  it('returns non-zero exit code', async () => {
    const r = await runLightSandbox({
      command: isWin ? 'exit 1' : 'exit 1',
      cwd: TMP,
    })
    expect(r.exitCode).toBe(1)
  })

  it('captures stderr separately from stdout', async () => {
    const r = await runLightSandbox({
      command: isWin ? 'echo out && echo err 1>&2' : 'echo out; echo err 1>&2',
      cwd: TMP,
    })
    expect(r.stdout.trim()).toBe('out')
    expect(r.stderr.trim()).toBe('err')
  })

  it('enforces the timeout', async () => {
    const t0 = Date.now()
    const r = await runLightSandbox({
      command: isWin
        ? // ping loopback with -n 999 takes forever; sleep is too coarse on win
          'ping -n 999 127.0.0.1'
        : 'sleep 30',
      cwd: TMP,
      timeoutMs: 200,
    })
    const elapsed = Date.now() - t0
    expect(r.timedOut).toBe(true)
    expect(elapsed).toBeLessThan(5_000)
  })

  it('respects the abort signal', async () => {
    const ctrl = new AbortController()
    const p = runLightSandbox({
      command: isWin ? 'ping -n 999 127.0.0.1' : 'sleep 30',
      cwd: TMP,
      timeoutMs: 30_000,
      signal: ctrl.signal,
    })
    setTimeout(() => ctrl.abort(), 100)
    const r = await p
    expect(r.aborted).toBe(true)
    expect(r.timedOut).toBe(false)
  })

  it('caps stdout when output exceeds the limit', async () => {
    const r = await runLightSandbox({
      command: isWin
        ? // Generate ~64 KiB of output
          `for /L %i in (1,1,4096) do @echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
        : // shell loop, 64 chars per line × 1024 lines = ~64 KiB
          `for i in $(seq 1 1024); do echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; done`,
      cwd: TMP,
      outputCap: 8 * 1024, // 8 KiB cap — output should be truncated
    })
    // Even with truncation, Buffer.byteLength can't grow unbounded.
    expect(Buffer.byteLength(r.stdout, 'utf8')).toBeLessThan(64 * 1024)
    expect(r.stdout).toContain('[truncated')
  })

  it('forwards stdin payload', async () => {
    const r = await runLightSandbox({
      command: isWin ? 'more' : 'cat',
      cwd: TMP,
      input: 'piped-input',
    })
    expect(r.stdout).toContain('piped-input')
  })

  it('passes environment variables through', async () => {
    const r = await runLightSandbox({
      command: isWin ? 'echo %YUAN_TEST%' : 'echo "$YUAN_TEST"',
      cwd: TMP,
      env: { YUAN_TEST: 'present' },
    })
    expect(r.stdout).toContain('present')
  })
})
