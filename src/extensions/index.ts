/**
 * Extensions layer barrel.
 */
export { loadYuanMd, yuanMdOrEmpty } from './yuan-md.js'
export type { YuanMd, YuanLayer } from './yuan-md.js'
export {
  loadSkillsIndex,
  loadSkillBody,
  formatSkillsIndex,
} from './skills.js'
export type {
  SkillEntry,
  SkillFrontmatter,
  SkillIndex,
} from './skills.js'
export { buildSystemPrompt } from './system-prompt.js'
export type { SystemPromptParts } from './system-prompt.js'
