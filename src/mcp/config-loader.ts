/**
 * MCP config loader — read `<project>/.yuancode/mcp.json` and
 * `~/.yuancode/mcp.json`, merge, validate.
 *
 * Per-server merge: if a server key appears in both files, the project
 * entry wins (project layer is more specific). This matches the design's
 * "user + project, project wins on collision" rule.
 *
 * Bad entries (parse error / schema error) → warning, dropped.
 * Never throws.
 */
import { existsSync, readFileSync } from 'node:fs'
import { McpServersFileSchema, type McpServerConfig } from './types.js'

export interface LoadedMcpConfig {
  servers: Record<string, McpServerConfig>
  sources: string[]
  warnings: string[]
}

export interface LoadMcpOptions {
  userPath: string
  projectPath: string
}

function readOne(path: string, warnings: string[]): Record<string, McpServerConfig> {
  if (!existsSync(path)) return {}
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    warnings.push(`mcp: cannot read ${path}: ${(e as Error).message}`)
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    warnings.push(`mcp: invalid JSON in ${path}: ${(e as Error).message}`)
    return {}
  }
  const result = McpServersFileSchema.safeParse(parsed)
  if (!result.success) {
    warnings.push(`mcp: schema error in ${path}: ${result.error.message}`)
    return {}
  }
  return result.data.mcpServers
}

export function loadMcpServersConfig(opts: LoadMcpOptions): LoadedMcpConfig {
  const warnings: string[] = []
  const sources: string[] = []

  const user = readOne(opts.userPath, warnings)
  if (existsSync(opts.userPath)) sources.push(opts.userPath)
  const project = readOne(opts.projectPath, warnings)
  if (existsSync(opts.projectPath)) sources.push(opts.projectPath)

  // Project wins on collision; user supplies the rest.
  const merged: Record<string, McpServerConfig> = { ...user, ...project }

  return { servers: merged, sources, warnings }
}
