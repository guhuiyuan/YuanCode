/**
 * Write tool — create or overwrite a file.
 *
 * Before writing, the CheckpointManager snapshots the existing file (or
 * records a "would-create" sentinel if it doesn't exist yet). This lets the
 * user /rewind back to the pre-write state from the TUI.
 *
 * The path is validated against the sandbox path-guard. Writes outside the
 * allowed roots fail with a tool_result error so the model can recover.
 */
import { z } from 'zod'
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'
import type { CheckpointManager } from '../core/checkpoint-manager.js'

export const WriteInputSchema = z.object({
  path: z.string().min(1).describe(
    'Path of the file to write, relative to project root or absolute. ' +
      'Parent directories are created as needed.',
  ),
  content: z.string().describe('Full file contents. Overwrites existing file.'),
})

export type WriteInput = z.infer<typeof WriteInputSchema>

export interface WriteToolOptions {
  cwd: string
  extraWritable?: string[]
  checkpoints: CheckpointManager
}

export function makeWriteTool(opts: WriteToolOptions): ToolEntry<typeof WriteInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd, extraWritable: opts.extraWritable })
  return {
    name: 'write',
    description:
      'Write content to a file (creates parent directories as needed). ' +
      'Snapshots the existing file before overwriting, so the user can ' +
      '/rewind. For surgical edits to an existing file, prefer `edit`.',
    schema: WriteInputSchema,
    risk: 'high',
    parallelSafe: false,
    timeoutMs: 10_000,
    category: 'file',
    handler: async (input) => {
      const abs = resolveAgainstSandbox(guard, opts.cwd, input.path, 'write')
      const cpId = await opts.checkpoints.snapshot(abs, `write:${input.path}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, input.content, { encoding: 'utf8' })
      return {
        content:
          `<write path=${shellAttr(input.path)} bytes=${byteLength(input.content)} ` +
          `checkpoint=${cpId} />`,
        metadata: { path: abs, bytes: byteLength(input.content), checkpointId: cpId },
      }
    },
  }
}

function resolveAgainstSandbox(guard: PathGuard, base: string, p: string, mode: 'read' | 'write'): string {
  const abs = resolve(base, p)
  guard.assert(abs, mode)
  return abs
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

function shellAttr(s: string): string {
  return `"${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
}
