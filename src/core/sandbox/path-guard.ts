/**
 * Sandbox-specific path guard.
 *
 * Three policies, evaluated top-down. The first one that matches a path wins.
 *
 *   read+write paths (allowedRoots):
 *     - cwd and any subdirectory
 *     - $YUANCODE_SANDBOX_EXTRA_WRITABLE (colon-separated)
 *
 *   read-only paths (readOnlyRoots):
 *     - ~/.yuancode/sandbox/system   (built-in toolchain)
 *
 *   always-blocked paths (forbiddenPatterns):
 *     - ~/.ssh, ~/.aws, ~/.gnupg, ~/.kube, ~/.docker
 *     - /etc/passwd, /etc/shadow, /etc/sudoers
 *     - C:\Windows\System32
 *     - /proc/<pid>/{environ,mem,cmdline}
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|[\\/])\.ssh([\\/]|$)/,
  /(^|[\\/])\.aws([\\/]|$)/,
  /(^|[\\/])\.gnupg([\\/]|$)/,
  /(^|[\\/])\.kube([\\/]|$)/,
  /(^|[\\/])\.docker([\\/]|$)/,
  /(^|\\)(Windows)\\System32([\\/]|$)/i,
  /(^|[\\/])etc([\\/])(passwd|shadow|sudoers|sudoers\.d)/,
  /proc\/\d+\/(environ|mem|cmdline|maps)/,
]

export type PathDecision = 'allow' | 'readOnly' | 'forbidden'

export class PathGuard {
  private readonly allowedRoots: string[]
  private readonly readOnlyRoots: string[]

  constructor(opts: {
    cwd: string
    extraWritable?: string[]
    extraReadOnly?: string[]
  }) {
    const sysRo = resolve(homedir(), '.yuancode', 'sandbox', 'system')
    this.allowedRoots = [resolve(opts.cwd), ...(opts.extraWritable ?? []).map((p) => resolve(p))]
    this.readOnlyRoots = [sysRo, ...(opts.extraReadOnly ?? []).map((p) => resolve(p))]
  }

  classify(p: string): PathDecision {
    const abs = isAbsolute(p) ? p : resolve(p)

    // 1. forbidden beats everything
    if (FORBIDDEN_PATTERNS.some((re) => re.test(abs))) {
      return 'forbidden'
    }

    // 2. exact match or descendant of an allowed root?
    for (const root of this.allowedRoots) {
      if (this.isInside(abs, root)) return 'allow'
    }

    // 3. inside a read-only root?
    for (const root of this.readOnlyRoots) {
      if (this.isInside(abs, root)) return 'readOnly'
    }

    return 'forbidden'
  }

  assert(p: string, mode: 'read' | 'write'): void {
    const d = this.classify(p)
    if (d === 'forbidden') {
      throw new SandboxPathError(`Path is blocked by sandbox policy: ${p}`, p)
    }
    if (d === 'readOnly' && mode === 'write') {
      throw new SandboxPathError(`Path is read-only inside sandbox: ${p}`, p)
    }
  }

  /** Returns true iff `p` is exactly `root` or a descendant (path-segment aware). */
  private isInside(p: string, root: string): boolean {
    const rel = relative(root, p)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
}

export class SandboxPathError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message)
    this.name = 'SandboxPathError'
  }
}
