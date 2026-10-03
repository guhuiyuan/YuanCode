/**
 * ls tool — list a directory.
 *
 * Returns relative paths from the project root for easy model consumption.
 * Hidden files (.dotfiles) are excluded by default. Output is capped at
 * 500 entries to keep tool_result size sane; a hint is added when truncated.
 */
import { z } from 'zod'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'

export const LsInputSchema = z.object({
  path: z.string().min(1).default('.').describe(
    'Directory to list, relative to project root or absolute. Default ".".',
  ),
  showHidden: z.boolean().optional().describe(
    'Include dotfiles (e.g. .git, .env). Default false.',
  ),
  maxDepth: z.number().int().positive().max(5).optional().describe(
    'Maximum recursion depth. 1 = non-recursive (default), max 5.',
  ),
})

export type LsInput = z.infer<typeof LsInputSchema>

const MAX_ENTRIES = 500

export function makeLsTool(opts: { cwd: string; extraWritable?: string[] }): ToolEntry<typeof LsInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd, extraWritable: opts.extraWritable })
  return {
    name: 'ls',
    description:
      'List the contents of a directory. Non-recursive by default (maxDepth=1). ' +
      'Hidden files are excluded unless showHidden=true. Output capped at ' +
      '500 entries; use a narrower path or a glob if you hit the cap.',
    schema: LsInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5000,
    category: 'file',
    handler: async (input) => {
      const abs = guardPath(guard, opts.cwd, input.path ?? '.')
      let st
      try {
        st = await stat(abs)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') return { content: `Directory does not exist: ${input.path}`, isError: true }
        throw e
      }
      if (!st.isDirectory()) {
        return { content: `Not a directory: ${input.path}`, isError: true }
      }

      const entries = await collect(abs, opts.cwd, {
        maxDepth: input.maxDepth ?? 1,
        showHidden: input.showHidden ?? false,
      })
      const truncated = entries.length > MAX_ENTRIES
      const shown = truncated ? entries.slice(0, MAX_ENTRIES) : entries
      const hint = truncated ? `\n\n… (${entries.length - MAX_ENTRIES} more entries; narrow the path)` : ''

      return {
        content:
          `<ls path=${shellAttr(input.path)} count=${shown.length}` +
          (truncated ? ' truncated' : '') +
          `>\n` +
          shown.join('\n') +
          `\n</ls>` + hint,
        metadata: { count: shown.length, truncated },
      }
    },
  }
}

interface CollectOpts {
  maxDepth: number
  showHidden: boolean
}

async function collect(
  root: string,
  displayRoot: string,
  opts: CollectOpts,
): Promise<string[]> {
  const out: string[] = []
  await walk(root, root, displayRoot, 0, opts, out)
  // Stable sort: directories first, then alphabetical.
  // Directories end with the platform separator ('/' on POSIX, '\' on Windows).
  const isDir = (s: string): boolean => s.endsWith('/') || s.endsWith('\\')
  return out.sort((a, b) => {
    const ad = isDir(a) ? 0 : 1
    const bd = isDir(b) ? 0 : 1
    if (ad !== bd) return ad - bd
    return a.localeCompare(b)
  })
}

async function walk(
  root: string,
  dir: string,
  displayRoot: string,
  depth: number,
  opts: CollectOpts,
  out: string[],
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (!opts.showHidden && name.startsWith('.')) continue
    const abs = join(dir, name)
    let isDir = false
    try {
      const st = await stat(abs)
      isDir = st.isDirectory()
    } catch {
      continue
    }
    const rel = relative(displayRoot, abs) || name
    const display = isDir ? rel + sep : rel
    out.push(display)
    if (isDir && depth + 1 < opts.maxDepth) {
      await walk(root, abs, displayRoot, depth + 1, opts, out)
    }
  }
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
