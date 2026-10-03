/**
 * Shared process-tree killer for sandbox implementations.
 *
 * Both `LocalSandbox` and the hooks `LightSandbox` use this helper to
 * terminate a child process and its descendants on timeout / abort.
 *
 * - Windows: `taskkill /f /t` (tree-kill). Falls back to `child.kill('SIGKILL')`
 *   if `taskkill` is unavailable.
 * - POSIX: `process.kill(-pid, 'SIGKILL')` (negative PID = process group). Falls
 *   back to `child.kill('SIGKILL')` if the child was spawned without `detached: true`
 *   (so it isn't a process-group leader).
 */
import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'

export function killTree(child: ChildProcess): void {
  if (process.platform === 'win32') {
    // Best-effort: tree-kill via taskkill
    try {
      spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { windowsHide: true })
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    try {
      // Negative PID = process group kill (POSIX)
      process.kill(-(child.pid ?? 0), 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}
