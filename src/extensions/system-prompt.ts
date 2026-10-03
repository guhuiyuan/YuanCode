/**
 * System prompt builder — assembles the per-session prompt.
 *
 * Order:
 *   1. Base identity (kept tiny on purpose — the harness, not the model,
 *      defines what tools it has)
 *   2. Yuan.md (3 layers, user → project → local)
 *   3. Skills index (token-cheap: name + description only; bodies on demand)
 *
 * Empty layers are dropped. When NOTHING is configured (zero Yuan.md layers,
 * zero skills), the system prompt is just the base identity — minimal
 * overhead.
 */
import type { YuanMd } from './yuan-md.js'
import type { SkillIndex } from './skills.js'
import { formatSkillsIndex } from './skills.js'

const BASE_IDENTITY = `You are YuanCode, an AI coding assistant that operates via a terminal CLI.
You help the user build software by reading files, editing code, running
commands, and fetching documentation. Be concise, concrete, and verify your
work.

Always prefer the smallest change that solves the problem. When uncertain,
ask the user one focused question rather than guessing.`

export interface SystemPromptParts {
  yuan: YuanMd
  skills: SkillIndex
}

export function buildSystemPrompt(parts: SystemPromptParts): string {
  const chunks: string[] = [BASE_IDENTITY]

  if (parts.yuan.combined) {
    chunks.push('<YUAN>\n' + parts.yuan.combined + '\n</YUAN>')
  }

  const skillsBlock = formatSkillsIndex(parts.skills)
  if (skillsBlock) {
    chunks.push(skillsBlock)
  }

  return chunks.join('\n\n')
}
