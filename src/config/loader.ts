/**
 * Three-layer config loader: defaults → user file → project file → env.
 *
 * The merge is shallow-by-section: each top-level key (model, limits, etc.)
 * is replaced wholesale rather than deep-merged. This matches user mental
 * model ("I'm overriding the model, not patching maxTokens") and keeps the
 * loader predictable.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_CONFIG, CONFIG_PATHS } from './defaults.js'
import { YuanConfigSchema, type YuanConfig } from './schema.js'
import { loadEnv } from '../utils/env.js'

function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return resolve(homedir(), p.slice(1).replace(/^[\\/]/, ''))
  }
  return p
}

function firstExisting(paths: readonly string[]): string | null {
  for (const p of paths) {
    const abs = isAbsolute(p) ? p : resolve(process.cwd(), p)
    if (existsSync(abs)) return abs
  }
  return null
}

function readYamlConfig(absPath: string): Partial<YuanConfig> {
  const text = readFileSync(absPath, 'utf8')
  const parsed = parseYaml(text)
  if (parsed == null || typeof parsed !== 'object') {
    return {}
  }
  // Partial-validate: pass through schema with .partial() so partial overrides
  // don't reject.
  const partial = YuanConfigSchema.deepPartial().parse(parsed)
  return partial as Partial<YuanConfig>
}

function applyEnvOverrides(config: YuanConfig): YuanConfig {
  // Direct env var mapping for the most common toggles.
  const env = process.env
  const next: YuanConfig = { ...config }

  if (env.YUANCODE_PROVIDER) {
    next.model = { ...next.model, provider: env.YUANCODE_PROVIDER as YuanConfig['model']['provider'] }
  }
  if (env.YUANCODE_MODEL) {
    next.model = { ...next.model, model: env.YUANCODE_MODEL }
  }
  if (env.YUANCODE_BASE_URL) {
    next.model = { ...next.model, baseUrl: env.YUANCODE_BASE_URL }
  }
  if (env.YUANCODE_API_KEY) {
    next.model = { ...next.model, apiKey: env.YUANCODE_API_KEY }
  }
  if (env.YUANCODE_PERMISSION_MODE) {
    next.permissionMode = env.YUANCODE_PERMISSION_MODE as YuanConfig['permissionMode']
  }
  if (env.YUANCODE_LOG_LEVEL) {
    next.logLevel = env.YUANCODE_LOG_LEVEL as YuanConfig['logLevel']
  }
  if (env.YUANCODE_SANDBOX) {
    next.sandbox = { ...next.sandbox, mode: env.YUANCODE_SANDBOX as YuanConfig['sandbox']['mode'] }
  }

  // Numeric env overrides.
  const n = (s: string | undefined): number | undefined => {
    if (!s) return undefined
    const v = Number(s)
    return Number.isFinite(v) ? v : undefined
  }
  const limits = { ...next.limits }
  const v = n(env.YUANCODE_MAX_STEPS);        if (v !== undefined) limits.maxSteps = v
  const v1 = n(env.YUANCODE_TOTAL_TIMEOUT_MS); if (v1 !== undefined) limits.totalTimeoutMs = v1
  const v2 = n(env.YUANCODE_PER_STEP_TIMEOUT_MS); if (v2 !== undefined) limits.perStepTimeoutMs = v2
  const v3 = n(env.YUANCODE_MAX_COST_USD);    if (v3 !== undefined) limits.maxCostUsd = v3
  const v4 = n(env.YUANCODE_MAX_PARALLEL_TOOLS); if (v4 !== undefined) limits.parallelTools = v4
  next.limits = limits

  return next
}

/**
 * Load the full merged config. Also loads `.env` so any `YUANCODE_*`
 * vars are visible regardless of whether they came from the shell.
 */
export function loadConfig(opts: { cwd?: string } = {}): YuanConfig {
  const cwd = opts.cwd ?? process.cwd()
  process.chdir?.(cwd) // no-op when same; ensures process.cwd() is correct

  // 1. .env
  loadEnv({ path: resolve(cwd, '.env'), preserveExisting: true })

  // 2. Defaults
  let merged: YuanConfig = structuredClone(DEFAULT_CONFIG)

  // 3. User file
  const userPaths = CONFIG_PATHS.user.map(expandHome)
  const userFile = firstExisting(userPaths)
  if (userFile) {
    const partial = readYamlConfig(userFile)
    merged = { ...merged, ...partial } as YuanConfig
  }

  // 4. Project file
  const projectPaths = CONFIG_PATHS.project.map((p) => resolve(cwd, p))
  const projectFile = firstExisting(projectPaths)
  if (projectFile) {
    const partial = readYamlConfig(projectFile)
    merged = { ...merged, ...partial } as YuanConfig
  }

  // 5. Env overrides (highest priority except explicit CLI flags)
  merged = applyEnvOverrides(merged)

  // 6. Final schema validation (catches accidental bad types in user YAML)
  return YuanConfigSchema.parse(merged)
}
