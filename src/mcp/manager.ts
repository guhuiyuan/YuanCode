/**
 * MCP Manager — collection of `McpServerConnection`s.
 *
 * Responsibilities:
 *
 *   1. Boot all configured servers in parallel (`start`).
 *      Each connection is independent: a failure on one does NOT block the
 *      others, but the failure is recorded in `warnings`. Surviving
 *      connections become visible to the agent via `listAllTools`.
 *
 *   2. Dispose all connections (`dispose`) — idempotent, parallel, with
 *      best-effort error tolerance.
 *
 *   3. Surface crash state — `isCrashed(name)` and `crashedNames()`. M6 does
 *      not auto-reconnect; the tool factory returns a graceful error when a
 *      server is in this state.
 *
 *   4. Aggregate tools across all live servers (`listAllTools`) for the tool
 *      factory to register against `ToolRegistry`.
 *
 * Name handling:
 *   - The `McpServerConnection` already stores both `originalName` (the
 *     key in `mcp.json`) and `normalizedName` (`[a-z0-9_]+`).
 *   - This manager keys its map by `normalizedName`. If two original names
 *     collide after normalization, the second gets a numeric suffix
 *     (`<norm>_2`, `<norm>_3`, …) and a warning is recorded. The
 *     `connection` field still exposes the original for logs.
 */
import type { Logger as PinoLogger } from 'pino'
import {
  McpServerConnection,
  type McpConnectionDeps,
} from './client.js'
import {
  normalizeServerName,
  type McpServerConfig,
  type McpToolSpec,
} from './types.js'

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

export interface McpManagerOptions {
  /** Logger passed through to each connection. */
  logger: PinoLogger
  /** Hard-abort signal — propagated to every connection. */
  hardSignal: AbortSignal
  /** Optional global crash hook fired AFTER the per-connection one. */
  onCrash?: (serverName: string, error: Error) => void
  /** M7 — optional trace logger. When set, every connection wraps its
   *  `callTool` in a `mcp.callTool` span. */
  trace?: import('../core/trace-logger.js').TraceLogger
}

export interface McpStartReport {
  /**
   * Human-readable warnings collected during `start`. Includes connection
   * failures (per-server) and normalized-name collisions (per-name).
   */
  warnings: string[]
}

// --------------------------------------------------------------------------
// Manager
// --------------------------------------------------------------------------

export class McpManager {
  private readonly connections = new Map<string, McpServerConnection>()
  /** Pre-allocated warnings list so `start` can be awaited multiple times safely. */
  private startWarnings: string[] = []
  private started = false

  /**
   * Spawn and connect every server in `servers` in parallel. Each server's
   * connect() is awaited independently; failures land in `warnings` and
   * the entry is dropped from the active set.
   *
   * Calling `start` twice is a no-op for already-running servers; new keys
   * are added and their failures appended to warnings.
   */
  async start(
    servers: Record<string, McpServerConfig>,
    opts: McpManagerOptions,
  ): Promise<McpStartReport> {
    const deps: McpConnectionDeps = {
      hardSignal: opts.hardSignal,
      logger: opts.logger,
      onCrash: (serverName, err) => {
        opts.onCrash?.(serverName, err)
      },
      trace: opts.trace,
    }

    // Build plan: map normalized → original, skipping collisions.
    const planned = new Map<string, string>() // normalized → original
    for (const originalName of Object.keys(servers)) {
      const norm = normalizeServerName(originalName)
      if (planned.has(norm)) {
        this.startWarnings.push(
          `mcp: server name collision after normalization — "${originalName}" → "${norm}" already used by "${planned.get(norm)}"; skipping`,
        )
        continue
      }
      planned.set(norm, originalName)
    }

    // Build connections and connect in parallel.
    const tasks: Array<Promise<void>> = []
    for (const [normalizedName, originalName] of planned) {
      // Defensive: the config-loader has already deduped by original name,
      // so a collision here means the same key was added twice — skip.
      if (this.connections.has(normalizedName)) continue

      const config = servers[originalName]!
      const conn = new McpServerConnection(originalName, config, deps)
      this.connections.set(normalizedName, conn)
      tasks.push(
        conn.connect().catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err))
          this.startWarnings.push(
            `mcp: failed to connect server "${originalName}" (${normalizedName}): ${e.message}`,
          )
          this.connections.delete(normalizedName)
          opts.logger.warn(
            { server: originalName, normalized: normalizedName, err: e.message },
            'mcp: connection failed',
          )
        }),
      )
    }

    await Promise.allSettled(tasks)
    this.started = true
    return { warnings: [...this.startWarnings] }
  }

  /**
   * Aggregate tools from every live (non-crashed) connection. Per-server
   * `listTools` failures are silently dropped (the connection is dropped
   * from the registry too) — the assumption is that the manager's
   * `start()` already reported connectivity failures.
   */
  async listAllTools(): Promise<McpToolSpec[]> {
    const tasks: Array<Promise<McpToolSpec[]>> = []
    for (const conn of this.connections.values()) {
      if (!conn.isConnected()) continue
      tasks.push(
        conn.listTools().catch(() => {
          // The connection already crashed / dropped; surface only via isCrashed
          return []
        }),
      )
    }
    const results = await Promise.allSettled(tasks)
    return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  }

  /** Close every connection. Idempotent. Best-effort. */
  async dispose(): Promise<void> {
    const tasks: Array<Promise<void>> = []
    for (const conn of this.connections.values()) {
      tasks.push(conn.dispose().catch(() => undefined))
    }
    await Promise.allSettled(tasks)
    this.connections.clear()
    this.started = false
  }

  /** Number of currently-tracked connections (live + crashed). */
  size(): number {
    return this.connections.size
  }

  /** Number of healthy connections. */
  liveCount(): number {
    let n = 0
    for (const c of this.connections.values()) if (c.isConnected()) n++
    return n
  }

  /** Lookup by **normalized** name (the key in `mcp__<name>__<tool>`). */
  getConnection(name: string): McpServerConnection | undefined {
    return this.connections.get(name)
  }

  /** All normalized names tracked (live + crashed). */
  serverNames(): string[] {
    return [...this.connections.keys()]
  }

  /** Normalized names of crashed servers (need attention / reconnection). */
  crashedNames(): string[] {
    const out: string[] = []
    for (const [name, conn] of this.connections) {
      if (conn.isCrashed()) out.push(name)
    }
    return out
  }

  isCrashed(name: string): boolean {
    return this.connections.get(name)?.isCrashed() ?? false
  }

  /** Test/admin: returns true if `start` has been called at least once. */
  hasStarted(): boolean {
    return this.started
  }
}
