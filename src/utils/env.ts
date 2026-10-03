/**
 * Lightweight .env loader. Reads one or more `.env` files and sets
 * process.env entries for any KEY=VALUE lines that aren't already set.
 *
 * Intentionally simple — no `dotenv` dependency. Skips blank lines and
 * comments (`#`). Supports `${VAR}` references at load time.
 *
 * Path resolution (first existing wins):
 *   1. `opts.path`     — explicit override (single string, kept for back-compat)
 *   2. `opts.paths`    — explicit list (preferred for new callers)
 *   3. `<cwd>/.env`    — project-local .env (default)
 *   4. `$YUANCODE_HOME/.env` — YuanCode install / repo root, set by
 *      `bin/yuancode.mjs`. Lets users drop credentials once in the
 *      YuanCode folder and use them anywhere (`yuancode` from another
 *      cwd picks them up automatically).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface LoadEnvOptions {
  /** Single explicit path (back-compat). Mutually exclusive with `paths`. */
  path?: string
  /** Multiple explicit paths — first existing wins, all are read in order. */
  paths?: string[]
  /** When true, existing process.env values are NOT overwritten. */
  preserveExisting?: boolean
}

export function loadEnv(opts: LoadEnvOptions = {}): { loaded: number; path: string | null } {
  const candidates: string[] = opts.paths
    ? [...opts.paths]
    : opts.path
      ? [opts.path]
      : [
          join(process.cwd(), '.env'),
          ...(process.env.YUANCODE_HOME ? [join(process.env.YUANCODE_HOME, '.env')] : []),
        ]

  let totalLoaded = 0
  let usedPath: string | null = null

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue
    const text = readFileSync(envPath, 'utf8')
    let loaded = 0
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      // Strip surrounding quotes.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      // Expand ${VAR} references.
      value = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
        return process.env[name] ?? ''
      })
      if (opts.preserveExisting && process.env[key] !== undefined) continue
      if (process.env[key] === undefined) {
        process.env[key] = value
        loaded++
      }
    }
    totalLoaded += loaded
    if (usedPath == null) usedPath = envPath
  }

  return { loaded: totalLoaded, path: usedPath }
}
