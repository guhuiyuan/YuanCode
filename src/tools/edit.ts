/**
 * Edit tool — surgical string-replace inside a file.
 *
 * Diff-style:
 *   - `oldText` must appear EXACTLY ONCE in the file (after the optional
 *     `globalReplace` is applied). If it appears 0 or >1 times the tool
 *     returns isError so the model can refine.
 *   - If `globalReplace` is true, all occurrences are replaced.
 *
 * The pre-edit file is snapshotted via CheckpointManager before mutation.
 */
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ToolEntry } from '../core/tool-registry.js'
import { PathGuard } from '../core/sandbox/path-guard.js'
import type { CheckpointManager } from '../core/checkpoint-manager.js'

export const EditInputSchema = z.object({
  path: z.string().min(1).describe(
    'Path of the file to edit, relative to project root or absolute.',
  ),
  oldText: z.string().min(1).describe(
    'The exact substring to find. Must be unique in the file unless ' +
      'globalReplace is true.',
  ),
  newText: z.string().describe('The replacement text.'),
  globalReplace: z.boolean().optional().describe(
    'If true, replace all occurrences instead of requiring uniqueness. ' +
      'Default false.',
  ),
})

export type EditInput = z.infer<typeof EditInputSchema>

export interface EditToolOptions {
  cwd: string
  extraWritable?: string[]
  checkpoints: CheckpointManager
}

export function makeEditTool(opts: EditToolOptions): ToolEntry<typeof EditInputSchema> {
  const guard = new PathGuard({ cwd: opts.cwd, extraWritable: opts.extraWritable })
  return {
    name: 'edit',
    description:
      'Surgical edit to an existing file: replaces `oldText` with `newText`. ' +
      'By default, `oldText` must occur exactly once. Set `globalReplace: true` ' +
      'to replace every occurrence. Snapshots the file before editing so the ' +
      'user can /rewind. Use `write` for full-file overwrites.',
    schema: EditInputSchema,
    risk: 'high',
    parallelSafe: false,
    timeoutMs: 10_000,
    category: 'file',
    handler: async (input) => {
      const abs = validatePath(guard, opts.cwd, input.path, 'write')
      const original = await readFile(abs, 'utf8')

      let occurrences: number
      let updated: string
      if (input.globalReplace) {
        occurrences = original.split(input.oldText).length - 1
        updated = original.split(input.oldText).join(input.newText)
      } else {
        const first = original.indexOf(input.oldText)
        if (first < 0) {
          return {
            content:
              `oldText not found in ${shellAttr(input.path)}. ` +
              `Tip: read the file first to see exact whitespace.`,
            isError: true,
          }
        }
        const second = original.indexOf(input.oldText, first + input.oldText.length)
        if (second >= 0) {
          occurrences =
            original.split(input.oldText).length - 1
          return {
            content:
              `oldText is not unique in ${shellAttr(input.path)} ` +
              `(${occurrences} occurrences). Pass more surrounding context ` +
              `or set globalReplace=true.`,
            isError: true,
          }
        }
        occurrences = 1
        updated =
          original.slice(0, first) +
          input.newText +
          original.slice(first + input.oldText.length)
      }

      if (occurrences === 0) {
        return {
          content: `oldText not found in ${shellAttr(input.path)}.`,
          isError: true,
        }
      }

      const cpId = await opts.checkpoints.snapshot(abs, `edit:${input.path}`)
      await writeFile(abs, updated, 'utf8')

      const delta = input.newText.length - input.oldText.length
      return {
        content:
          `<edit path=${shellAttr(input.path)} occurrences=${occurrences} ` +
          `delta_bytes=${delta} checkpoint=${cpId} />`,
        metadata: {
          path: abs,
          occurrences,
          bytesBefore: Buffer.byteLength(original, 'utf8'),
          bytesAfter: Buffer.byteLength(updated, 'utf8'),
          checkpointId: cpId,
        },
      }
    },
  }
}

function validatePath(guard: PathGuard, base: string, p: string, mode: 'read' | 'write'): string {
  const abs = resolve(base, p)
  guard.assert(abs, mode)
  return abs
}

function shellAttr(s: string): string {
  return `"${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
}
