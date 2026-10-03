/**
 * Hooks config loader — read `~/.yuancode/hooks.yaml` and
 * `<project>/.yuancode/hooks.yaml` and merge.
 *
 * Merge semantics (matching the design's "user + project, per-event
 * arrays concatenate"):
 *   - User file missing → empty user config.
 *   - Project file missing → empty project config.
 *   - Both present → per-event arrays concat (project first, user second).
 *   - On identical top-level keys, project wins per-entry collision is
 *     impossible because we concat arrays; we warn if the same matcher
 *     appears in both files for the same event.
 *   - Invalid YAML / schema / matcher regex → entry dropped, warning logged.
 *   - File errors (unreadable, parse error) → that file skipped with warning.
 *
 * Never throws. Bad config is downgraded to warnings so a broken hooks.yaml
 * can't block agent startup.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { compileMatcher } from './matcher.js'
import type { BashHookEntry, HookEntry, HookEvent, HooksConfig, HttpHookEntry } from './types.js'

const BashSchema = z.object({
  type: z.literal('bash'),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().optional(),
})

const HttpSchema = z.object({
  type: z.literal('http'),
  matcher: z.string().optional(),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
})

const HookEntrySchema = z.discriminatedUnion('type', [BashSchema, HttpSchema])

const HooksFileSchema = z.object({
  hooks: z
    .record(z.array(HookEntrySchema))
    .optional(),
})

export interface LoadedHooks {
  config: HooksConfig
  sources: string[]
  warnings: string[]
}

export interface LoadHooksOptions {
  userPath: string
  projectPath: string
}

function readOne(path: string, warnings: string[]): HooksConfig {
  if (!existsSync(path)) return { hooks: {} }
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    warnings.push(`hooks: cannot read ${path}: ${(e as Error).message}`)
    return { hooks: {} }
  }
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (e) {
    warnings.push(`hooks: invalid YAML in ${path}: ${(e as Error).message}`)
    return { hooks: {} }
  }
  const result = HooksFileSchema.safeParse(parsed)
  if (!result.success) {
    warnings.push(`hooks: schema error in ${path}: ${result.error.message}`)
    return { hooks: {} }
  }
  const cfg: HooksConfig = { hooks: {} }
  for (const [event, entries] of Object.entries(result.data.hooks ?? {})) {
    const validated: HookEntry[] = []
    for (const e of entries ?? []) {
      // Compile matchers up-front so invalid regexes fail at load time.
      try {
        if (e.matcher !== undefined) compileMatcher(e.matcher)
      } catch (err) {
        warnings.push(`hooks: ${path}: ${event}: bad matcher "${e.matcher}": ${(err as Error).message}`)
        continue
      }
      validated.push(e as HookEntry)
    }
    cfg.hooks[event as HookEvent] = validated
  }
  return cfg
}

export function loadHooksConfig(opts: LoadHooksOptions): LoadedHooks {
  const warnings: string[] = []
  const sources: string[] = []
  const user = readOne(opts.userPath, warnings)
  if (existsSync(opts.userPath)) sources.push(opts.userPath)
  const project = readOne(opts.projectPath, warnings)
  if (existsSync(opts.projectPath)) sources.push(opts.projectPath)

  const merged: HooksConfig = { hooks: {} }
  const events = new Set<HookEvent>([
    ...Object.keys(user.hooks).map((k) => k as HookEvent),
    ...Object.keys(project.hooks).map((k) => k as HookEvent),
  ])
  for (const event of events) {
    const projectEntries = project.hooks[event] ?? []
    const userEntries = user.hooks[event] ?? []
    merged.hooks[event] = [...projectEntries, ...userEntries]
    if (projectEntries.length > 0 && userEntries.length > 0) {
      warnings.push(
        `hooks: ${event} entries exist in both user and project; both will fire`,
      )
    }
  }

  return { config: merged, sources, warnings }
}

// Re-export for tests / downstream use.
export type { BashHookEntry, HookEntry, HooksConfig, HttpHookEntry }
