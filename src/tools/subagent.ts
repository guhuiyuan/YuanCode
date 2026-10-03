/**
 * subagent tool — delegate a task to a fresh-context child agent.
 *
 * The parent model calls this tool when it wants to offload a focused task
 * (e.g. "explore src/ for files containing TODO") to a subagent. The
 * subagent gets an empty message history + a specialized system prompt and
 * runs its own loop. The tool returns only the final summary text.
 *
 * Recursion: each `subagent` tool invocation reads `parentDeps.subagentDepth`
 * and bumps it before spawning. The cap is enforced inside `runSubagent`
 * (depth > 3 is refused).
 */
import { z } from 'zod'
import type { ToolEntry, ToolContext } from '../core/tool-registry.js'
import type { AgentLoopDeps } from '../core/loop.js'
import { runSubagent, type SubagentSpec, type SubagentType } from '../core/subagent.js'

export const SubagentInputSchema = z.object({
  type: z
    .enum(['general', 'explore', 'review'])
    .default('general')
    .describe(
      'Subagent flavor. "general" = any task; "explore" = read-only code map; ' +
        '"review" = focused code review.',
    ),
  prompt: z
    .string()
    .min(1)
    .max(20_000)
    .describe('The task to delegate. Be specific: include paths, constraints, and the deliverable shape.'),
})

export type SubagentInput = z.infer<typeof SubagentInputSchema>

export interface SubagentFactory {
  (parentDeps: AgentLoopDeps, spec: SubagentSpec): Promise<{ summary: string }>
}

export interface SubagentToolOptions {
  /** Factory that produces a subagent run; defaults to `runSubagent`. */
  factory?: SubagentFactory
}

/**
 * Make the `subagent` tool. The factory is injected so tests can substitute
 * a stub without going through the full loop.
 *
 * IMPORTANT: the tool's `handler` receives `ToolContext`, NOT the full
 * `AgentLoopDeps`. The runtime must pass deps in via a closure capture —
 * see `cli/run.ts` for how this is wired.
 */
export function makeSubagentTool(
  opts: SubagentToolOptions & { getParentDeps: () => AgentLoopDeps },
): ToolEntry<typeof SubagentInputSchema> {
  const factory = opts.factory ?? runSubagent
  return {
    name: 'subagent',
    description:
      'Delegate a task to a fresh-context child agent. The subagent has no ' +
      'memory of this conversation and returns only its final summary. Use ' +
      'this to offload focused work (exploration, review) so the parent ' +
      'context stays clean. Recursion is capped at depth 3.',
    schema: SubagentInputSchema,
    risk: 'medium',
    parallelSafe: false,
    timeoutMs: 600_000,
    category: 'agent',
    handler: async (input: SubagentInput, _ctx: ToolContext) => {
      const parentDeps = opts.getParentDeps()
      const depth = (parentDeps.subagentDepth ?? 0) + 1
      const spec: SubagentSpec = {
        type: input.type as SubagentType,
        prompt: input.prompt,
        depth,
      }
      const result = await factory(parentDeps, spec)
      return {
        content:
          `<subagent-result type="${spec.type}" depth="${depth}" subagentId="${(result as { subagentId?: string }).subagentId ?? ''}" steps="${(result as { steps?: number }).steps ?? 0}" stopReason="${(result as { stopReason?: string }).stopReason ?? ''}">\n` +
          `${result.summary}\n</subagent-result>`,
        metadata: { subagentId: (result as { subagentId?: string }).subagentId, depth },
      }
    },
  }
}