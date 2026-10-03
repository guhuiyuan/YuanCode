/**
 * Sandbox factory. Reads the sandbox mode from config and returns the
 * matching runner. All four modes ship in M7:
 *   - `local`     — cross-platform default, no isolation
 *   - `bubblewrap` — Linux-only, user-namespace filesystem isolation
 *   - `docker`    — cross-platform container isolation
 *   - `landlock`  — Linux 5.13+ + Node 22+, kernel-level FS isolation
 */
import type { SandboxRunner } from './runner.js'
import { LocalSandbox } from './local.js'
import { BubblewrapSandbox } from './bubblewrap.js'
import { DockerSandbox } from './docker.js'
import { LandlockSandbox } from './landlock.js'
import type { SandboxMode } from '../../config/schema.js'

export interface CreateSandboxOptions {
  mode: SandboxMode
  cwd: string
  extraWritable?: string[]
  /** Sandbox image for `docker` mode. */
  image?: string
  /** Network mode for `docker` mode. */
  network?: 'none' | 'host' | 'bridge'
  /** Memory limit for `docker` mode (e.g. '512m'). */
  memory?: string
  /** CPU limit for `docker` mode. */
  cpus?: number
}

export function createSandbox(opts: CreateSandboxOptions): SandboxRunner {
  switch (opts.mode) {
    case 'local':
      return new LocalSandbox({ cwd: opts.cwd, extraWritable: opts.extraWritable })
    case 'bubblewrap':
      if (process.platform !== 'linux') {
        throw new Error(
          `bubblewrap sandbox requires Linux; detected ${process.platform}`,
        )
      }
      return new BubblewrapSandbox({ cwd: opts.cwd, extraWritable: opts.extraWritable })
    case 'docker':
      return new DockerSandbox({
        cwd: opts.cwd,
        extraWritable: opts.extraWritable,
        image: opts.image,
        network: opts.network,
        memory: opts.memory,
        cpus: opts.cpus,
      })
    case 'landlock':
      if (process.platform !== 'linux') {
        throw new Error(
          `landlock sandbox requires Linux; detected ${process.platform}`,
        )
      }
      return new LandlockSandbox({ cwd: opts.cwd, extraWritable: opts.extraWritable })
    default: {
      const _exhaustive: never = opts.mode
      throw new Error(`Unknown sandbox mode: ${String(_exhaustive)}`)
    }
  }
}

export type { SandboxRunner, SandboxRunOptions, SandboxRunResult } from './runner.js'
export { PathGuard, SandboxPathError, type PathDecision } from './path-guard.js'
export { LocalSandbox } from './local.js'
export { BubblewrapSandbox } from './bubblewrap.js'
export { DockerSandbox } from './docker.js'
export { LandlockSandbox } from './landlock.js'