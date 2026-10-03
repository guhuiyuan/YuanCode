/**
 * MCP client — public types.
 *
 * Two transports are supported via `McpServerConfig`:
 *   - `stdio` — spawn a child process and speak newline-delimited JSON-RPC
 *     over stdin/stdout (no `url` field).
 *   - `http` (Streamable HTTP) — POST JSON-RPC to a URL (`url` field).
 *
 * The two are discriminated structurally: presence of `command` → stdio,
 * presence of `url` → http. We don't use a literal `type` field so users
 * can omit it (Claude Code does the same).
 */
import { z } from 'zod'

export const McpStdioServerSchema = z.object({
  /** Optional free-form note from the config file (ignored at runtime). */
  comment: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
})

export const McpRemoteServerSchema = z.object({
  comment: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
})

export const McpServerConfigSchema = z.union([
  McpStdioServerSchema,
  McpRemoteServerSchema,
])

export const McpServersFileSchema = z.object({
  mcpServers: z.record(z.string(), McpServerConfigSchema).default({}),
})

export type McpStdioServer = z.infer<typeof McpStdioServerSchema>
export type McpRemoteServer = z.infer<typeof McpRemoteServerSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** Normalize a server name to `[a-z0-9_]+` so it slots into the tool-name regex. */
export function normalizeServerName(name: string): string {
  const out = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return out || 'unnamed'
}

/**
 * Description of a single tool advertised by a connected MCP server.
 * `inputSchema` is a JSON Schema object as received from `tools/list`.
 */
export interface McpToolSpec {
  /** Original tool name from the server (e.g. "read_file"). */
  name: string
  description?: string
  /** JSON Schema for the tool's input. Server-validated at call time. */
  inputSchema: unknown
  /** Normalized server name (for the `mcp__<server>__<tool>` naming). */
  serverName: string
  /** Original server key from mcp.json (for logs). */
  originalServerName: string
}

/** Result of `tools/call`. Mirrors the MCP spec. */
export interface McpToolCallResult {
  /** Raw `content` array from the server. */
  content: unknown
  isError: boolean
}

/**
 * Construct the full registered tool name: `mcp__<server>__<tool>`.
 * Returns `null` if the tool name isn't safe (contains control chars).
 */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

export function parseMcpToolName(
  fullName: string,
): { serverName: string; toolName: string } | null {
  const m = /^mcp__([a-z][a-z0-9_]*)__(.+)$/.exec(fullName)
  if (!m) return null
  return { serverName: m[1]!, toolName: m[2]! }
}
