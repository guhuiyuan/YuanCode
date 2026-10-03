/**
 * Tool Registry.
 *
 * The registry is the bridge between the model layer (which sees tools as
 * JSON Schemas) and the harness layer (which dispatches to handlers).
 *
 * Key design decisions:
 *
 *   1. Schemas are Zod, not raw JSON Schema. Zod gives us compile-time
 *      types and runtime validation in one. The JSON Schema we send to the
 *      model is derived via `zodToJsonSchema` in zod-to-json.ts.
 *
 *   2. Each entry declares:
 *        - risk:             'low' | 'medium' | 'high'  (permission default)
 *        - parallelSafe:     whether the streaming executor can fan it out
 *        - timeoutMs:        per-call hard timeout
 *        - category:         for TUI grouping + permission rules
 *
 *   3. The handler is a pure function (input, ctx) → result. It does NOT
 *      know about the agent loop, messages, or the model. This keeps tools
 *      unit-testable in isolation.
 *
 *   4. Execute flow: validate input → timeout → handler. Errors during
 *      validation/timeout become `tool_result` with isError=true so the
 *      model can recover (matching Anthropic's error contract).
 */
import type { ZodTypeAny, z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import type { PermissionMode } from '../config/schema.js'
import { TwoLevelAbort } from './abort.js'
import { zodToJsonSchema } from './zod-to-json.js'
import type { SandboxRunner } from './sandbox/runner.js'
import type { HooksEngine } from '../hooks/index.js'
import { withTimeout, TimeoutError } from '../utils/with-timeout.js'

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type Risk = 'low' | 'medium' | 'high'
export type ToolCategory =
  | 'file'
  | 'shell'
  | 'search'
  | 'plan'
  | 'agent'
  | 'knowledge'
  | 'mcp'

/** Per-call state passed to every tool handler. */
export interface ToolContext {
  /** Project root (sandbox cwd). */
  cwd: string
  /** Sandbox runner for shell tools. */
  sandbox: SandboxRunner
  /** Hard-abort signal — propagate to spawn / fetch. */
  abort: TwoLevelAbort
  /** Current session ID — tools that touch the session store need this. */
  sessionId: string
  /** Resolved permission mode. Tools can read this for context-specific logic. */
  permissionMode: PermissionMode
  /** Structured logger. */
  logger: PinoLogger
  /** Optional M7 — trace logger. Tools may wrap their own work in spans. */
  trace?: import('./trace-logger.js').TraceLogger
}

/** Result returned to the harness. `content` becomes the `tool_result` text. */
export interface ToolResult {
  /** String content for the model. May include `tool_result`-internal markup. */
  content: string
  /** True when the tool refused or failed; the model should see this and recover. */
  isError?: boolean
  /** Optional metadata — the harness can use this for logging/TUI but the model never sees it. */
  metadata?: Record<string, unknown>
}

/** Single tool entry. Generic over the Zod schema so the handler gets a typed input. */
export interface ToolEntry<S extends ZodTypeAny = ZodTypeAny> {
  /** Unique tool name (lowercase, snake_case). */
  name: string
  /** What the model reads. Should include "when to use" + "input shape". */
  description: string
  /** Zod schema — used both for runtime validation and to derive JSON Schema. */
  schema: S
  /** The implementation. Receives already-validated input. */
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>
  /** Risk level — affects default permission decision. */
  risk: Risk
  /** Whether the streaming executor may run this concurrently with others. */
  parallelSafe: boolean
  /** Per-call hard timeout. Bounded by the loop's per-step timeout. */
  timeoutMs: number
  /** Category — for permission rules + TUI grouping. */
  category: ToolCategory
}

// --------------------------------------------------------------------------
// Registry
// --------------------------------------------------------------------------

export class ToolRegistry {
  private readonly tools = new Map<string, ToolEntry>()
  private hooksEngine?: HooksEngine
  /** M7 — trace logger. When set, every `execute()` wraps the handler in
   *  a `tool.<name>` child span. Optional, preserves M1-M5 behaviour. */
  private traceLogger?: import('./trace-logger.js').TraceLogger

  /**
   * Wire a hooks engine into the registry. When set, every `execute()` call
   * fires `PreToolUse` before the handler runs (a deny short-circuits the
   * handler and returns an error result) and `PostToolUse` after (informational
   * only — does not gate). Calling this with `undefined` clears the binding.
   *
   * Setter (not constructor arg) so existing M1-M5 call sites that do
   * `new ToolRegistry()` continue to compile. `cli/run.ts` calls this once
   * during boot after the hooks engine is loaded.
   */
  setHooksEngine(engine: HooksEngine | undefined): void {
    this.hooksEngine = engine
  }

  /**
   * M7 — wire a TraceLogger into the registry. When set, every `execute()`
   * call wraps the handler in a `tool.<name>` child span. The handler
   * itself can also read `ctx.trace` to start its own sub-spans.
   */
  setTraceLogger(trace: import('./trace-logger.js').TraceLogger | undefined): void {
    this.traceLogger = trace
  }

  register<S extends ZodTypeAny>(entry: ToolEntry<S>): this {
    if (this.tools.has(entry.name)) {
      throw new Error(`Tool "${entry.name}" is already registered`)
    }
    if (entry.name !== entry.name.toLowerCase()) {
      throw new Error(`Tool name must be lowercase: ${entry.name}`)
    }
    if (!/^[a-z][a-z0-9_]*$/.test(entry.name)) {
      throw new Error(
        `Tool name must match /^[a-z][a-z0-9_]*$/: ${entry.name}`,
      )
    }
    this.tools.set(entry.name, entry as unknown as ToolEntry)
    return this
  }

  unregister(name: string): void {
    this.tools.delete(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ToolEntry | undefined {
    return this.tools.get(name)
  }

  list(): ToolEntry[] {
    return [...this.tools.values()]
  }

  /** Shape sent to the model — Anthropic / OpenAI tool-calling format. */
  toModelTools(): Array<{
    name: string
    description: string
    input_schema: ReturnType<typeof zodToJsonSchema>
  }> {
    return this.list().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: zodToJsonSchema(t.schema),
    }))
  }

  /**
   * Validate + execute a tool call.
   *
   *   - Bad input   → returns ToolResult with isError=true (no throw)
   *   - Timeout     → returns ToolResult with isError=true
   *   - Handler err → returns ToolResult with isError=true
   *
   * The model always sees a well-formed tool_result — never an exception
   * bubbling up. That keeps the loop resilient.
   */
  async execute(
    name: string,
    input: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult & { tool: string; durationMs: number }> {
    const entry = this.tools.get(name)
    const start = Date.now()

    if (!entry) {
      return {
        tool: name,
        durationMs: 0,
        content: `Tool "${name}" is not registered. Available: ${this.list()
          .map((t) => t.name)
          .join(', ')}`,
        isError: true,
      }
    }

    // 1. Validate input
    const parsed = entry.schema.safeParse(input)
    if (!parsed.success) {
      return {
        tool: name,
        durationMs: 0,
        content:
          `Invalid input for tool "${name}":\n` +
          parsed.error.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n'),
        isError: true,
      }
    }

    // 2. Fire PreToolUse hook (gating). A deny short-circuits the handler.
    //    No hooks engine → skip entirely, preserving M1-M5 behaviour.
    if (this.hooksEngine) {
      const decision = await this.hooksEngine.fire('PreToolUse', {
        toolName: name,
        toolInput: parsed.data,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
      if (!decision.allowed) {
        return {
          tool: name,
          durationMs: Date.now() - start,
          content: `Tool "${name}" blocked by hook: ${decision.reason ?? 'no reason given'}`,
          isError: true,
          metadata: { hookResults: decision.results },
        }
      }
    }

    // 3. Execute with timeout
    let handlerResult: ToolResult
    let timedOut = false
    let errorMsg: string | undefined
    // M7 — trace span wraps the handler invocation. Starts only when a
    // trace logger is wired and the handler has a parent span to inherit
    // the traceId from (so we can correlate tool calls to loop iterations).
    const span = this.traceLogger && ctx.trace
      ? ctx.trace.startChild(
          // Need a real parent — fall back to a synthetic root if the
          // caller forgot to pass one. We don't import the registry's own
          // trace (no parent available here).
          this.traceLogger.startRoot(`tool.${name}`),
          `tool.${name}`,
        )
      : null
    try {
      handlerResult = await withTimeout(
        entry.handler(parsed.data, ctx),
        entry.timeoutMs,
        ctx.abort.hardSignal,
      )
      if (span && this.traceLogger) this.traceLogger.endSpan(span, 'ok')
    } catch (err) {
      if (span && this.traceLogger) {
        this.traceLogger.endSpan(
          span,
          'error',
          err instanceof Error ? err : new Error(String(err)),
        )
      }
      const msg = err instanceof Error ? err.message : String(err)
      timedOut = err instanceof TimeoutError
      errorMsg = msg
      handlerResult = {
        content: timedOut
          ? `Tool "${name}" timed out after ${entry.timeoutMs}ms. If this is expected, increase timeoutMs in the tool definition or chunk the work.`
          : `Tool "${name}" failed: ${msg}`,
        isError: true,
        metadata: { timedOut, error: msg },
      }
    }

    const finalResult: ToolResult & { tool: string; durationMs: number } = {
      ...handlerResult,
      tool: name,
      durationMs: Date.now() - start,
    }

    // 4. Fire PostToolUse hook (informational). Never gates — even if every
    //    hook denies, we return the real result to the model so it can react.
    //    The hook log is for diagnostics (e.g. TraceLogger).
    if (this.hooksEngine) {
      void this.hooksEngine.fire('PostToolUse', {
        toolName: name,
        toolInput: parsed.data,
        toolOutput: finalResult.content,
        toolError: errorMsg,
        durationMs: finalResult.durationMs,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
      })
    }

    return finalResult
  }
}

// --------------------------------------------------------------------------
// Timeout helper
// --------------------------------------------------------------------------

// Re-export TimeoutError so existing imports (`import { TimeoutError } from
// '../core/tool-registry.js'`) keep working. Implementation lives in
// `src/utils/with-timeout.ts` so the loop and sandbox runners can share it.
export { TimeoutError, withTimeout } from '../utils/with-timeout.js'
