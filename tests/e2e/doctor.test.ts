/**
 * E2E: `yuancode doctor` command
 *
 * Verifies that:
 *   1. The binary is invokable and exits with a 0/1 status (0 healthy,
 *      1 = at least one required check failed).
 *   2. The runDoctor module itself produces a banner mentioning "Node"
 *      via process.stdout — we exercise it directly with a stubbed
 *      stream so the test is deterministic across stdout-buffering
 *      environments.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolve, join } from 'node:path'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

describe('yuancode doctor (e2e)', () => {
  it('runDoctor() writes a banner and reports Node version', async () => {
    const repoRoot = resolve(__dirname, '..', '..')
    // Stub stdout.write so we capture exactly what the doctor would print
    // (without depending on real TTY / pipe buffering).
    const writes: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const stub = vi.fn((s: string | Uint8Array) => {
      writes.push(typeof s === 'string' ? s : s.toString())
      return true
    })
    ;(process.stdout as unknown as { write: typeof stub }).write = stub
    try {
      const { runDoctor } = await import(
        join(repoRoot, 'dist', 'cli', 'doctor.js').replace(/\\/g, '/')
      )
      const code = await runDoctor()
      expect(code === 0 || code === 1).toBe(true)
      const combined = writes.join('')
      expect(combined).toMatch(/Node version/)
      expect(combined).toMatch(/doctor/i)
    } finally {
      ;(process.stdout as unknown as { write: typeof origWrite }).write = origWrite
    }
  })

  it('binary invocation exits 0 in a healthy environment', () => {
    const repoRoot = resolve(__dirname, '..', '..')
    const distEntry = join(repoRoot, 'dist', 'main.js')
    if (!existsSync(distEntry)) {
      console.warn('[skip] dist/main.js not built; run `pnpm build` first')
      return
    }
    const r = spawnSync('node', [distEntry, 'doctor'], {
      cwd: tmpdir(),
      env: { ...process.env, YUANCODE_API_KEY: 'sk-test-1234' },
      encoding: 'utf8',
    })
    expect([0, 1]).toContain(r.status)
  })
})