/**
 * Sandbox runner — the abstraction the bash tool calls into.
 *
 * `local` mode is the cross-platform default and the only M1 implementation.
 * `bubblewrap`, `docker`, `landlock` land in M7 (full sandbox milestone).
 *
 * The runner exposes one method: `run(cmd, opts)`. Implementations must:
 *
 *   1. resolve `cwd` against the configured project root
 *   2. sanitize the env (strip API keys, AWS credentials, etc.)
 *   3. spawn the command with the configured timeout
 *   4. capture stdout + stderr (capped to prevent OOM)
 *   5. honor the hard-abort signal
 */
import type { PathGuard } from './path-guard.js'

export interface SandboxRunOptions {
  /** Working directory. Defaults to the sandbox root (project cwd). */
  cwd?: string
  /** Hard time limit in ms. */
  timeoutMs?: number
  /** Max bytes captured per stream. Default 1 MiB. */
  maxOutputBytes?: number
  /** Pass-through env vars (filtered). */
  env?: Record<string, string>
  /** Abort signal (hard abort). */
  signal?: AbortSignal
}

export interface SandboxRunResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  durationMs: number
  /** Wall-clock time the process was running, in ms. */
  timedOut: boolean
  /** True if signal aborted the process. */
  aborted: boolean
}

export interface SandboxRunner {
  readonly mode: 'local' | 'bubblewrap' | 'docker' | 'landlock'
  readonly pathGuard: PathGuard
  run(cmd: string, opts?: SandboxRunOptions): Promise<SandboxRunResult>
  /** Verify the runner is operational. Returns null on success, error msg otherwise. */
  healthcheck(): Promise<string | null>
}

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576 // 1 MiB per stream
