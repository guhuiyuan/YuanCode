/**
 * Read tool — read a file with optional offset/limit (line-based).
 *
 * The path is validated against the sandbox path-guard before any I/O. Files
 * larger than `hardLimitBytes` are truncated and the model is told to use
 * offset/limit to paginate.
 *
 * Binary detection: if the first 8 KiB contain a NUL byte, the file is
 * treated as binary and the result is a hex preview (first 4 KiB) plus the
 * byte count.
 */
import { z } from 'zod'
import { stat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolContext, ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'

export const ReadInputSchema = z.object({
  path: z.string().min(1).describe(
    'Path to the file, relative to project root or absolute. ' +
      'Cannot escape the sandbox.',
  ),
  offset: z.number().int().nonnegative().optional().describe(
    'Line number to start reading from (0-based). Default 0.',
  ),
  limit: z.number().int().positive().max(2000).optional().describe(
    'Maximum number of lines to return. Default 200, max 2000.',
  ),
})

export type ReadInput = z.infer<typeof ReadInputSchema>

const DEFAULT_LIMIT = 200
const HARD_LIMIT_BYTES = 256 * 1024 // 256 KiB
const BINARY_SNIFF_BYTES = 8192

export function makeReadTool(opts: { cwd: string; extraWritable?: string[] }): ToolEntry<typeof ReadInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd, extraWritable: opts.extraWritable })
  return {
    name: 'read',
    description:
      'Read a text file. Supports line-range paging via `offset` (0-based ' +
      'line number) and `limit` (max lines returned, default 200, max 2000). ' +
      'Binary files are detected and returned as a hex preview. Files larger ' +
      'than 256 KiB are truncated — paginate with offset/limit to read more.',
    schema: ReadInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5000,
    category: 'file',
    handler: async (input, _ctx: ToolContext) => {
      const abs = resolveAgainstSandbox(guard, opts.cwd, input.path ?? '.')
      let st
      try {
        st = await stat(abs)
      } catch (e) {
        const err = e as NodeJS.ErrnoException
        if (err.code === 'ENOENT') return ise(`File does not exist: ${input.path}`)
        throw e
      }
      if (!st.isFile()) {
        return ise(`Not a regular file: ${input.path}`)
      }

      // Sniff binary
      const fh = await readFile(abs)
      const sniffLen = Math.min(fh.length, BINARY_SNIFF_BYTES)
      let isBinary = false
      for (let i = 0; i < sniffLen; i++) {
        if (fh[i] === 0) {
          isBinary = true
          break
        }
      }
      if (isBinary) {
        const previewBytes = fh.subarray(0, 4096)
        return {
          content:
            `<binary file: ${st.size} bytes>\n` +
            `<hex preview (first 4 KiB)>\n${previewBytes.toString('hex').match(/.{1,64}/g)?.join('\n') ?? ''}`,
          metadata: { bytes: st.size, binary: true },
        }
      }

      const text = fh.toString('utf8')
      const lines = text.split(/\r?\n/)
      const offset = input.offset ?? 0
      const limit = input.limit ?? DEFAULT_LIMIT
      const slice = lines.slice(offset, offset + limit)
      const numbered = slice
        .map((ln, i) => `${String(offset + i + 1).padStart(6, ' ')}\t${ln}`)
        .join('\n')

      const truncated = fh.length > HARD_LIMIT_BYTES || offset + limit < lines.length
      const more = truncated
        ? `\n\n… (${lines.length - (offset + slice.length)} more lines; use offset=${offset + slice.length} to continue)`
        : ''

      return {
        content:
          `<file path=${shellAttr(input.path)} lines=${lines.length} bytes=${st.size}>\n` +
          numbered +
          more +
          `\n</file>`,
        metadata: { lines: lines.length, bytes: st.size, truncated },
      }
    },
  }
}

function resolveAgainstSandbox(guard: PathGuard, base: string, p: string): string {
  // Resolve relative paths against the tool's cwd, not process.cwd(),
  // so the model can use relative paths that match the user's project.
  const abs = resolve(base, p)
  // Classify against the sandbox rules.
  const decision = guard.classify(abs)
  if (decision === 'forbidden') {
    throw new Error(`Path is blocked by sandbox policy: ${p}`)
  }
  return abs
}

function ise(msg: string): { content: string; isError: true } {
  return { content: msg, isError: true }
}

function shellAttr(s: string): string {
  return `"${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
}
