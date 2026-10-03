/**
 * Yuan.md loader — three-layer merge for project instructions.
 *
 * Mirrors Claude Code's `settingSources`:
 *
 *   1. USER      — `~/.yuancode/YUAN.md`       (always-injected global prefs)
 *   2. PROJECT   — `<cwd>/Yuan.md`             (always-injected project rules)
 *   3. LOCAL     — `<cwd>/.yuancode/YUAN.local.md` (always-injected per-machine override)
 *
 * Layers 1 and 2 exist by convention; layer 3 lives in `.gitignore`. Each
 * layer is OPTIONAL — missing files are silently skipped. All three layers,
 * when present, are concatenated in order (user → project → local), each
 * wrapped in an `<YUAN_SCOPE name=…>` tag so the model can tell them apart.
 *
 * The combined output is intended to be the first chunk of the system prompt.
 * Build it once per session — the contents are static for the session's life.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface YuanLayer {
  scope: 'user' | 'project' | 'local'
  /** Absolute path the layer was loaded from. */
  path: string
  /** Raw markdown body (without the front-matter wrapper). */
  content: string
}

export interface YuanMd {
  user: YuanLayer | null
  project: YuanLayer | null
  local: YuanLayer | null
  /** All layers concatenated with `<YUAN_SCOPE>` wrappers, in user → local order. */
  combined: string
}

const USER_FILE = '~/.yuancode/YUAN.md'
const PROJECT_FILE = 'Yuan.md'
const LOCAL_FILE = '.yuancode/YUAN.local.md'

function expandHome(p: string): string {
  if (!p.startsWith('~')) return p
  return join(homedir(), p.slice(1).replace(/^[\\/]/, ''))
}

function readLayer(scope: YuanLayer['scope'], abs: string): YuanLayer | null {
  if (!existsSync(abs)) return null
  try {
    const content = readFileSync(abs, 'utf8')
    if (content.trim().length === 0) return null
    return { scope, path: abs, content: content.replace(/\r\n/g, '\n') }
  } catch {
    return null
  }
}

/**
 * Load the three Yuan.md layers relative to `cwd`.
 *
 * Resolution order (first-existing wins per layer):
 *   user    → ~/.yuancode/YUAN.md
 *   project → <cwd>/Yuan.md
 *   local   → <cwd>/.yuancode/YUAN.local.md
 */
export function loadYuanMd(cwd: string = process.cwd()): YuanMd {
  const root = isAbsolute(cwd) ? cwd : resolve(cwd)

  const user = readLayer('user', expandHome(USER_FILE))
  const project = readLayer('project', join(root, PROJECT_FILE))
  const local = readLayer('local', join(root, LOCAL_FILE))

  const combined = [user, project, local]
    .filter((l): l is YuanLayer => l !== null)
    .map(formatLayer)
    .join('\n\n')

  return { user, project, local, combined }
}

function formatLayer(layer: NonNullable<YuanLayer>): string {
  const header = `<YUAN_SCOPE name="${layer.scope}" source="${escapeAttr(layer.path)}">`
  const footer = `</YUAN_SCOPE>`
  return `${header}\n${layer.content.trim()}\n${footer}`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Convenience: when `yuan` is empty (no Yuan.md found anywhere), return an
 * empty string. Otherwise return the combined text. Used by the system-prompt
 * builder to decide whether to include the `<YUAN>` block at all.
 */
export function yuanMdOrEmpty(yuan: YuanMd): string {
  return yuan.combined
}
