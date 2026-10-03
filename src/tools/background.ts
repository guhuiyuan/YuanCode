/**
 * Background tools — fire-and-forget tool execution with completion polling.
 *
 * Two tools in one file:
 *   background_start   submit a tool to run in the background, get an id
 *   background_check   poll a task by id, get its current state + result
 *
 * Use case: the agent kicks off `bash({ command: 'pnpm install' })` and
 * gets the task id immediately, then continues planning / other work. The
 * loop's MAINTENANCE phase surfaces completions automatically (as a
 * synthetic user message), but `background_check` is the way to fetch the
 * full output of a specific task without waiting for the next maintenance
 * window.
 */
import { z } from 'zod'
import type { ToolEntry, ToolContext } from '../core/tool-registry.js'
import { BackgroundTaskPool } from '../core/background-tasks.js'

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

export const BackgroundStartInputSchema = z.object({
  tool: z.string().describe('Name of the tool to invoke (e.g. "bash", "read").'),
  args: z
    .record(z.unknown())
    .describe('Arguments for the tool. Must match that tool\'s input schema.'),
  timeoutMs: z
    .number()
    .int()
    .min(1_000)
    .max(1_800_000)
    .optional()
    .describe('Optional per-task timeout in milliseconds. Defaults to the tool\'s own timeoutMs.'),
})

export const BackgroundCheckInputSchema = z.object({
  id: z.string().describe('Background task id returned by background_start.'),
})

// --------------------------------------------------------------------------
// Factory functions
// --------------------------------------------------------------------------

export function makeBackgroundStartTool(
  opts: { pool: BackgroundTaskPool; registry: import('../core/tool-registry.js').ToolRegistry },
): ToolEntry<typeof BackgroundStartInputSchema> {
  return {
    name: 'background_start',
    description:
      'Submit a tool call to run in the background. Returns the task id ' +
      'immediately; the tool will run concurrently with the agent loop. ' +
      'Use background_check(id) to fetch the result, or wait for the loop ' +
      'to surface it automatically during the next step.',
    schema: BackgroundStartInputSchema,
    risk: 'medium',
    parallelSafe: false,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input, ctx: ToolContext) => {
      if (!opts.registry.has(input.tool)) {
        return {
          content: `Tool "${input.tool}" is not registered. Available: ${opts.registry.list().map((t) => t.name).join(', ')}`,
          isError: true,
        }
      }
      try {
        const id = await opts.pool.start(
          { tool: input.tool, args: input.args, ctx },
          opts.registry,
        )
        return {
          content: `<background-started id="${id}" tool="${input.tool}">\nTask queued. Use background_check to poll.\n</background-started>`,
          metadata: { id, tool: input.tool },
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: `background_start failed: ${msg}`, isError: true }
      }
    },
  }
}

export function makeBackgroundCheckTool(
  opts: { pool: BackgroundTaskPool },
): ToolEntry<typeof BackgroundCheckInputSchema> {
  return {
    name: 'background_check',
    description:
      'Poll a background task by id. Returns its status and result if ' +
      'complete, or its current state if still running.',
    schema: BackgroundCheckInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input) => {
      const t = opts.pool.check(input.id)
      if (!t) {
        return { content: `Background task ${input.id} not found.`, isError: true }
      }
      const header =
        `id: ${t.id}\n` +
        `tool: ${t.tool}\n` +
        `status: ${t.status}\n` +
        `started: ${new Date(t.startedAt).toISOString()}\n` +
        (t.finishedAt ? `finished: ${new Date(t.finishedAt).toISOString()}\n` : '')
      let body = ''
      if (t.status === 'done' || t.status === 'error') {
        const content = t.result?.content ?? t.error ?? '(no output)'
        body = `\n${content}`
      }
      return {
        content: `${header}${body}`,
        metadata: { id: t.id, status: t.status, isError: t.status === 'error' },
      }
    },
  }
}