/**
 * LightSandbox — minimal subprocess runner for user-installed hooks.
 *
 * Why a fork instead of reusing `LocalSandbox`?
 * - Hooks are user-authored scripts in `~/.yuancode/hooks.yaml` or
 *   `<project>/.yuancode/hooks.yaml`. The user has explicitly opted in by
 *   writing them there, so the path-guard scan and API-key scrubbing are
 *   unnecessary friction.
 * - We still want the same abort/timeout/output-cap primitives to keep the
 *   hook surface predictable.
 *
 * The runner spawns with `shell: true` (since hook commands are arbitrary
 * strings), captures stdout/stderr, kills the process tree on abort or
 * timeout, and returns an exit code + captured output.
 *
 * NOT exported from `src/hooks/index.ts` — only used internally by
 * `executor.ts`. Tests reach into it via direct import.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { killTree } from '../core/sandbox/kill-tree.js'

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_OUTPUT_CAP = 1 << 20 // 1 MiB

export interface LightSandboxOptions {
  /** Shell command string (passed to `sh -c` on POSIX, `cmd /c` on Windows). */
  command: string
  /** Environment merged on top of `process.env`. Caller injects YUAN_* vars. */
  env?: Record<string, string>
  /** Working directory (resolved). Defaults to `process.cwd()`. */
  cwd?: string
  /** Optional stdin payload (UTF-8). */
  input?: string
  /** Per-run timeout in ms. Default 60 000. */
  timeoutMs?: number
  /** Per-stream byte cap. Default 1 MiB. */
  outputCap?: number
  /** Abort signal — typically `TwoLevelAbort.hardSignal`. */
  signal?: AbortSignal
}

export interface LightSandboxResult {
  /** Process exit code. `null` if the process was killed by signal or spawn failed. */
  exitCode: number | null
  /** Captured stdout (truncated if it exceeded `outputCap`). */
  stdout: string
  /** Captured stderr (truncated if it exceeded `outputCap`). */
  stderr: string
  /** Whether the timeout fired and killed the process. */
  timedOut: boolean
  /** Whether `signal` aborted and killed the process. */
  aborted: boolean
  /** Wall-clock duration in ms (rounded). */
  durationMs: number
}

export async function runLightSandbox(opts: LightSandboxOptions): Promise<LightSandboxResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.outputCap ?? DEFAULT_OUTPUT_CAP
  const cwd = resolve(opts.cwd ?? process.cwd())
  const start = performance.now()

  const child: ChildProcess = spawn(opts.command, {
    cwd,
    shell: true,
    env: { ...process.env, ...(opts.env ?? {}) },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  // Optional stdin payload.
  if (opts.input !== undefined && child.stdin) {
    child.stdin.write(opts.input)
    child.stdin.end()
  } else {
    child.stdin?.end()
  }

  let stdout = ''
  let stderr = ''
  let truncatedStdout = false
  let truncatedStderr = false
  let timedOut = false
  let aborted = false

  const onAbort = (): void => {
    aborted = true
    killTree(child)
  }
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, timeoutMs)

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (truncatedStdout) return
    const merged = stdout + chunk
    if (Buffer.byteLength(merged, 'utf8') >= maxBytes) {
      const c = cap(merged, maxBytes)
      stdout = c.text
      truncatedStdout = c.truncated
    } else {
      stdout = merged
    }
  })
  child.stderr?.on('data', (chunk: string) => {
    if (truncatedStderr) return
    const merged = stderr + chunk
    if (Buffer.byteLength(merged, 'utf8') >= maxBytes) {
      const c = cap(merged, maxBytes)
      stderr = c.text
      truncatedStderr = c.truncated
    } else {
      stderr = merged
    }
  })

  const exitCode: number | null = await new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code))
    child.on('error', () => resolveExit(null))
  })

  clearTimeout(timer)
  opts.signal?.removeEventListener('abort', onAbort)

  return {
    exitCode,
    stdout,
    stderr,
    timedOut,
    aborted,
    durationMs: Math.round(performance.now() - start),
  }
}

function cap(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false }
  const head = s.slice(0, Math.floor(max / 2))
  const tail = s.slice(s.length - Math.floor(max / 4))
  return {
    text: `${head}\n\n... [truncated ${s.length - head.length - tail.length} chars] ...\n\n${tail}`,
    truncated: true,
  }
}
