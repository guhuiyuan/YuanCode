/**
 * Task tools — CRUD over TaskManager.
 *
 * Four tools in one file because they share state and pattern:
 *   task_create    create a task with optional deps
 *   task_list      list non-deleted tasks as a markdown table
 *   task_update    patch fields + transition status
 *   task_get       fetch a single task by id
 *
 * All errors are returned as `ToolResult { isError: true }`. The TaskManager
 * throws `TaskError` with stable codes; we surface a friendly message.
 */
import { z } from 'zod'
import type { ToolEntry, ToolContext } from '../core/tool-registry.js'
import { TaskManager, TaskError, type TaskStatus } from '../core/task-manager.js'

// --------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------

export const TaskCreateInputSchema = z.object({
  title: z.string().min(1).max(200).describe('Short imperative, e.g. "Add tests for foo".'),
  description: z.string().max(2000).optional().describe('Longer context for the task. Optional.'),
  deps: z
    .array(z.string())
    .optional()
    .describe('IDs of tasks that must be completed before this one can start.'),
})

export const TaskListInputSchema = z.object({
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .optional()
    .describe('Filter to a single status. Omit to see all non-deleted tasks.'),
})

export const TaskUpdateInputSchema = z.object({
  id: z.string().describe('Task id.'),
  status: z
    .enum(['pending', 'in_progress', 'completed', 'deleted'])
    .optional()
    .describe('New status. Transitions are validated.'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  owner: z.string().optional().describe("'main' or a subagent id; informational."),
  result: z.string().max(20_000).optional().describe('Free-form result text (set when completing).'),
})

export const TaskGetInputSchema = z.object({
  id: z.string().describe('Task id.'),
})

// --------------------------------------------------------------------------
// Factory functions
// --------------------------------------------------------------------------

export function makeTaskCreateTool(opts: { manager: TaskManager }): ToolEntry<typeof TaskCreateInputSchema> {
  return {
    name: 'task_create',
    description:
      'Create a task. Tasks form a DAG; declare deps to express ordering. ' +
      'A task with empty deps and status="pending" is immediately runnable.',
    schema: TaskCreateInputSchema,
    risk: 'low',
    parallelSafe: false,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input, _ctx) => {
      try {
        const t = await opts.manager.create(input)
        return {
          content: `<task-created id="${t.id}">\n${t.title}\n</task-created>`,
          metadata: { id: t.id, status: t.status, deps: t.deps },
        }
      } catch (e) {
        return errResult(e, 'create')
      }
    },
  }
}

export function makeTaskListTool(opts: { manager: TaskManager }): ToolEntry<typeof TaskListInputSchema> {
  return {
    name: 'task_list',
    description:
      'List tasks as a markdown table. Shows id, status, deps, title. ' +
      'Use task_get(id) to fetch the full record for a single task.',
    schema: TaskListInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input) => {
      const tasks = await opts.manager.list(
        input.status ? { status: input.status as TaskStatus } : undefined,
      )
      if (tasks.length === 0) {
        return { content: 'No tasks yet. Use task_create to add one.' }
      }
      const header = '| id | status | deps | title |\n|---|---|---|---|'
      const rows = tasks
        .map((t) => {
          const deps = t.deps.length === 0 ? '—' : `${t.deps.length}`
          const title = t.title.length > 60 ? t.title.slice(0, 57) + '…' : t.title
          return `| ${t.id.slice(0, 8)} | ${t.status} | ${deps} | ${title} |`
        })
        .join('\n')
      return {
        content: `${header}\n${rows}\n\n${tasks.length} task(s).`,
        metadata: { count: tasks.length },
      }
    },
  }
}

export function makeTaskUpdateTool(opts: { manager: TaskManager }): ToolEntry<typeof TaskUpdateInputSchema> {
  return {
    name: 'task_update',
    description:
      'Update a task. Status transitions are validated (pending→in_progress→completed; ' +
      'anything else is rejected). Setting result is the canonical way to record completion.',
    schema: TaskUpdateInputSchema,
    risk: 'low',
    parallelSafe: false,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input) => {
      try {
        const { id, ...patch } = input
        const t = await opts.manager.update(id, patch)
        return {
          content: `<task-updated id="${t.id}" status="${t.status}">\n${t.title}\n</task-updated>`,
          metadata: { id: t.id, status: t.status },
        }
      } catch (e) {
        return errResult(e, 'update')
      }
    },
  }
}

export function makeTaskGetTool(opts: { manager: TaskManager }): ToolEntry<typeof TaskGetInputSchema> {
  return {
    name: 'task_get',
    description: 'Fetch a single task by id, including description, deps, owner, and result.',
    schema: TaskGetInputSchema,
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'agent',
    handler: async (input) => {
      const t = await opts.manager.get(input.id)
      if (!t) {
        return { content: `Task ${input.id} not found.`, isError: true }
      }
      const lines = [
        `id: ${t.id}`,
        `status: ${t.status}`,
        `title: ${t.title}`,
        `deps: ${t.deps.length === 0 ? '(none)' : t.deps.join(', ')}`,
        t.description ? `description: ${t.description}` : null,
        t.owner ? `owner: ${t.owner}` : null,
        t.result ? `result: ${t.result}` : null,
        `createdAt: ${new Date(t.createdAt).toISOString()}`,
        `updatedAt: ${new Date(t.updatedAt).toISOString()}`,
      ].filter((l): l is string => l !== null)
      return { content: lines.join('\n'), metadata: { id: t.id } }
    },
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function errResult(e: unknown, op: string): { content: string; isError: true } {
  if (e instanceof TaskError) {
    return { content: `task_${op} failed: ${e.message}`, isError: true }
  }
  const msg = e instanceof Error ? e.message : String(e)
  return { content: `task_${op} failed: ${msg}`, isError: true }
}