/**
 * Skills loader.
 *
 * A Skill is `skills/<name>/SKILL.md` with YAML front-matter:
 *
 *   ---
 *   name: code-review
 *   description: One-line description the model sees in the system prompt.
 *   when_to_use: Optional longer trigger hint (e.g. "user asks 'review' or 'audit'").
 *   ---
 *
 *   # Skill body (markdown, free-form instructions)
 *
 * Loading flow (matches learn-claude-code s05 / Claude Code Skills):
 *
 *   1. At session start, scan `skills/` once and build an in-memory index.
 *   2. Surface only name + description + whenToUse in the system prompt
 *      (token-cheap).
 *   3. The model calls the `skill` tool by name when it needs the full body.
 *      The body is delivered as a `tool_result` so it appears in the
 *      conversation context for the rest of the session.
 *
 * `rootDir` defaults to `<cwd>/skills`. Tests pass a temp dir.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface SkillFrontmatter {
  name: string
  description: string
  whenToUse?: string
}

export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  /** Absolute path to SKILL.md. */
  path: string
  /** Directory containing SKILL.md. */
  dir: string
  /** Full body (front-matter stripped). Loaded lazily via loadSkillBody. */
  body?: string
}

export interface SkillIndex {
  entries: SkillEntry[]
  /** Quick lookup by name. */
  byName: Map<string, SkillEntry>
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Parse YAML front-matter into a typed shape. Minimal subset only. */
function parseFrontmatter(raw: string): { meta: SkillFrontmatter; body: string } | null {
  const m = raw.match(FRONTMATTER_RE)
  if (!m) return null
  const yaml = m[1] ?? ''
  const body = (m[2] ?? '').trim()
  const meta: Record<string, string> = {}
  for (const line of yaml.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const key = line.slice(0, colon).trim()
    let val = line.slice(colon + 1).trim()
    // Strip surrounding quotes.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    meta[key] = val
  }
  if (!meta.name || !meta.description) return null
  return {
    meta: {
      name: meta.name,
      description: meta.description,
      whenToUse: meta.when_to_use,
    },
    body,
  }
}

/**
 * Scan `rootDir/skills` for SKILL.md files. Returns a stable, sorted index.
 * Missing rootDir is not an error — returns an empty index.
 */
export function loadSkillsIndex(rootDir: string = process.cwd()): SkillIndex {
  const skillsRoot = resolve(rootDir, 'skills')
  const entries: SkillEntry[] = []
  if (!existsSync(skillsRoot)) return { entries, byName: new Map() }

  let names: string[]
  try {
    names = readdirSync(skillsRoot)
  } catch {
    return { entries, byName: new Map() }
  }

  for (const name of names) {
    const dir = join(skillsRoot, name)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue

    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    let raw: string
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const parsed = parseFrontmatter(raw)
    if (!parsed) {
      // Bad frontmatter — surface the entry with a synthetic name so the
      // model can still see it, but mark it as broken.
      entries.push({
        name,
        description: `[skill load error: missing/invalid frontmatter in ${file}]`,
        path: file,
        dir,
      })
      continue
    }
    entries.push({
      name: parsed.meta.name,
      description: parsed.meta.description,
      whenToUse: parsed.meta.whenToUse,
      path: file,
      dir,
      body: parsed.body,
    })
  }

  entries.sort((a, b) => a.name.localeCompare(b.name))
  const byName = new Map(entries.map((e) => [e.name, e]))
  return { entries, byName }
}

/**
 * Load (or retrieve) the full SKILL.md body for `name`. Returns null if no
 * such skill. The body is cached on the SkillEntry on first load.
 */
export function loadSkillBody(index: SkillIndex, name: string): string | null {
  const e = index.byName.get(name)
  if (!e) return null
  if (e.body !== undefined) return e.body
  try {
    e.body = readFileSync(e.path, 'utf8').replace(FRONTMATTER_RE, (_, _yaml, body) =>
      (body ?? '').trim(),
    )
  } catch {
    return null
  }
  return e.body
}

/**
 * Format the skill index for injection into the system prompt.
 *
 * Designed to be token-efficient: a single short line per skill plus the
 * `when_to_use` hint. The full body stays out until the model loads it via
 * the `skill` tool.
 */
export function formatSkillsIndex(index: SkillIndex): string {
  if (index.entries.length === 0) return ''
  const lines = index.entries.map((e) => {
    const trigger = e.whenToUse ? ` — ${e.whenToUse}` : ''
    return `- \`${e.name}\`: ${e.description}${trigger}`
  })
  return [
    '<SKILLS>',
    'The following skills are available. Use the `skill` tool with the skill',
    'name to load the full instructions when relevant.',
    '',
    ...lines,
    '</SKILLS>',
  ].join('\n')
}
