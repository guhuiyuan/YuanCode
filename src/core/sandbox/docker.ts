/**
 * Docker sandbox — cross-platform container isolation.
 *
 * Wraps every command in `docker run --rm -i` against a configurable image
 * (default `yuancode/sandbox:latest`):
 *
 *   docker run --rm -i \
 *     -v <cwd>:/workspace \
 *     -w /workspace \
 *     --network none \
 *     --memory 512m --cpus 1 \
 *     -e YUAN_INSIDE_SANDBOX=1 \
 *     <image> \
 *     /bin/sh -c <cmd>
 *
 * Why this list:
 *   - `--rm -i` keeps stdout open and cleans up on exit
 *   - `--network none` is the default; override via `DockerRunOptions.network`
 *   - `--memory 512m --cpus 1` gives soft resource limits; tune in image
 *   - The volume mount projects the user's cwd into the container at
 *     `/workspace`. On Windows / macOS the docker daemon handles the bind
 *     mount translation automatically.
 *
 * Image:
 *   - `image` is read from `config.sandbox.image` (schema field that
 *     existed since M0 but had no consumer until M7).
 *   - The container ships with Node + bash + coreutils + git. See
 *     `bin/sandbox/Dockerfile` for the full image recipe.
 *
 * Preflight:
 *   - `docker` CLI must be on PATH
 *   - Docker daemon must be running (`docker version` exits 0)
 *
 * Trade-offs:
 *   - Requires Docker daemon (slow CI on hosts without it)
 *   - Image pull on first use (~10s for a minimal image)
 *   - Volume mounts have known permission caveats on macOS
 */
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import type {
  SandboxRunOptions,
  SandboxRunResult,
  SandboxRunner,
} from './runner.js'
import { PathGuard } from './path-guard.js'
import { commandExists } from '../../utils/command-exists.js'
import { runChild, scrubEnv } from './process-runner.js'

export interface DockerSandboxOptions {
  cwd: string
  extraWritable?: string[]
  /** Image to run. Defaults to `yuancode/sandbox:latest`. */
  image?: string
  /** Default 'none'. Override to 'host' (or 'bridge') to allow network. */
  network?: 'none' | 'host' | 'bridge'
  /** Memory limit (Docker --memory flag). Default 512m. */
  memory?: string
  /** CPU limit (Docker --cpus flag). Default 1.0. */
  cpus?: number
}

export class DockerSandbox implements SandboxRunner {
  readonly mode = 'docker' as const
  readonly pathGuard: PathGuard
  private readonly cwd: string
  private readonly image: string
  private readonly network: 'none' | 'host' | 'bridge'
  private readonly memory: string
  private readonly cpus: number

  constructor(opts: DockerSandboxOptions) {
    this.cwd = resolve(opts.cwd)
    this.pathGuard = new PathGuard({
      cwd: this.cwd,
      extraWritable: opts.extraWritable,
    })
    this.image = opts.image ?? 'yuancode/sandbox:latest'
    this.network = opts.network ?? 'none'
    this.memory = opts.memory ?? '512m'
    this.cpus = opts.cpus ?? 1
  }

  async healthcheck(): Promise<string | null> {
    if (!commandExists('docker')) {
      return 'docker CLI not found on PATH; install Docker Desktop or docker-ce'
    }
    // Confirm the daemon is responsive (not just the CLI).
    const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (probe.status !== 0) {
      return 'docker CLI found but daemon is not responding; start Docker Desktop'
    }
    return null
  }

  async run(cmd: string, opts: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    const hc = await this.healthcheck()
    if (hc) throw new Error(hc)

    // Re-inject only YUANCODE_API_KEY — the rest is scrubbed.
    const env = { ...scrubEnv(process.env), ...(opts.env ?? {}) }
    const args = [
      'run', '--rm', '-i',
      '-v', `${this.cwd}:/workspace`,
      '-w', '/workspace',
      '--network', this.network,
      '--memory', this.memory,
      '--cpus', String(this.cpus),
      '-e', 'YUAN_INSIDE_SANDBOX=1',
      this.image,
      '/bin/sh', '-c', cmd,
    ]
    return runChild({
      cmd: 'docker',
      args,
      spawnOpts: { cwd: this.cwd, env },
      displayCommand: `docker run --rm -i ... ${this.image} /bin/sh -c ${shorten(cmd)}`,
      runOpts: opts,
    })
  }
}

function shorten(cmd: string): string {
  return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd
}