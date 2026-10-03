/**
 * Agent Loop — the while-loop that drives every YuanCode session.
 *
 *   while (true) {
 *     response = await provider.chat(messages, tools)
 *     messages.push(response.message)
 *     if (response.stopReason !== 'tool_use') break
 *     results = await Promise.all(response.tool_calls.map(execute))
 *     messages.push(tool_results_message(results))
 *   }
 *
 * Design contract (DO NOT BREAK — many modules depend on this):
 *
 *   1. The loop is provider-agnostic. It only knows about ChatMessage /
 *      ContentBlock. Adapters in src/model/* do the wire-format translation.
 *
 *   2. Tool execution is parallel where possible (parallelSafe) and serial
 *      where required (write/edit/bash). Streaming executor (M2) replaces
 *      Promise.all for finer-grained pipeline.
 *
 *   3. Step-level limits (maxSteps, perStepTimeoutMs) and session-level
 *      limits (totalTimeoutMs, maxCostUsd) are enforced by the loop, not
 *      by the provider.
 *
 *   4. Errors from tools are surfaced as `tool_result` with is_error=true
 *      so the model can recover. Only network/auth/provider errors throw.
 *
 *   5. Hard-abort: ToolContext.abort.hardSignal is wired into provider.chat
 *      so Ctrl-C kills in-flight requests immediately.
 */
import type { Provider } from '../model/provider.js'
import type {
  ChatMessage,
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
  Usage,
} from '../model/provider.js'
import { ProviderError } from '../model/provider.js'
import type { ToolRegistry, ToolContext } from './tool-registry.js'
import type { TwoLevelAbort } from './abort.js'
import type { StateMachine, Phase } from './state-machine.js'
import { Phase as PhaseConst } from './state-machine.js'
import type { LimitsConfig, PermissionMode } from '../config/schema.js'
import type { Logger as PinoLogger } from 'pino'
import type { SandboxRunner } from './sandbox/runner.js'
import type { PermissionGate } from './permission-gate.js'
import type { CostGuard } from './cost-guard.js'
import type { TraceLogger, Span } from './trace-logger.js'
import { withTimeout } from '../utils/with-timeout.js'

// --------------------------------------------------------------------------
// Public types
// --------------------------------------------------------------------------

export interface AgentLoopDeps {
  provider: Provider
  registry: ToolRegistry
  abort: TwoLevelAbort
  state: StateMachine
  limits: LimitsConfig
  cwd: string
  sessionId: string
  permissionMode: PermissionMode
  logger: PinoLogger
  sandbox: SandboxRunner
  /** Optional — when present, every tool call is gated before execution. */
  gate?: PermissionGate
  /**
   * Optional — background task pool; the loop drains notifications from
   * this pool during its MAINTENANCE phase and surfaces them as a synthetic
   * user message so the model can react to completions.
   */
  bgTaskPool?: import('./background-tasks.js').BackgroundTaskPool
  /**
   * Optional — subagent recursion depth. 0 = top-level agent (or parent
   * that is not itself a subagent). The `subagent` tool increments this
   * before spawning a child so we can refuse runaway recursion at depth 3+.
   */
  subagentDepth?: number
  /**
   * Optional — hooks engine (M6). When present, the loop fires
   * SubagentStart before each subagent spawn (deny → refuse dispatch) and
   * SubagentEnd in finally (informational). Subagents inherit the parent's
   * hooks engine so user-installed lifecycle hooks see the whole tree.
   */
  hooksEngine?: import('../hooks/index.js').HooksEngine
  /**
   * Optional — CostGuard (M7). When present, the loop records real USD
   * cost after each LLM call and breaks with `stopReason='cost_limit'`
   * once `costGuard.isOverBudget()` is true. Without it, the loop falls
   * back to the heuristic 1M-tokens-≈-$1 budget derived from
   * `limits.maxCostUsd`.
   */
  costGuard?: CostGuard
  /**
   * Optional — TraceLogger (M7). When present, the loop starts a
   * `loop.run` root span, a `loop.iteration` child per step, and a
   * `loop.llm` child around each provider.chat call. Subagent trees
   * inherit the trace logger so all spans share one traceId.
   */
  trace?: TraceLogger
  /**
   * Optional — progress callback fired from inside the loop at well-defined
   * checkpoints (before/after the LLM call, before/after each tool). The TUI
   * uses this to keep its spinner label + tool-call log up-to-date so the
   * user sees what's happening during what would otherwise look like a
   * frozen "thinking…" state. Errors here are caught and ignored — progress
   * is a UI affordance and must never break the loop.
   */
  onProgress?: (event: LoopProgressEvent) => void
}

/**
 * Discriminated union of progress events the agent loop emits. The TUI uses
 * these to render a live "what is the agent doing right now" status. Keep
 * the events small and serializable so they could later be piped over a
 * websocket / IPC for headless UIs.
 */
export type LoopProgressEvent =
  /** A new iteration begins — about to call the LLM. */
  | { type: 'step-start'; step: number }
  /** LLM call finished; carries the model's text and any tool calls. */
  | {
      type: 'step-llm-end'
      step: number
      stopReason: import('../model/provider.js').StopReason
      textPreview: string
      toolCalls: Array<{ id: string; name: string }>
      usage: import('../model/provider.js').Usage
    }
  /** A tool is starting — fired before each `registry.execute`. */
  | { type: 'tool-start'; step: number; id: string; name: string; input: unknown }
  /** A tool finished — carries a brief summary (truncated content). */
  | {
      type: 'tool-end'
      step: number
      id: string
      name: string
      isError: boolean
      durationMs: number
      preview: string
    }
  /** A step is complete — fired after every iteration regardless of whether
   *  tools ran. `durationMs` covers the whole step (LLM + tools). The TUI
   *  uses this to print "step N done" lines for both tool-use steps and
   *  end_turn steps. */
  | { type: 'step-end'; step: number; durationMs: number }

export interface AgentLoopOptions {
  system: string
  /** Initial user prompt. May be empty if the loop is resumed. */
  prompt: string
  /** Pre-existing history (e.g. when resuming a session). */
  history?: ChatMessage[]
}

export interface AgentLoopResult {
  /** The last assistant message — usually the final answer. */
  finalMessage: ChatMessage
  /** All messages produced (appended to history on resume). */
  messages: ChatMessage[]
  /** Total steps taken (one provider.chat call per step). */
  steps: number
  /** Cumulative usage across all steps. */
  usage: Usage
  /** Why the loop terminated. */
  stopReason:
    | 'end_turn'
    | 'max_steps'
    | 'max_tokens'
    | 'total_timeout'
    | 'cost_limit'
    | 'aborted'
    | 'provider_error'
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * Run the agent loop until end_turn / max_steps / timeout / cost limit / abort.
 */
export async function runAgentLoop(
  deps: AgentLoopDeps,
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  if (!deps.state.tryAcquire()) {
    throw new Error('AgentLoop is already running for this session')
  }
  const runStart = Date.now()
  const totalUsage: Usage = { inputTokens: 0, outputTokens: 0 }

  const messages: ChatMessage[] = [...(opts.history ?? [])]
  if (opts.prompt) {
    messages.push({ role: 'user', content: opts.prompt })
  }

  let steps = 0
  let stopReason: AgentLoopResult['stopReason'] = 'end_turn'

  const toolCtx: ToolContext = {
    cwd: deps.cwd,
    sandbox: deps.sandbox,
    abort: deps.abort,
    sessionId: deps.sessionId,
    permissionMode: deps.permissionMode,
    logger: deps.logger,
    trace: deps.trace,
  }

  // M7 — root span for the whole loop run. Wrapped in run() so we get
  // auto-end with the final status. Span name reflects the agent role so
  // /inspect can distinguish top-level sessions from subagent traces.
  const rootSpan: Span | null = deps.trace
    ? deps.trace.startRoot('loop.run', { sessionId: deps.sessionId })
    : null

  // Helper: fire a progress event if `onProgress` is wired. Errors are
  // swallowed — progress is a UI affordance, never break the loop.
  const emit = (event: LoopProgressEvent): void => {
    if (!deps.onProgress) return
    try {
      deps.onProgress(event)
    } catch (err) {
      deps.logger.warn({ err: (err as Error).message }, 'onProgress callback threw')
    }
  }

  try {
    if (rootSpan) deps.state.transition(PhaseConst.MAINTENANCE)
    while (true) {
      // ---- guard rails ----
      if (deps.abort.aborted) {
        stopReason = 'aborted'
        break
      }
      if (Date.now() - runStart > deps.limits.totalTimeoutMs) {
        stopReason = 'total_timeout'
        break
      }
      if (isOverCostBudget(deps, totalUsage)) {
        stopReason = 'cost_limit'
        break
      }
      if (steps >= deps.limits.maxSteps) {
        stopReason = 'max_steps'
        break
      }

      deps.state.transition(PhaseConst.RUNNING)
      steps++

      // ---- Progress: tell the UI we're starting a new step ----
      emit({ type: 'step-start', step: steps })
      const stepStartedAt = Date.now()

      // ---- LLM call ----
      // Wrap in a child span for observability. The wall-clock race is
      // intentionally NOT applied here — the provider's own AbortSignal
      // and the `perStepTimeoutMs` (passed as maxTokens) are the two
      // enforcement mechanisms. Adding a hard wall-clock cap would kill
      // a slow but legitimate generation, so we trust the provider +
      // hard-abort.
      const llmSpan: Span | null = rootSpan
        ? deps.trace!.startChild(rootSpan, 'loop.llm', { step: steps })
        : null
      let response
      try {
        response = await deps.provider.chat(
          {
            messages,
            system: opts.system,
            tools: deps.registry.toModelTools(),
            maxTokens: deps.limits.perStepTimeoutMs,
          },
          deps.abort.hardSignal,
        )
        if (llmSpan) deps.trace!.endSpan(llmSpan, 'ok')
      } catch (e) {
        if (llmSpan) {
          deps.trace!.endSpan(
            llmSpan,
            'error',
            e instanceof Error ? e : new Error(String(e)),
          )
        }
        if (deps.abort.aborted) {
          stopReason = 'aborted'
          break
        }
        if (e instanceof ProviderError && !e.retryable) {
          // Surface as a final assistant text — keep the session intact.
          messages.push({
            role: 'assistant',
            content: `Provider error: ${e.message}`,
          })
          stopReason = 'provider_error'
          break
        }
        throw e
      }

      // Accumulate usage
      totalUsage.inputTokens += response.usage.inputTokens
      totalUsage.outputTokens += response.usage.outputTokens
      if (response.usage.cacheReadTokens) {
        totalUsage.cacheReadTokens = (totalUsage.cacheReadTokens ?? 0) + response.usage.cacheReadTokens
      }
      if (response.usage.cacheWriteTokens) {
        totalUsage.cacheWriteTokens = (totalUsage.cacheWriteTokens ?? 0) + response.usage.cacheWriteTokens
      }

      // M7 — record real USD cost against CostGuard (if wired). Without a
      // CostGuard, fall back to the heuristic budget in isOverCostBudget().
      if (deps.costGuard && response.model) {
        deps.costGuard.record(response.model, response.usage)
      }

      // Append the assistant message verbatim (includes any tool_use blocks)
      messages.push(response.message)

      // ---- Progress: surface what the LLM just produced ----
      {
        const blocks = Array.isArray(response.message.content)
          ? response.message.content
          : []
        const textPreview = blocks
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')
          .slice(0, 120)
        const toolCalls = blocks
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name }))
        emit({
          type: 'step-llm-end',
          step: steps,
          stopReason: response.stopReason,
          textPreview,
          toolCalls,
          usage: response.usage,
        })
      }

      // ---- Branch on stop reason ----
      // Always emit `step-end` so the UI gets a "step N done" signal
      // regardless of whether the LLM issued tool calls or terminated
      // cleanly with end_turn. Duration covers the whole step including
      // tool execution (when tools ran).
      if (response.stopReason === 'tool_use') {
        // Drain notifications / maintenance between steps
        deps.state.transition(PhaseConst.MAINTENANCE)

        // M5: drain background-task notifications and inject them as a
        // synthetic user message so the model can react to completions
        // in its next step.
        if (deps.bgTaskPool) {
          const completed = deps.bgTaskPool.drainNotifications()
          if (completed.length > 0) {
            const summary = completed
              .map((t) => {
                const body =
                  t.result?.content ?? t.error ?? '(no output)'
                return `<background-${t.status} id="${t.id}" tool="${t.tool}">${body.slice(0, 500)}</background-${t.status}>`
              })
              .join('\n')
            messages.push({
              role: 'user',
              content:
                `<background-notifications>\nThe following background tasks completed since the last step. ` +
                `Read each result and decide what to do next (e.g. call background_check for full output, or proceed with the next step).\n${summary}\n</background-notifications>`,
            })
          }
        }

        const toolUses = (response.message.content as ContentBlock[]).filter(
          (b): b is ToolUseBlock => b.type === 'tool_use',
        )
        const results = await executeTools(toolUses, deps, toolCtx, steps, emit)
        emit({ type: 'step-end', step: steps, durationMs: Date.now() - stepStartedAt })
        messages.push({ role: 'user', content: results })
        continue
      }

      // No tools → emit step-end so the TUI can show "step N done" too.
      emit({ type: 'step-end', step: steps, durationMs: Date.now() - stepStartedAt })

      if (response.stopReason === 'max_tokens') {
        stopReason = 'max_tokens'
        break
      }

      // end_turn / stop_sequence → terminal
      stopReason = 'end_turn'
      break
    }
  } finally {
    deps.state.release()
    if (rootSpan && deps.trace) {
      // Status reflects how the loop ended. Aborted / cost / max are
      // not errors per se, but `end_turn` / `end_max_steps` are ok;
      // anything else (including a thrown error) is an error.
      const isError =
        stopReason === 'aborted' ||
        stopReason === 'provider_error' ||
        stopReason === 'total_timeout'
      deps.trace.endSpan(
        rootSpan,
        isError ? 'error' : 'ok',
        isError ? new Error(stopReason) : undefined,
      )
    }
  }

  const finalMessage = messages[messages.length - 1] ?? {
    role: 'assistant',
    content: '',
  }

  return {
    finalMessage,
    messages,
    steps,
    usage: totalUsage,
    stopReason,
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Execute a list of tool calls. parallelSafe tools may run concurrently;
 * non-parallel-safe tools run sequentially in declaration order.
 *
 * Each call is gated through PermissionGate first (when one is supplied).
 * A deny produces a `tool_result` with is_error=true and the loop continues —
 * the model is expected to adapt (try a different approach, ask the user).
 */
async function executeTools(
  calls: ToolUseBlock[],
  deps: AgentLoopDeps,
  baseCtx: ToolContext,
  step: number,
  emit: (event: LoopProgressEvent) => void,
): Promise<ToolResultBlock[]> {
  const out: ToolResultBlock[] = []
  let i = 0
  while (i < calls.length) {
    const call = calls[i]!
    const entry = deps.registry.get(call.name)
    const isParallel =
      entry?.parallelSafe && calls[i + 1] && deps.registry.get(calls[i + 1]!.name)?.parallelSafe

    if (isParallel) {
      // Batch this call + all following parallel-safe calls into a Promise.all
      const batch: ToolUseBlock[] = []
      while (
        i < calls.length &&
        deps.registry.get(calls[i]!.name)?.parallelSafe
      ) {
        batch.push(calls[i]!)
        i++
      }
      const results = await Promise.all(
        batch.map(async (c) => {
          emit({ type: 'tool-start', step, id: c.id, name: c.name, input: c.input })
          const t0 = Date.now()
          const decision = await gateFor(c, deps)
          let result
          if (decision.action !== 'allow') {
            result = deniedResult(c, decision.reason)
          } else {
            result = await deps.registry.execute(c.name, c.input, baseCtx)
          }
          emit({
            type: 'tool-end',
            step,
            id: c.id,
            name: c.name,
            isError: !!result.isError,
            durationMs: Date.now() - t0,
            preview: previewToolResult(result.content),
          })
          return result
        }),
      )
      for (let j = 0; j < batch.length; j++) {
        out.push(toResultBlock(batch[j]!, results[j]!))
      }
    } else {
      emit({ type: 'tool-start', step, id: call.id, name: call.name, input: call.input })
      const t0 = Date.now()
      const decision = await gateFor(call, deps)
      let result
      if (decision.action !== 'allow') {
        result = deniedResult(call, decision.reason)
      } else {
        result = await deps.registry.execute(call.name, call.input, baseCtx)
      }
      emit({
        type: 'tool-end',
        step,
        id: call.id,
        name: call.name,
        isError: !!result.isError,
        durationMs: Date.now() - t0,
        preview: previewToolResult(result.content),
      })
      out.push(toResultBlock(call, result))
      i++
    }
  }
  return out
}

/**
 * Trim a tool result down to a single-line summary suitable for the TUI's
 * step log. Strips newlines, collapses whitespace, hard-caps length so the
 * log stays scannable.
 */
function previewToolResult(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((b): b is { type: 'text'; text: string } => b && (b as { type?: string }).type === 'text')
          .map((b) => b.text)
          .join('')
      : ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= 120 ? flat : flat.slice(0, 119) + '…'
}

async function gateFor(
  call: ToolUseBlock,
  deps: AgentLoopDeps,
): Promise<{ action: 'allow' | 'deny' | 'ask'; reason: string }> {
  if (!deps.gate) return { action: 'allow', reason: 'no gate' }
  const entry = deps.registry.get(call.name)
  if (!entry) {
    return { action: 'deny', reason: `unknown tool: ${call.name}` }
  }
  const decision = await deps.gate.decide(entry, call.input)
  deps.logger.debug(
    {
      tool: call.name,
      action: decision.action,
      reason: decision.reason,
    },
    'permission decision',
  )
  return decision
}

/** Shape returned by `registry.execute` AND by `deniedResult` — both
 *  satisfy the same `{ content: string; isError?: boolean }` shape so the
 *  parallel batch can Promise.all them uniformly. */
function deniedResult(call: ToolUseBlock, reason: string): { content: string; isError: boolean } {
  return {
    content: `Permission denied for "${call.name}": ${reason}. Try a different approach or ask the user.`,
    isError: true,
  }
}

function toResultBlock(
  call: ToolUseBlock,
  r: { content: string; isError?: boolean },
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: call.id,
    content: r.content,
    is_error: r.isError,
  }
}

/**
 * Cost budget guard. When a CostGuard is wired in (M7), defer to its
 * authoritative USD-based check. Otherwise fall back to the M6 heuristic
 * (1M tokens ≈ $1) — preserves behavior for callers that haven't opted
 * into CostGuard yet.
 */
function isOverCostBudget(deps: AgentLoopDeps, usage: Usage): boolean {
  if (deps.costGuard) {
    return deps.costGuard.isOverBudget()
  }
  if (deps.limits.maxCostUsd <= 0) return false
  const cap = Math.floor(deps.limits.maxCostUsd * 1_000_000)
  return usage.inputTokens + usage.outputTokens >= cap
}

export type { Phase }
