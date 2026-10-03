/**
 * MCP client — single-server connection.
 *
 * Wraps the official `@modelcontextprotocol/sdk` `Client` with our two
 * supported transports (Stdio + Streamable HTTP) behind a small
 * lifecycle:
 *
 *   new McpServerConnection(name, config, deps)
 *     ↓
 *   connect()              // spawns child / opens HTTP session, performs initialize
 *     ↓
 *   listTools()            // returns McpToolSpec[]
 *   callTool(name, args)   // forwards to the SDK; never throws — errors become { isError: true }
 *     ↓
 *   dispose()              // closes transport, idempotent
 *
 * Crash handling: we wire `transport.onclose` so a child exit / network drop
 * marks the connection `crashed`. M6 does not auto-reconnect (scope). The
 * downstream `McpManager` surfaces this via `isCrashed(name)` and the tool
 * factory returns a graceful error to the model instead of throwing.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Logger as PinoLogger } from 'pino'
import {
  normalizeServerName,
  type McpServerConfig,
  type McpToolCallResult,
  type McpToolSpec,
} from './types.js'

// --------------------------------------------------------------------------
// Public surface
// --------------------------------------------------------------------------

export interface McpConnectionDeps {
  /**
   * Hard-abort signal from the agent loop. Forwarded to `Client.connect`,
   * `listTools`, and `callTool` via `RequestOptions.signal`. When this fires,
   * the SDK will reject the in-flight call and the transport will close.
   */
  hardSignal: AbortSignal
  /** Structured logger — receives per-server warn/error events. */
  logger: PinoLogger
  /**
   * Optional crash hook. Fired when the underlying transport closes
   * unexpectedly (child exit, network drop). M6 does not auto-reconnect;
   * the manager surfaces the crash to the tool factory.
   */
  onCrash?: (serverName: string, error: Error) => void
  /**
   * M7 — optional trace logger. When set, each `callTool` is wrapped in a
   * `mcp.callTool` span. The connection itself owns a synthetic root
   * (each call is independent since MCP calls are stateless from the
   * server's perspective).
   */
  trace?: import('../core/trace-logger.js').TraceLogger
}

/** Stable error returned by `callTool` when the connection is gone. */
export class McpUnavailableError extends Error {
  constructor(serverName: string) {
    super(`mcp server "${serverName}" is not connected`)
    this.name = 'McpUnavailableError'
  }
}

export class McpServerConnection {
  /** Server name as written in mcp.json (preserved for logs). */
  readonly originalName: string
  /** `[a-z0-9_]+` form, used in `mcp__<name>__<tool>` tool names. */
  readonly normalizedName: string

  private readonly client: Client
  private readonly transport: StdioClientTransport | StreamableHTTPClientTransport
  private readonly deps: McpConnectionDeps

  private connected = false
  private crashed = false
  /** Set true once `dispose()` has been called. Guards late `onclose` callbacks. */
  private closing = false

  constructor(originalName: string, config: McpServerConfig, deps: McpConnectionDeps) {
    this.originalName = originalName
    this.normalizedName = normalizeServerName(originalName)
    this.deps = deps

    this.client = new Client(
      { name: 'yuancode', version: '0.1.0' },
      { capabilities: {} },
    )

    this.transport = buildTransport(config, this.normalizedName, deps.logger)

    // Crash detection: any unexpected transport close → mark crashed.
    this.transport.onclose = () => {
      if (this.closing) return
      this.crashed = true
      this.connected = false
      deps.logger.warn({ server: this.normalizedName }, 'mcp transport closed unexpectedly')
      deps.onCrash?.(this.normalizedName, new Error('transport closed unexpectedly'))
    }
    this.transport.onerror = (err) => {
      deps.logger.warn(
        { server: this.normalizedName, err: err.message },
        'mcp transport error',
      )
    }
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Spawn the transport (stdio child / HTTP session) and complete the MCP
   * `initialize` handshake. Idempotent: a second call returns immediately
   * if already connected.
   *
   * On failure: throws. The caller (`McpManager`) treats throws as a hard
   * failure for this server and drops it from the active set.
   */
  async connect(): Promise<void> {
    if (this.connected) return
    await this.client.connect(this.transport, { signal: this.deps.hardSignal })
    this.connected = true
    this.crashed = false
  }

  async listTools(): Promise<McpToolSpec[]> {
    this.assertConnected()
    const result = await this.client.listTools(undefined, {
      signal: this.deps.hardSignal,
    })
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      serverName: this.normalizedName,
      originalServerName: this.originalName,
    }))
  }

  /**
   * Call a tool on the connected server. Never throws — call errors become
   * `{ isError: true, content: <message> }` so the harness can surface them
   * to the model via a normal `tool_result`.
   */
  async callTool(name: string, args: unknown): Promise<McpToolCallResult> {
    const span = this.deps.trace
      ? this.deps.trace.startRoot('mcp.callTool', {
          server: this.normalizedName,
          tool: name,
        })
      : null
    if (!this.connected || this.crashed) {
      if (span && this.deps.trace) {
        this.deps.trace.endSpan(span, 'ok')
      }
      return {
        content: `mcp server "${this.normalizedName}" is unavailable (crashed or not connected)`,
        isError: true,
      }
    }
    try {
      const result = await this.client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { signal: this.deps.hardSignal },
      )
      // The SDK's return type is a wide union with `[x: string]: unknown`
      // index signatures, so `result.isError` is `unknown | undefined`.
      // Boolean() coerces cleanly without losing the false → false mapping.
      const sdkResult = result as { content: unknown; isError?: unknown }
      if (span && this.deps.trace) {
        this.deps.trace.endSpan(span, 'ok')
      }
      return {
        content: sdkResult.content,
        isError: Boolean(sdkResult.isError),
      }
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      this.deps.logger.warn(
        { server: this.normalizedName, tool: name, err: e.message },
        'mcp callTool failed',
      )
      if (span && this.deps.trace) {
        this.deps.trace.endSpan(span, 'error', e)
      }
      return {
        content: `mcp tool "${name}" failed on server "${this.normalizedName}": ${e.message}`,
        isError: true,
      }
    }
  }

  /**
   * Close the transport. Idempotent. Sets `closing=true` so the `onclose`
   * callback (which would otherwise mark us as crashed) becomes a no-op.
   */
  async dispose(): Promise<void> {
    if (this.closing) return
    this.closing = true
    try {
      await this.client.close()
    } catch (err) {
      this.deps.logger.warn(
        { server: this.normalizedName, err: (err as Error).message },
        'mcp dispose: client.close threw',
      )
    }
    this.connected = false
  }

  // -----------------------------------------------------------------------
  // Status
  // -----------------------------------------------------------------------

  isConnected(): boolean {
    return this.connected && !this.crashed
  }

  isCrashed(): boolean {
    return this.crashed
  }

  /** True once `dispose()` has been called. */
  isClosed(): boolean {
    return this.closing
  }

  private assertConnected(): void {
    if (!this.connected || this.crashed) {
      throw new McpUnavailableError(this.normalizedName)
    }
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function buildTransport(
  config: McpServerConfig,
  serverLabel: string,
  logger: PinoLogger,
): StdioClientTransport | StreamableHTTPClientTransport {
  if ('command' in config) {
    // stdio: spawn the child and speak newline-delimited JSON-RPC on
    // stdin/stdout. We pipe stderr (not inherit) so MCP server noise
    // surfaces in our logs under the serverLabel prefix.
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env } as Record<string, string>,
      stderr: 'pipe',
    })
  }
  // http: Streamable HTTP transport. Headers (auth, etc.) go into requestInit.
  try {
    const url = new URL(config.url)
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers: config.headers },
    })
  } catch (err) {
    logger.error(
      { server: serverLabel, url: config.url, err: (err as Error).message },
      'mcp: invalid URL in remote server config',
    )
    throw err
  }
}
