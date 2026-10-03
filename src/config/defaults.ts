/**
 * Default YuanCode configuration. Used when no user / project / env config
 * is present. The values here are deliberately friendly: a fresh clone can
 * talk to the default MiniMax provider without writing any config.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { YuanConfig } from './schema.js'

export const DEFAULT_CONFIG: YuanConfig = {
  model: {
    provider: 'minimax',
    model: 'MiniMax-M3',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    maxTokens: 8192,
    cacheControl: true,
    temperature: 1.0,
  },
  permissionMode: 'acceptEdits',
  limits: {
    maxSteps: 50,
    totalTimeoutMs: 1_800_000,
    perStepTimeoutMs: 60_000,
    maxCostUsd: 5.0,
    parallelTools: 8,
  },
  sandbox: {
    mode: 'local',
    image: 'yuancode/sandbox:latest',
    extraWritable: [],
    network: 'none',
    memory: '512m',
    cpus: 1,
  },
  logLevel: 'info',
}

/** Where YuanCode looks for user-level / project-level config files. */
export const CONFIG_PATHS = {
  user: ['~/.yuancode/config.yaml', '~/.yuancode/config.yml'],
  project: ['<cwd>/.yuancode/config.yaml', '<cwd>/.yuancode/config.yml'],
} as const

/**
 * Where YuanCode looks for user-level / project-level hooks.yaml files
 * (M6). We deliberately use plain path.join helpers instead of the
 * CONFIG_PATHS string-array above because the array form leaves a `<cwd>`
 * placeholder that needs runtime expansion — easier to compute on the fly.
 */
export function hooksPaths(cwd: string): { userPath: string; projectPath: string } {
  return {
    userPath: join(homedir(), '.yuancode', 'hooks.yaml'),
    projectPath: join(cwd, '.yuancode', 'hooks.yaml'),
  }
}

/**
 * Where YuanCode looks for user-level / project-level mcp.json files (M6).
 * Same rationale as `hooksPaths` — explicit path construction avoids the
 * `<cwd>` placeholder bug from CONFIG_PATHS.
 */
export function mcpPaths(cwd: string): { userPath: string; projectPath: string } {
  return {
    userPath: join(homedir(), '.yuancode', 'mcp.json'),
    projectPath: join(cwd, '.yuancode', 'mcp.json'),
  }
}
