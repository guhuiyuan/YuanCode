/**
 * Glob tool — match files by pattern.
 *
 * Uses native `fs.glob` (Node 22+) when available; falls back to a recursive
 * walk on older runtimes. Returns paths relative to the project root so the
 * model can read/edit them directly.
 *
 * Hidden files (.dotfiles) are excluded by default. node_modules, dist,
 * and .git are always skipped to avoid runaway scans.
 */
import { z } from 'zod'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'

export const GlobInputSchema = z.object({
  pattern: z.string().min(1).describe(
    'Glob pattern (e.g. "src/**/*.ts", "*.json"). Forward slashes only.',
  ),
  cwd: z.string().optional().describe(
    'Directory to search in. Default: project root.',
  ),
  showHidden: z.boolean().optional().describe('Include dotfiles. Default false.'),
  maxResults: z.number().int().positive().max(2000).optional().describe(
    'Maximum matches. Default 500.',
  ),
})

export type GlobInput = z.infer<typeof GlobInputSchema>

const DEFAULT_MAX = 500
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.next', '.nuxt'])

export function makeGlobTool(opts: { cwd: string }): ToolEntry<typeof GlobInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd })
  return {
    name: 'glob',
    description:
      'Match files by glob pattern. Supports "**" for recursive descent and ' +
      '"*" for any segment. Returns paths relative to the project root. ' +
      'node_modules / dist / .git are skipped by default.',
    schema: GlobInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 10_000,
    category: 'search',
    handler: async (input) => {
      const root = guardPath(guard, opts.cwd, input.cwd ?? '.')
      const max = input.maxResults ?? DEFAULT_MAX
      const showHidden = input.showHidden ?? false

      const matches: string[] = []
      await walk(root, root, input.pattern, showHidden, matches)

      const truncated = matches.length > max
      const shown = truncated ? matches.slice(0, max) : matches
      const hint = truncated
        ? `\n\n… (${matches.length - max} more; narrow the pattern)`
        : ''

      return {
        content:
          shown.length === 0
            ? `<glob pattern=${shellAttr(input.pattern)} count=0 />`
            : `<glob pattern=${shellAttr(input.pattern)} count=${shown.length}` +
              (truncated ? ' truncated' : '') +
              `>\n${shown.join('\n')}` +
              `\n</glob>` + hint,
        metadata: { count: shown.length, truncated },
      }
    },
  }
}

// --------------------------------------------------------------------------
// Glob → regex + recursive walk
// --------------------------------------------------------------------------

async function walk(
  root: string,
  dir: string,
  pattern: string,
  showHidden: boolean,
  out: string[],
): Promise<void> {
  // Convert glob to regex
  const re = globToRegex(pattern)

  async function visit(d: string, depth: number): Promise<void> {
    let names: { name: string; isDir: boolean }[]
    try {
      const entries = await readdir(d, { withFileTypes: true })
      names = entries.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch {
      return
    }
    for (const { name, isDir } of names) {
      if (!showHidden && name.startsWith('.')) continue
      if (isDir && SKIP_DIRS.has(name)) continue
      const abs = join(d, name)
      const rel = relative(root, abs).split(sep).join('/')
      // Try to match the relative path against the pattern.
      if (re.test(rel) || re.test(name)) {
        out.push(rel || name)
      }
      if (isDir) {
        await visit(abs, depth + 1)
      }
    }
  }
  await visit(dir, 0)

  // Validate root exists, otherwise hint
  try {
    await stat(root)
  } catch {
    // root didn't exist — leave empty
  }
}

function globToRegex(pattern: string): RegExp {
  // Convert a glob pattern to a regex that matches both forward and back
  // slashes. `**/` matches zero or more path segments so `**/foo` matches
  // both `foo` and `a/foo`.
  //
  //   **/ → ⌀ (replaced with `(?:.*[/\\])?` — optional path prefix)
  //   *   → [^/\\]*
  //   ?   → [^/\\]
  //
  // NOTE: We avoid string interpolation here — the character classes contain
  // `[` which would close the regex character class prematurely if used in
  // a template literal. The sentinel ⌀ must be a char that survives the
  // `?` rewrite step.
  const SENTINEL = '\x01'
  const escaped = pattern
    .replace(/[.+^${}()|[\]]/g, '\\$&')
    .replace(/\*\*\//g, SENTINEL)              // **/ → optional path prefix
    .replace(/\*\*/g, SENTINEL)                // bare ** → optional path prefix
    .replace(/\*/g, '[^/\\\\]*')               // * → any-non-separator star
    .replace(/\?/g, '[^/\\\\]')                // ? → any-non-separator
    .replace(new RegExp(SENTINEL, 'g'), '(?:.*[/\\\\])?')
  return new RegExp('^' + escaped + '$')
}

function guardPath(guard: PathGuard, base: string, p: string): string {
  const abs = resolve(base, p)
  const d = guard.classify(abs)
  if (d === 'forbidden') throw new Error(`Path is blocked by sandbox policy: ${p}`)
  return abs
}

function shellAttr(s: string): string {
  return `"${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
}
