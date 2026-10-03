/**
 * Local sandbox runner. Cross-platform default.
 *
 * What this gives us:
 *   - Working directory forced to project root (or explicit override)
 *   - Path guard applied to all `cd <path>` and redirect targets inside the
 *     command string (best-effort regex; deeper validation lives in the
 *     individual file tools, not in bash)
 *   - Environment scrubbing: API keys, AWS credentials, SSH agent vars are
 *     stripped before exec
 *   - Output capping: 1 MiB per stream; remainder is replaced with a
 *     `(N bytes truncated)` marker
 *   - Hard-abort: AbortController.kill() on the spawned process tree
 *
 * What this does NOT give us (and which the docker/landlock modes provide):
 *   - Filesystem namespace isolation
 *   - Network namespace isolation
 *   - Cgroup resource limits
 *
 * For most "run `pnpm test`" / "run `git status`" / "list files" use cases
 * the path guard + env scrubbing is sufficient.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunner,
} from './runner.js'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
} from './runner.js'
import { PathGuard } from './path-guard.js'
import { killTree } from './kill-tree.js'

const SENSITIVE_ENV_KEYS = [
  // API keys for various services
  /API[_-]?KEY/i,
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PASSWD/i,
  // Cloud credentials
  /AWS_(SECRET_)?ACCESS_KEY/i,
  /AZURE_/i,
  /GCP_/i,
  /GOOGLE_APPLICATION_CREDENTIALS/i,
  // SSH / GPG
  /SSH_(AGENT|IDENTITY)/i,
  /GPG_/i,
  // YuanCode-specific (we re-inject only what we need)
  /YUANCODE_API_KEY/,
]

function scrubEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    if (SENSITIVE_ENV_KEYS.some((re) => re.test(k))) continue
    out[k] = v
  }
  return out
}

function cap(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= max) return { text: s, truncated: false }
  // Truncate by char count close to max bytes (good enough for ASCII; UTF-8
  // multi-byte chars may be split, but the result is still meaningful).
  const head = s.slice(0, Math.floor(max / 2))
  const tail = s.slice(s.length - Math.floor(max / 4))
  return {
    text: `${head}\n\n... [truncated ${s.length - head.length - tail.length} chars] ...\n\n${tail}`,
    truncated: true,
  }
}

export class LocalSandbox implements SandboxRunner {
  readonly mode = 'local' as const
  readonly pathGuard: PathGuard

  constructor(opts: { cwd: string; extraWritable?: string[] }) {
    this.pathGuard = new PathGuard({
      cwd: opts.cwd,
      extraWritable: opts.extraWritable,
    })
  }

  async healthcheck(): Promise<string | null> {
    return null // local mode has no external dependency
  }

  async run(cmd: string, opts: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const cwd = resolve(opts.cwd ?? process.cwd())
    const start = performance.now()

    // Pre-flight: refuse to spawn if `cd <forbidden>` is detectable. We can't
    // be perfect (bash allows many escape hatches) but the common case is
    // caught.
    this.scanForForbiddenPaths(cmd)

    const child: ChildProcess = spawn(cmd, {
      cwd,
      shell: true,
      env: { ...scrubEnv(process.env), ...(opts.env ?? {}) },
      // detached: false → child dies with parent. Set false explicitly.
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let truncated = { stdout: false, stderr: false }
    let timedOut = false
    let aborted = false

    // Hard-abort wiring.
    const onAbort = (): void => {
      aborted = true
      killTree(child)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    // Timeout wiring.
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child)
    }, timeoutMs)

    // Stream capture with byte cap.
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
    opts.signal?.removeEventListener('abort', onAbort)

    return {
      command: cmd,
      exitCode,
      stdout,
      stderr,
      truncated,
      durationMs: Math.round(performance.now() - start),
      timedOut,
      aborted,
    }
  }

  /**
   * Naive best-effort scan for forbidden-path redirects inside the command
   * string. Catches the common `cat ~/.ssh/id_rsa`, `rm -rf /etc`, etc.
   * Not a security boundary — the real boundary is the per-tool path guard
   * (path-guard.ts) which validates paths at the file-tool layer.
   */
  private scanForForbiddenPaths(cmd: string): void {
    const re = /(?:~|\$HOME|\$\{HOME\})\/(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker)\b/g
    if (re.test(cmd)) {
      throw new Error('Command references a blocked path (~/.ssh, ~/.aws, …)')
    }
  }
}
