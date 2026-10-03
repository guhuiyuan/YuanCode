/**
 * E2E: docker sandbox image
 *
 * If docker is available, build the yuancode/sandbox image from
 * `bin/sandbox/Dockerfile` and run `echo` inside it. If docker is
 * unavailable, skip with a clear message.
 *
 * The Dockerfile is intentionally tiny (Node + bash + coreutils) so this
 * build is fast even on a cold cache.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

describe('docker sandbox image (e2e)', () => {
  // Probe once — if docker isn't there, skip the entire suite cleanly.
  let canRun = false
  beforeAll(() => {
    canRun = dockerAvailable()
    if (!canRun) {
      console.warn('[skip] docker not available on this host')
    }
  })

  it('builds the yuancode/sandbox image and runs echo', async () => {
    if (!canRun) return
    const repoRoot = resolve(__dirname, '..', '..')
    const dockerfile = join(repoRoot, 'bin', 'sandbox', 'Dockerfile')
    // Build (idempotent — Docker layers cache)
    execFileSync(
      'docker',
      ['build', '-t', 'yuancode/sandbox:e2e', '-f', dockerfile, repoRoot],
      { stdio: 'pipe' },
    )
    // Run a simple command and verify stdout
    const out = execFileSync(
      'docker',
      ['run', '--rm', 'yuancode/sandbox:e2e', 'echo', 'hello-from-sandbox'],
      { encoding: 'utf8' },
    )
    expect(out.trim()).toBe('hello-from-sandbox')
  }, 120_000) // build can be slow on cold cache
})