/**
 * command-exists — cheap cross-platform check for whether a binary is on
 * PATH (or, on Windows, in the standard executable search locations).
 *
 * Used by:
 *   - BubblewrapSandbox.preflight (checks `bwrap`)
 *   - DockerSandbox.preflight (checks `docker`)
 *   - doctor (warns on `docker` / `rg`)
 *
 * Avoids spawning `which` / `where` and the cross-platform quoting headache.
 * Uses Node's `child_process.spawnSync` with the standard `command` shim
 * (built into cmd.exe on Windows, /bin/sh on POSIX) — but only as a probe.
 *
 * Caches results per-process to avoid repeat probes; cache is exposed via
 * `clearCommandExistsCache()` for tests.
 */
import { spawnSync } from 'node:child_process'

const cache = new Map<string, boolean>()

export function commandExists(cmd: string): boolean {
  const cached = cache.get(cmd)
  if (cached !== undefined) return cached
  const found = probe(cmd)
  cache.set(cmd, found)
  return found
}

export function clearCommandExistsCache(): void {
  cache.clear()
}

function probe(cmd: string): boolean {
  // On Windows, `where` is the canonical lookup. On POSIX, `command -v` is
  // a shell builtin that prints the resolved path (or nothing). Both
  // return exit 0 when found, non-zero when missing. We deliberately avoid
  // `which` because it isn't guaranteed to be installed on every system.
  const isWindows = process.platform === 'win32'
  const probe = isWindows
    ? spawnSync('where', [cmd], { stdio: 'ignore', windowsHide: true })
    : spawnSync('sh', ['-c', `command -v ${shellQuote(cmd)} >/dev/null 2>&1`], {
        stdio: 'ignore',
      })
  return probe.status === 0
}

function shellQuote(s: string): string {
  // Conservative single-quote wrap for sh; covers most realistic binary
  // names. Names with embedded single quotes are exceedingly rare and we
  // accept the false negative.
  return `'${s.replace(/'/g, `'\\''`)}'`
}