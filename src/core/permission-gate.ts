/**
 * Permission Gate.
 *
 * Decides whether a tool call is allowed, denied, or must be confirmed by the
 * user. The decision tree (top-down, first match wins):
 *
 *   1. Session-scoped cache — "always allow" / "always deny" set by the user
 *      during this session.
 *   2. Project rules — `allow`/`deny`/`ask` regex match on tool name (+ input).
 *   3. Mode × risk × category matrix — see decideByMode below.
 *   4. PreToolUse hooks — installed in M6; can veto an allow OR promote an
 *      ask to allow (via `{"decision":"approve"}`).
 *   5. Ask the user (TUI permission prompt).
 *
 * Modes (matching Claude Code):
 *
 *   manual        — every non-low-risk tool asks
 *   acceptEdits   — file-edit-category tools auto-allow, rest ask
 *   auto          — auto-allow everything (Claude Code Pro/Max default)
 *   plan          — read-only; everything that mutates is denied
 *
 * Risk levels: low / medium / high — assigned by the tool's ToolEntry.
 */
import type { PermissionMode } from '../config/schema.js'
import type { ToolEntry, ToolCategory } from './tool-registry.js'
import type { HooksEngine } from '../hooks/index.js'
import { z } from 'zod'

// --------------------------------------------------------------------------
// Rule schema — what users write in their config.yaml
// --------------------------------------------------------------------------

export const PermissionActionSchema = z.enum(['allow', 'deny', 'ask'])
export type PermissionAction = z.infer<typeof PermissionActionSchema>

export interface PermissionRule {
  /** Tool name to match (exact or regex). */
  toolName: string | RegExp
  /** Optional input predicate — matched against the JSON-stringified input. */
  inputMatcher?: string | RegExp
  action: PermissionAction
}

export interface PermissionDecision {
  action: PermissionAction
  /** Human-readable reason shown to the user (TUI + logs). */
  reason: string
  /** When action='ask', this callback resolves the user's choice. */
  ask?: () => Promise<PermissionAction>
}

// --------------------------------------------------------------------------
// Gate
// --------------------------------------------------------------------------

export interface PermissionGateDeps {
  mode: PermissionMode
  rules?: PermissionRule[]
  sessionCache?: Map<string, PermissionAction>
  /**
   * Called when the decision requires user input. The TUI implements this;
   * headless contexts (doctor, CI) supply an auto-deny default.
   */
  onAsk?: (tool: ToolEntry, input: unknown) => Promise<PermissionAction>
  /**
   * Optional hooks engine (M6). When present, the gate fires `PreToolUse`
   * after the mode matrix and before asking the user. A hook can:
   *   - VETO any decision by denying (returns 'deny' regardless of mode)
   *   - PROMOTE an 'ask' to 'allow' by emitting {"decision":"approve"}
   *
   * Fail-closed: any hook exception is treated as deny.
   */
  hooksEngine?: HooksEngine
}

export class PermissionGate {
  private readonly mode: PermissionMode
  private readonly rules: PermissionRule[]
  private readonly cache: Map<string, PermissionAction>
  private readonly onAsk: PermissionGateDeps['onAsk']
  private readonly hooksEngine?: HooksEngine
  /** M7 — trace logger. When set, `decide()` is wrapped in a `gate.decide`
   *  child span so deny/ask flows show up in observability. */
  private traceLogger?: import('./trace-logger.js').TraceLogger

  constructor(deps: PermissionGateDeps) {
    this.mode = deps.mode
    this.rules = deps.rules ?? []
    this.cache = deps.sessionCache ?? new Map()
    this.onAsk = deps.onAsk ?? (() => Promise.resolve('ask' as const))
    this.hooksEngine = deps.hooksEngine
  }

  /** M7 — wire a TraceLogger. Same setter pattern as ToolRegistry so
   *  callers can opt in without breaking existing constructor signatures. */
  setTraceLogger(trace: import('./trace-logger.js').TraceLogger | undefined): void {
    this.traceLogger = trace
  }

  /** Inspect (without consuming) the session cache for a given tool. */
  getCached(toolName: string): PermissionAction | undefined {
    return this.cache.get(toolName)
  }

  /** Set a session-scoped override (used by "always allow" / "always deny"). */
  cacheOnce(toolName: string, action: PermissionAction): void {
    this.cache.set(toolName, action)
  }

  /** Clear all session-scoped overrides. */
  resetCache(): void {
    this.cache.clear()
  }

  /**
   * Decide whether `tool` may run with `input`. Returns the action plus a
   * reason string for logging / UI display.
   *
   * Never throws — if the user denies or the gate denies, returns
   * `{ action: 'deny' }` and the caller short-circuits the tool invocation.
   */
  async decide(tool: ToolEntry, input: unknown): Promise<PermissionDecision> {
    const span = this.traceLogger
      ? this.traceLogger.startRoot('gate.decide', { tool: tool.name })
      : null
    try {
      const out = await this.decideInner(tool, input)
      if (span && this.traceLogger) {
        this.traceLogger.endSpan(span, 'ok')
      }
      return out
    } catch (err) {
      if (span && this.traceLogger) {
        this.traceLogger.endSpan(
          span,
          'error',
          err instanceof Error ? err : new Error(String(err)),
        )
      }
      throw err
    }
  }

  private async decideInner(
    tool: ToolEntry,
    input: unknown,
  ): Promise<PermissionDecision> {
    // 1. Session cache
    const cached = this.cache.get(tool.name)
    if (cached) {
      return { action: cached, reason: `session cache (${cached})` }
    }

    // 2. Project rules (first match wins)
    for (const rule of this.rules) {
      if (!matchesTool(rule.toolName, tool.name)) continue
      if (rule.inputMatcher && !matchesInput(rule.inputMatcher, input)) continue
      return {
        action: rule.action,
        reason: `rule: tool=${tool.name} action=${rule.action}`,
      }
    }

    // 3. Mode × risk × category matrix
    const byMode = decideByMode(this.mode, tool.risk, tool.category)

    // 4. Hooks veto / promote (M6 — three-stage pipeline: mode → hooks → ask).
    //    No hooksEngine → skip this stage entirely (preserves M1-M5 behaviour).
    let afterHooks = byMode
    if (this.hooksEngine) {
      try {
        const decision = await this.hooksEngine.fire('PreToolUse', {
          toolName: tool.name,
          toolInput: input,
          sessionId: '',
          cwd: '',
        })
        if (!decision.allowed) {
          return {
            action: 'deny',
            reason: `hook veto: ${decision.reason ?? 'no reason given'}`,
          }
        }
        // Promote ask → allow if any hook approved explicitly.
        if (byMode.action === 'ask' && decision.results.some((r) => r.outcome === 'approve')) {
          afterHooks = { action: 'allow', reason: `hook pre-approved: ${byMode.reason}` }
        }
      } catch (err) {
        // Fail-closed: any hook exception → deny.
        return {
          action: 'deny',
          reason: `hook error (fail-closed): ${(err as Error).message}`,
        }
      }
    }

    if (afterHooks.action !== 'ask') {
      return afterHooks
    }

    // 5. Ask the user
    const choice = await this.onAsk!(tool, input)
    return {
      action: choice,
      reason: `user prompt → ${choice}`,
    }
  }
}

// --------------------------------------------------------------------------
// Pure decision helper — exposed for tests
// --------------------------------------------------------------------------

export function decideByMode(
  mode: PermissionMode,
  risk: ToolEntry['risk'],
  category: ToolCategory,
): PermissionDecision {
  switch (mode) {
    case 'auto':
      // 'mcp' tools are user-authorized (added to mcp.json explicitly) — auto
      // mode allows them just like anything else.
      return { action: 'allow', reason: `mode=auto → allow all` }

    case 'plan':
      // Plan mode is read-only. file + shell are denied; 'mcp' tools whose
      // risk is medium or higher are also denied (a misbehaving MCP server
      // could write through the user). Low-risk MCP stays allow because
      // they're typically read-only operations (search, list, get).
      if (category === 'shell' || category === 'file') {
        return { action: 'deny', reason: `mode=plan → no writes` }
      }
      if (category === 'mcp') {
        return risk === 'low'
          ? { action: 'allow', reason: `mode=plan → low-risk mcp allow` }
          : { action: 'deny', reason: `mode=plan → mcp risk=${risk} deny` }
      }
      return { action: 'allow', reason: `mode=plan → read-only` }

    case 'acceptEdits':
      // File tools auto-allow; shell/mcp/other categories ask (or low-risk allow).
      if (category === 'file') {
        return { action: 'allow', reason: `mode=acceptEdits → file auto-allow` }
      }
      return askForRisk(risk, `mode=acceptEdits → non-file ask`)

    case 'manual':
      return askForRisk(risk, `mode=manual → ask`)

    default: {
      const _exhaustive: never = mode
      return { action: 'ask', reason: `unknown mode: ${String(_exhaustive)}` }
    }
  }
}

function askForRisk(
  risk: ToolEntry['risk'],
  prefix: string,
): PermissionDecision {
  if (risk === 'low') return { action: 'allow', reason: `${prefix} (low risk)` }
  return { action: 'ask', reason: `${prefix} (${risk} risk)` }
}

// --------------------------------------------------------------------------
// Matching helpers
// --------------------------------------------------------------------------

function matchesTool(pattern: string | RegExp, name: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(name)
  return pattern === name
}

function matchesInput(pattern: string | RegExp, input: unknown): boolean {
  let serialized: string
  try {
    serialized = typeof input === 'string' ? input : JSON.stringify(input)
  } catch {
    serialized = String(input)
  }
  if (pattern instanceof RegExp) return pattern.test(serialized)
  return serialized.includes(pattern)
}
