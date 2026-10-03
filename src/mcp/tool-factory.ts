/**
 * MCP tool factory — bridges an `McpToolSpec` into a `ToolEntry` that
 * `ToolRegistry` can register.
 *
 * The MCP server hands us each tool's input as a JSON Schema object
 * (per the SDK's `listTools()` contract). The harness speaks Zod for
 * runtime validation, so we convert JSON Schema → Zod via a tiny
 * `jsonSchemaToZod` helper. We intentionally stay narrow: only the
 * shapes MCP servers commonly emit are handled precisely, and anything
 * we can't interpret falls back to `z.record(z.unknown())` (accept-anything)
 * so the server can do the validation itself. Throwing on an unknown
 * schema would lock users out of perfectly good tools.
 */
import { z, type ZodTypeAny } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import type { ToolContext, ToolEntry, ToolResult } from '../core/tool-registry.js'
import type { McpManager } from './manager.js'
import type { McpToolSpec } from './types.js'

// --------------------------------------------------------------------------
// JSON Schema → Zod (subset)
// --------------------------------------------------------------------------

/**
 * Convert a JSON Schema object into a Zod schema. Only the subset we see
 * in practice on MCP `tools/list` responses is handled with precision:
 *   - `string` (incl. enum)
 *   - `number` / `integer`
 *   - `boolean`
 *   - `array`
 *   - `object` (recursively)
 *
 * Anything else (e.g. oneOf/anyOf, $ref, format, nullable, …) falls back
 * to `z.unknown()`. The receiving MCP server is the source of truth for
 * input validation anyway.
 */
export function jsonSchemaToZod(schema: unknown, visited: WeakSet<object> = new WeakSet()): ZodTypeAny {
  if (!schema || typeof schema !== 'object') return z.unknown()
  const s = schema as Record<string, unknown>

  // Recursion guard — JSON Schema can legitimately include self-references
  // via $ref or nested definitions; collapse to unknown on the second visit.
  if (visited.has(s)) return z.unknown()
  visited.add(s)

  const type = s.type as string | undefined
  const description = typeof s.description === 'string' ? s.description : undefined
  let out: ZodTypeAny

  switch (type) {
    case 'string': {
      if (Array.isArray(s.enum)) {
        const values = s.enum.filter((v): v is string => typeof v === 'string')
        if (values.length > 0) {
          // z.enum requires a non-empty tuple; cast through unknown to satisfy TS
          out = z.enum(values as [string, ...string[]])
          break
        }
      }
      out = z.string()
      break
    }
    case 'number':
    case 'integer':
      out = z.number()
      break
    case 'boolean':
      out = z.boolean()
      break
    case 'array': {
      const items = s.items as Record<string, unknown> | undefined
      const itemSchema = items ? jsonSchemaToZod(items, visited) : z.unknown()
      out = z.array(itemSchema)
      break
    }
    case 'object': {
      const props = (s.properties ?? {}) as Record<string, unknown>
      const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : [])
      const shape: Record<string, ZodTypeAny> = {}
      for (const [key, child] of Object.entries(props)) {
        const childSchema = jsonSchemaToZod(child, visited)
        shape[key] = required.has(key) ? childSchema : childSchema.optional()
      }
      // z.object requires at least one shape entry in practice; fall back
      // to z.record(z.unknown()) for empty objects so the harness never
      // explodes on a schema like `{ type: 'object' }` with no props.
      out = Object.keys(shape).length > 0 ? z.object(shape) : z.record(z.unknown())
      break
    }
    case 'null':
      out = z.null()
      break
    default:
      // Includes 'undefined' (no `type` set) — accept anything.
      out = z.unknown()
  }

  return description ? out.describe(description) : out
}

// --------------------------------------------------------------------------
// Factory
// --------------------------------------------------------------------------

export interface MakeMcpToolOptions {
  /** The spec returned by the server's `tools/list`. */
  spec: McpToolSpec
  /** The manager that owns the underlying connection. */
  manager: McpManager
  /** Logger for tool-level events (e.g. crash detection during call). */
  logger: PinoLogger
}

export interface McpToolMeta {
  /** Full registered name: `mcp__<server>__<tool>`. */
  fullName: string
  /** The MCP server's normalized name (without the `mcp__` prefix). */
  serverName: string
  /** The original tool name (without server prefix). */
  toolName: string
}

/**
 * Build a `ToolEntry` for a single MCP tool. The returned handler:
 *
 *   - Looks up the connection by `spec.serverName`
 *   - If missing or crashed → returns `isError: true` with a helpful message
 *   - Otherwise forwards to `connection.callTool` and converts the result
 *     into a `ToolResult.content` string the model can read
 *
 * The factory is pure (no shared mutable state beyond the manager), so it
 * can be called per-tool during boot to register every advertised tool.
 */
export function makeMcpTool(opts: MakeMcpToolOptions): ToolEntry {
  const { spec, manager, logger } = opts
  const fullName = `mcp__${spec.serverName}__${spec.name}`
  const zodSchema = jsonSchemaToZod(spec.inputSchema)

  const handler = async (
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const conn = manager.getConnection(spec.serverName)
    if (!conn) {
      return {
        content: `mcp server "${spec.serverName}" is not registered with the manager`,
        isError: true,
        metadata: { fullName, serverName: spec.serverName },
      }
    }
    if (!conn.isConnected() || conn.isCrashed()) {
      return {
        content: `mcp server "${spec.serverName}" is unavailable (crashed or not connected); restart the session to reconnect`,
        isError: true,
        metadata: { fullName, serverName: spec.serverName, crashed: true },
      }
    }

    // Forward the already-validated input to the SDK. Abort propagation
    // is handled by McpServerConnection internally via TwoLevelAbort.
    void ctx // (kept for future per-call hooks; currently unused)
    const result = await conn.callTool(spec.name, input)
    const content = formatMcpResult(result.content, fullName)
    return {
      content,
      isError: result.isError,
      metadata: { fullName, serverName: spec.serverName, toolName: spec.name },
    }
  }

  return {
    name: fullName,
    description:
      spec.description ??
      `MCP tool "${spec.name}" from server "${spec.originalServerName}"`,
    schema: zodSchema,
    handler,
    // MCP servers are user-authorized (added to mcp.json by the user),
    // so we treat them as low risk by default. PermissionGate has an
    // explicit 'mcp' category branch that may deny on `plan` mode.
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 30_000,
    category: 'mcp',
  }
}

/**
 * Convert the SDK's `content` array (a list of typed content blocks) into
 * a single string the model sees as `tool_result.content`. We render each
 * block with a small label so the model can tell text from images/audio.
 */
function formatMcpResult(content: unknown, fullName: string): string {
  if (!Array.isArray(content)) {
    return `[${fullName}] (non-array content)\n${truncate(stringify(content), 8000)}`
  }
  if (content.length === 0) return `[${fullName}] (empty result)`
  const lines: string[] = [`[${fullName}]`]
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      lines.push(`- ${truncate(String(block), 8000)}`)
      continue
    }
    const b = block as { type?: string; text?: string; data?: string; mimeType?: string }
    switch (b.type) {
      case 'text':
        lines.push(typeof b.text === 'string' ? b.text : '')
        break
      case 'image':
        lines.push(`(image, ${b.mimeType ?? 'unknown'}, ${b.data?.length ?? 0} chars base64)`)
        break
      case 'audio':
        lines.push(`(audio, ${b.mimeType ?? 'unknown'}, ${b.data?.length ?? 0} chars base64)`)
        break
      case 'resource': {
        const r = (b as { resource?: { text?: string; blob?: string; uri?: string } }).resource
        if (r?.text) lines.push(`(resource ${r.uri ?? ''})\n${r.text}`)
        else if (r?.blob) lines.push(`(resource ${r.uri ?? ''}, ${r.blob.length} chars blob)`)
        else lines.push(`(resource ${r?.uri ?? 'unknown'})`)
        break
      }
      case 'resource_link': {
        const r = b as { uri?: string; name?: string; description?: string }
        lines.push(`(resource_link ${r.uri ?? ''} "${r.name ?? ''}" ${r.description ?? ''})`)
        break
      }
      default:
        lines.push(`- (${b.type ?? 'unknown'}) ${truncate(stringify(block), 8000)}`)
    }
  }
  return lines.join('\n')
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…(${s.length - n} more chars)`
}
