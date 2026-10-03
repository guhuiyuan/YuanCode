/**
 * Skill tool — load a SKILL.md body on demand.
 *
 * The system prompt advertises available skills by name + 1-line description.
 * When the model decides a skill is relevant, it calls this tool with the
 * skill name; we return the full SKILL.md body as a `tool_result`. From that
 * point on the body stays in the conversation context for the session.
 *
 * Why on-demand:
 *   - Skills can be long (the code-review one is ~60 lines). Stuffing all
 *     of them into every system prompt wastes tokens.
 *   - Most sessions use 1–2 skills max. Loading them lazily matches the
 *     learn-claude-code s05 / Claude Code Skills approach.
 *
 * The tool is `parallelSafe=false` because two simultaneous loads would just
 * produce two competing results that the model has to merge — not worth it.
 */
import { z } from 'zod'
import type { ToolEntry } from '../core/tool-registry.js'
import type { SkillIndex } from '../extensions/skills.js'
import { loadSkillBody } from '../extensions/skills.js'

export const SkillInputSchema = z.object({
  name: z.string().min(1).describe(
    'Skill name as advertised in the system prompt (e.g. "code-review").',
  ),
})

export type SkillInput = z.infer<typeof SkillInputSchema>

export interface SkillToolOptions {
  index: SkillIndex
}

export function makeSkillTool(opts: SkillToolOptions): ToolEntry<typeof SkillInputSchema> {
  return {
    name: 'skill',
    description:
      'Load the full instructions for a skill by name. The skill index is ' +
      'advertised in the system prompt under <SKILLS>…</SKILLS>; call this ' +
      'tool with the skill name to receive its body as a tool_result.',
    schema: SkillInputSchema,
    risk: 'low',
    parallelSafe: false,
    timeoutMs: 1000,
    category: 'knowledge',
    handler: async (input) => {
      const entry = opts.index.byName.get(input.name)
      if (!entry) {
        const available = opts.index.entries.map((e) => e.name).join(', ')
        return {
          content:
            `Unknown skill "${input.name}". Available: ${available || '(none)'}`,
          isError: true,
        }
      }
      const body = loadSkillBody(opts.index, input.name)
      if (body === null) {
        return {
          content: `Failed to read skill body at ${entry.path}`,
          isError: true,
        }
      }
      return {
        content:
          `<skill name="${entry.name}" path="${entry.path}">\n` +
          body +
          `\n</skill>`,
        metadata: { name: entry.name, path: entry.path, bytes: body.length },
      }
    },
  }
}
