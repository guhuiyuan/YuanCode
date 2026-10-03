/**
 * todowrite tool — in-session TODO list.
 *
 * M2 implementation: in-memory only. The list lives for the duration of the
 * session (i.e. one process run) and is reset on restart. Persistent TODO
 * state lands in M4 alongside the SessionStore.
 *
 * Wire format (matches Claude Code):
 *   - Each item: { status: 'pending' | 'in_progress' | 'completed', content: string, activeForm: string }
 *   - All items provided in a single call REPLACE the previous list
 *     (this matches the model-mental-model of "show me the current plan").
 *
 * Display: the list is rendered into the tool_result as a markdown checklist,
 * and the in_progress item is also exposed via the TUI's system message so
 * the user can see progress at a glance.
 */
import { z } from 'zod'
import type { ToolEntry, ToolContext } from '../core/tool-registry.js'

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  status: TodoStatusSchema,
  content: z.string().min(1).max(500).describe('Imperative form, e.g. "Add tests for foo".'),
  activeForm: z.string().min(1).max(200).describe(
    'Present continuous form, e.g. "Adding tests for foo". ' +
      'Shown while the item is in_progress.',
  ),
})
export type TodoItem = z.infer<typeof TodoItemSchema>

export const TodowriteInputSchema = z.object({
  items: z.array(TodoItemSchema).min(1).max(50).describe(
    'The complete TODO list. Replaces any previous list — the model owns ' +
      'the canonical state.',
  ),
})

export type TodowriteInput = z.infer<typeof TodowriteInputSchema>

/**
 * Mutable in-memory TODO state, attached to the ToolContext as `_todos`.
 *
 * Convention: tool handlers that want session-level mutable state should
 * hang it off `ctx._todos` (a private symbol) rather than reach into a
 * module-global. This keeps the tool pure and testable.
 */
export const TODOS_KEY = Symbol.for('yuancode.todos')

export interface TodoStore {
  items: TodoItem[]
  set(items: TodoItem[]): void
  activeForm(): string | undefined
}

export function makeTodoStore(): TodoStore {
  const items: TodoItem[] = []
  return {
    items,
    set(next: TodoItem[]) {
      items.length = 0
      items.push(...next)
    },
    activeForm(): string | undefined {
      return items.find((i) => i.status === 'in_progress')?.activeForm
    },
  }
}

export function makeTodowriteTool(opts: { store: TodoStore }): ToolEntry<typeof TodowriteInputSchema> {
  return {
    name: 'todowrite',
    description:
      'Update the session TODO list. The complete list is provided on each ' +
      'call — old items are discarded. Use one in_progress item to surface ' +
      'what the agent is currently doing in the TUI.',
    schema: TodowriteInputSchema,
    risk: 'low',
    parallelSafe: false,
    timeoutMs: 1000,
    category: 'plan',
    handler: async (input: TodowriteInput, _ctx: ToolContext) => {
      // Validate cross-item rules. The Zod schema rejects empty arrays, but
      // we also re-check here so callers that invoke handler() directly
      // (tests, programmatic) get the same behavior.
      if (input.items.length === 0) {
        return {
          content: 'TODOs cannot be empty — pass at least one item.',
          isError: true,
        }
      }
      const inProgress = input.items.filter((i) => i.status === 'in_progress')
      if (inProgress.length > 1) {
        return {
          content: `At most one item can be in_progress at a time (got ${inProgress.length}).`,
          isError: true,
        }
      }
      opts.store.set(input.items)

      // Pretty-print as a markdown checklist for the model.
      const lines = input.items.map((i) => {
        const box = i.status === 'completed' ? '[x]' : i.status === 'in_progress' ? '[~]' : '[ ]'
        return `${box} ${i.content}`
      })
      const summary = `${input.items.filter((i) => i.status === 'completed').length}/${input.items.length} done`
      return {
        content: `<todowrite ${summary}>\n${lines.join('\n')}\n</todowrite>`,
        metadata: { count: input.items.length },
      }
    },
  }
}
