/**
 * Path safety utilities.
 *
 * Used by the sandbox runner and the `read`/`write`/`edit` tools to ensure
 * every path operation is bounded to an allowed root. Two failure modes to
 * defend against:
 *
 *   1. Path traversal:  `../../../etc/passwd`
 *   2. Absolute paths:  `C:\Windows\System32\config\SAM`
 *
 * The strategy is: resolve the candidate path, then verify it is `===`
 * or startsWith the allowed root (followed by a separator). This catches
 * both `..` and symlink-style escape attempts when paired with `realpath`.
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export class PathAccessError extends Error {
  constructor(message: string, public readonly path: string) {
    super(message)
    this.name = 'PathAccessError'
  }
}

/**
 * Validate that `candidate` is inside `root` (after resolving both to absolute
 * paths). Returns the normalized absolute path on success; throws otherwise.
 *
 * Set `rootMustExist` to true when you also want to confirm the root exists.
 */
export async function ensureInsideRoot(
  candidate: string,
  root: string,
  opts: { rootMustExist?: boolean; requireExists?: boolean } = {},
): Promise<string> {
  const absRoot = resolve(root)
  const absCandidate = resolve(candidate)

  if (opts.rootMustExist) {
    try {
      await stat(absRoot)
    } catch {
      throw new PathAccessError(`Allowed root does not exist: ${absRoot}`, absRoot)
    }
  }

  const rel = relative(absRoot, absCandidate)
  const isInside =
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))

  if (!isInside) {
    throw new PathAccessError(
      `Path is outside allowed root: ${absCandidate} (root=${absRoot})`,
      absCandidate,
    )
  }

  if (opts.requireExists) {
    try {
      await stat(absCandidate)
    } catch {
      throw new PathAccessError(`Path does not exist: ${absCandidate}`, absCandidate)
    }
  }

  return absCandidate
}

/**
 * Block list of system-critical paths the agent must never touch, regardless
 * of the configured project root. Cross-platform.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /(^|[\\/])\.ssh([\\/]|$)/,
  /(^|[\\/])\.aws([\\/]|$)/,
  /(^|[\\/])\.gnupg([\\/]|$)/,
  /(^|[\\/])\.kube([\\/]|$)/,
  /(^|[\\/])\.docker([\\/]|$)/,
  /(^|\\)(Windows)\\System32([\\/]|$)/i,
  /(^|[\\/])etc([\\/])(passwd|shadow|sudoers)/,
  /proc\/\d+\/(environ|mem|cmdline)/,
]

export function isForbiddenPath(absolutePath: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(absolutePath))
}

/**
 * Combine path safety: ensure path is inside root AND not on the forbidden list.
 */
export async function safeResolve(
  candidate: string,
  root: string,
  opts: { requireExists?: boolean } = {},
): Promise<string> {
  const abs = await ensureInsideRoot(candidate, root, opts)
  if (isForbiddenPath(abs)) {
    throw new PathAccessError(
      `Path matches forbidden system location: ${abs}`,
      abs,
    )
  }
  return abs
}

/**
 * Resolve to the real (symlink-followed) path. Use this in addition to
 * safeResolve when you want to defeat symlink-based escape attempts.
 */
export async function realpathSafe(p: string): Promise<string> {
  return await realpath(p)
}

/** Display helper: show only the path relative to root when possible. */
export function displayPath(p: string, root?: string): string {
  if (!root) return p
  const rel = relative(root, p)
  return rel && !rel.startsWith('..') ? rel : p
}
