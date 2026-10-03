/**
 * Bubblewrap sandbox — Linux-only filesystem + process namespace isolation.
 *
 * Wraps every command in `bwrap` with a strict bind layout:
 *
 *   bwrap \
 *     --ro-bind /usr /usr \
 *     --ro-bind /lib /lib \
 *     --ro-bind /etc /etc \
 *     --ro-bind /bin /bin \
 *     --ro-bind /sbin /sbin \
 *     --bind <cwd> /workspace \
 *     --tmpfs /tmp \
 *     --proc /proc \
 *     --dev /dev \
 *     --unshare-pid --unshare-net --unshare-ipc \
 *     --hostname yuancode --die-with-parent \
 *     /bin/sh -c <cmd>
 *
 * Why this list:
 *   - `/workspace` is the only writable bind; the user's project lives there
 *   - `/tmp` is a fresh tmpfs (no leftover state across invocations)
 *   - `/proc` and `/dev` are pseudo — required for many CLIs to work
 *   - `--unshare-net` means no network access (the agent must use webfetch)
 *   - `--die-with-parent` kills the sandbox if the parent dies — no orphans
 *
 * Preflight:
 *   - Linux only (process.platform === 'linux')
 *   - `bwrap` binary must be on PATH (`commandExists('bwrap')`)
 *
 * What this gives us over `local`:
 *   - Real filesystem namespace (writes outside `/workspace` are invisible)
 *   - Real PID namespace (process tree is invisible to the host)
 *   - Real network namespace (no accidental outbound connections)
 *
 * Trade-offs:
 *   - Linux-only
 *   - Adds ~50ms startup overhead per command
 *   - Some tools that expect specific paths (e.g. /etc/resolv.conf) won't work
 */
import { resolve } from 'node:path'
import type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunner,
} from './runner.js'
import { PathGuard } from './path-guard.js'
import { commandExists } from '../../utils/command-exists.js'
import { runChild, scrubEnv } from './process-runner.js'

export class BubblewrapSandbox implements SandboxRunner {
  readonly mode = 'bubblewrap' as const
  readonly pathGuard: PathGuard
  private readonly cwd: string

  constructor(opts: { cwd: string; extraWritable?: string[] }) {
    this.cwd = resolve(opts.cwd)
    this.pathGuard = new PathGuard({
      cwd: this.cwd,
      extraWritable: opts.extraWritable,
    })
  }

  /**
   * Verifies `bwrap` is installed and reports its version. Returns null
   * on success (per the `SandboxRunner.healthcheck()` convention) or a
   * human-readable error message on failure.
   */
  async healthcheck(): Promise<string | null> {
    if (process.platform !== 'linux') {
      return `bubblewrap requires Linux; detected ${process.platform}`
    }
    if (!commandExists('bwrap')) {
      return 'bubblewrap (bwrap) is not installed; on Debian/Ubuntu run `apt install bubblewrap`'
    }
    return null
  }

  async run(cmd: string, opts: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const hc = await this.healthcheck()
    if (hc) throw new Error(hc)

    const env = { ...scrubEnv(process.env), ...(opts.env ?? {}) }
    const args = [
      '--ro-bind', '/usr', '/usr',
      '--ro-bind', '/lib', '/lib',
      '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', '/etc', '/etc',
      '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/sbin', '/sbin',
      '--bind', this.cwd, '/workspace',
      '--tmpfs', '/tmp',
      '--proc', '/proc',
      '--dev', '/dev',
      '--unshare-pid',
      '--unshare-net',
      '--unshare-ipc',
      '--hostname', 'yuancode',
      '--die-with-parent',
      '/bin/sh', '-c', cmd,
    ]
    return runChild({
      cmd: 'bwrap',
      args,
      spawnOpts: { cwd: this.cwd, env },
      displayCommand: `bwrap ... /bin/sh -c ${shorten(cmd)}`,
      runOpts: opts,
    })
  }
}

function shorten(cmd: string): string {
  return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd
}