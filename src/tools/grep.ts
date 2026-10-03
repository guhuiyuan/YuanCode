/**
 * Grep tool — content search across files.
 *
 * Uses ripgrep (`rg`) when available; otherwise falls back to a synchronous
 * Node-based scanner. The rg fast-path is ~10–100× faster on large repos,
 * which matters because the agent hammers this tool.
 *
 * Patterns are ripgrep / regex syntax. Results are returned as
 * `<file>:<line>:<content>` lines — the standard grep -n format the model
 * already knows.
 */
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'
import { LocalSandbox } from '../core/sandbox/local.js'

export const GrepInputSchema = z.object({
  pattern: z.string().min(1).describe(
    'Regex pattern (ripgrep / JS regex syntax). Search is line-based.',
  ),
  path: z.string().min(1).default('.').describe(
    'File or directory to search. Default "." (project root).',
  ),
  include: z.string().optional().describe(
    'Glob filter for files to search (e.g. "*.ts").',
  ),
  maxResults: z.number().int().positive().max(500).optional().describe(
    'Maximum matches to return. Default 100, max 500.',
  ),
  caseInsensitive: z.boolean().optional().describe(
    'Case-insensitive match. Default false.',
  ),
})

export type GrepInput = z.infer<typeof GrepInputSchema>

const DEFAULT_MAX = 100

export function makeGrepTool(opts: { cwd: string; sandbox: LocalSandbox }): ToolEntry<typeof GrepInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd })
  return {
    name: 'grep',
    description:
      'Search file contents using a regex. Returns `<file>:<line>:<text>` ' +
      'lines. Uses ripgrep (`rg`) when installed; falls back to a JS scanner ' +
      'otherwise. Use `include` to limit by extension (e.g. "*.ts").',
    schema: GrepInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 30_000,
    category: 'search',
    handler: async (input) => {
      const abs = guardPath(guard, opts.cwd, input.path ?? '.')
      const max = input.maxResults ?? DEFAULT_MAX

      // Try ripgrep first.
      if (await hasRipgrep()) {
        return await ripgrep(abs, input, max)
      }
      return await fallbackScan(abs, input, max)
    },
  }
}

// --------------------------------------------------------------------------
// ripgrep fast path
// --------------------------------------------------------------------------

async function ripgrep(
  cwd: string,
  input: GrepInput,
  max: number,
): Promise<{ content: string; metadata?: Record<string, unknown>; isError?: boolean }> {
  const args = [
    '--line-number',
    '--no-heading',
    '--color=never',
    '--no-messages',
    input.caseInsensitive ? '--ignore-case' : '--case-sensitive',
  ]
  if (input.include) args.push('--glob', input.include)
  args.push(input.pattern, cwd)

  const child = spawn('rg', args, { windowsHide: true })
  let out = ''
  let err = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => {
    if (out.length < 200_000) out += c
  })
  child.stderr.on('data', (c: string) => {
    if (err.length < 4_000) err += c
  })
  const exitCode = await new Promise<number>((resolveExit) => {
    child.on('close', resolveExit)
    child.on('error', () => resolveExit(1))
  })

  // rg exits 1 when no matches — not an error.
  if (exitCode !== 0 && exitCode !== 1) {
    return {
      content: `ripgrep failed (exit ${exitCode}): ${err || '(no stderr)'}`,
      isError: true,
    }
  }

  const allLines = out.split(/\r?\n/).filter(Boolean)
  const truncated = allLines.length > max
  const shown = truncated ? allLines.slice(0, max) : allLines
  if (shown.length === 0) {
    return { content: `<grep pattern=${shellAttr(input.pattern)} count=0 />` }
  }
  return {
    content:
      `<grep pattern=${shellAttr(input.pattern)} count=${shown.length}` +
      (truncated ? ' truncated' : '') +
      `>\n${shown.join('\n')}` +
      (truncated ? `\n… (${allLines.length - max} more matches; narrow the pattern or path)` : '') +
      `\n</grep>`,
    metadata: { total: allLines.length, truncated },
  }
}

// --------------------------------------------------------------------------
// JS fallback
// --------------------------------------------------------------------------

async function fallbackScan(
  abs: string,
  input: GrepInput,
  max: number,
): Promise<{ content: string; metadata?: Record<string, unknown>; isError?: boolean }> {
  let regex: RegExp
  try {
    regex = new RegExp(input.pattern, input.caseInsensitive ? 'i' : '')
  } catch (e) {
    return {
      content: `Invalid regex: ${e instanceof Error ? e.message : String(e)}`,
      isError: true,
    }
  }

  // Decide whether `abs` is a single file or a directory.
  const st = await stat(abs).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new Error(`Path does not exist: ${input.path}`)
    throw e
  })

  const matches: string[] = []
  const files: string[] = st.isFile() ? [abs] : await collectFiles(abs)

  for (const f of files) {
    if (input.include && !matchGlob(f, input.include)) continue
    let text: string
    try {
      text = await readFile(f, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        matches.push(`${relative(process.cwd(), f) || f}:${i + 1}:${lines[i]}`)
        if (matches.length >= max * 2) break // over-collect, then truncate
      }
    }
    if (matches.length >= max * 2) break
  }

  const truncated = matches.length > max
  const shown = truncated ? matches.slice(0, max) : matches
  return {
    content:
      shown.length === 0
        ? `<grep pattern=${shellAttr(input.pattern)} count=0 />`
        : `<grep pattern=${shellAttr(input.pattern)} count=${shown.length}` +
          (truncated ? ' truncated' : '') +
          `>\n${shown.join('\n')}` +
          (truncated ? `\n… (more matches; narrow the pattern)` : '') +
          `\n</grep>`,
    metadata: { total: matches.length, truncated, ripgrep: false },
  }
}

async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      // Skip heavy dirs
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git') continue
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(p)
      } else if (e.isFile()) {
        out.push(p)
      }
    }
  }
  await walk(root)
  return out
}

// Minimal glob-to-regex for the `include` filter (only handles `*.ext` and `name.ext`).
function matchGlob(filePath: string, pattern: string): boolean {
  // Only operate on the basename.
  const base = filePath.split(sep).pop() ?? filePath
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  )
  return re.test(base)
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

let ripgrepChecked = false
let ripgrepPresent = false

async function hasRipgrep(): Promise<boolean> {
  if (ripgrepChecked) return ripgrepPresent
  ripgrepChecked = true
  return await new Promise<boolean>((resolveRg) => {
    const child = spawn('rg', ['--version'], { windowsHide: true })
    child.on('close', (code) => {
      ripgrepPresent = code === 0
      resolveRg(ripgrepPresent)
    })
    child.on('error', () => {
      ripgrepPresent = false
      resolveRg(false)
    })
  })
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
