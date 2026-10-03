/**
 * process-runner — shared spawn / stream / abort / timeout machinery.
 *
 * The three non-local sandbox modes (bubblewrap / docker / landlock) all
 * ultimately spawn a child process and need to handle the same lifecycle:
 *   - wire `AbortSignal` → kill child tree
 *   - wire wall-clock timeout → kill child tree
 *   - capture stdout/stderr with byte cap + truncation marker
 *   - resolve with the same SandboxRunResult shape
 *
 * Only the spawn invocation differs per mode. This file extracts the
 * post-spawn machinery so each sandbox stays ~50 lines focused on its
 * spawn args + the mode-specific preflight checks.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { killTree } from './kill-tree.js'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  type SandboxRunOptions,
  type SandboxRunResult,
} from './runner.js'

/**
 * Spawn `cmd` with `args` and stream its output. The returned promise
 * resolves with a `SandboxRunResult`. The result's `command` field is set
 * to `displayCommand` (a human-readable form) — useful when the actual
 * spawn args include a wrapping `bwrap` / `docker run`.
 */
export async function runChild(opts: {
  cmd: string
  args: string[]
  spawnOpts: SpawnOptions
  displayCommand: string
  runOpts: SandboxRunOptions
}): Promise<SandboxRunResult> {
  const { cmd, args, spawnOpts, displayCommand, runOpts } = opts
  const timeoutMs = runOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = runOpts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const start = performance.now()

  const child: ChildProcess = spawn(cmd, args, {
    ...spawnOpts,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  let stdout = ''
  let stderr = ''
  let truncated = { stdout: false, stderr: false }
  let timedOut = false
  let aborted = false

  const onAbort = (): void => {
    aborted = true
    killTree(child)
  }
  runOpts.signal?.addEventListener('abort', onAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, timeoutMs)

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (truncated.stdout) return
    const merged = stdout + chunk
    if (Buffer.byteLength(merged, 'utf8') >= maxBytes) {
      const c = cap(merged, maxBytes)
      stdout = c.text
      truncated.stdout = c.truncated
    } else {
      stdout = merged
    }
  })
  child.stderr?.on('data', (chunk: string) => {
    if (truncated.stderr) return
    const merged = stderr + chunk
    if (Buffer.byteLength(merged, 'utf8') >= maxBytes) {
      const c = cap(merged, maxBytes)
      stderr = c.text
      truncated.stderr = c.truncated
    } else {
      stderr = merged
    }
  })

  const exitCode: number | null = await new Promise((resolveExit) => {
    child.on('close', (code) => resolveExit(code))
    child.on('error', () => resolveExit(null))
  })

  clearTimeout(timer)
  runOpts.signal?.removeEventListener('abort', onAbort)

  return {
    command: displayCommand,
    exitCode,
    stdout,
    stderr,
    truncated,
    durationMs: Math.round(performance.now() - start),
    timedOut,
    aborted,
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

/**
 * Strip sensitive env keys before passing to a child. Mirrors the same
 * pattern in LocalSandbox so all modes agree on what's scrubbed.
 *
 * Public so the docker/bubblewrap runners can use it.
 */
const SENSITIVE_ENV_KEYS = [
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  /AWS_(SECRET_)?ACCESS_KEY/i,
  /AZURE_/i,
  /GCP_/i,
  /GOOGLE_APPLICATION_CREDENTIALS/i,
  /SSH_(AGENT|IDENTITY)/i,
  /GPG_/i,
  /YUANCODE_API_KEY/i,
]

export function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SENSITIVE_ENV_KEYS.some((re) => re.test(k))) continue
    out[k] = v
  }
  return out
}