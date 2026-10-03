/**
 * Subagent — fresh-context child agent.
 *
 * The parent agent invokes a subagent via the `subagent` tool, passing a
 * task prompt. We spin up an independent `runAgentLoop` instance with:
 *
 *   - messages: []     (no shared context)
 *   - new session id   (events correlate via the `subagent_start` event)
 *   - new state machine (so tryAcquire doesn't collide with the parent)
 *   - new abort controller (parent hard-abort cascades via onAbort listener)
 *   - tighter limits (maxSteps, totalTimeoutMs) so a misbehaving child
 *     can't burn the parent's budget
 *
 * Result: only the child's final assistant text is returned. Intermediate
 * tool calls, errors, and the full message list are NOT bubbled up to the
 * parent — keeping the parent's context clean. The SessionStore still
 * records the lifecycle so /rewind and resume can inspect.
 *
 * Recursion: `SubagentSpec.depth` defaults to 0 and is incremented by the
 * `subagent` tool on each invocation. At depth 3 (or beyond) we refuse
 * to spawn and return an `isError: true` to the caller.
 */
import { randomUUID } from 'node:crypto'
import { runAgentLoop, type AgentLoopDeps, type AgentLoopResult } from './loop.js'
import { TwoLevelAbort } from './abort.js'
import { StateMachine } from './state-machine.js'
import type { Usage } from '../model/provider.js'
import type { HooksEngine } from '../hooks/index.js'

export type SubagentType = 'general' | 'explore' | 'review'

export interface SubagentSpec {
  type: SubagentType
  prompt: string
  /** Override the type-specific system prompt; rare. */
  systemOverride?: string
  /** Recursion depth (0 = top-level subagent). */
  depth?: number
  /** Cap steps; default 25. */
  maxSteps?: number
  /** Cap wall-clock ms; default 120_000. */
  totalTimeoutMs?: number
  /** Cap input+output tokens; default 100_000. */
  maxCostTokens?: number
}

export interface SubagentResult {
  summary: string
  steps: number
  stopReason: AgentLoopResult['stopReason']
  usage: Usage
  subagentId: string
  type: SubagentType
  depth: number
  /** M7 — USD cost incurred by this subagent. Reflects only the records
   *  added while this subagent was alive (parent's records may include
   *  older entries — see CostGuard.child() for the sharing model). */
  costUsd: number
}

// --------------------------------------------------------------------------
// Public entry point
// --------------------------------------------------------------------------

/**
 * Spawn a subagent loop. **Never throws** — failures are captured into the
 * returned `summary` so the parent's tool_result always has a string.
 */
export async function runSubagent(
  parentDeps: AgentLoopDeps,
  spec: SubagentSpec,
): Promise<SubagentResult> {
  const depth = spec.depth ?? 0
  const subagentId = randomUUID()

  // Recursion cap — refuse to spawn beyond depth 3 (one great-grandchild
  // past the grandparent). This is a safety net for runaway tool loops.
  if (depth > 3) {
    return {
      summary:
        `Refusing to spawn subagent: recursion depth ${depth} exceeds maximum (3). ` +
        `Have the current subagent finish its task without delegating further.`,
      steps: 0,
      stopReason: 'aborted',
      usage: { inputTokens: 0, outputTokens: 0 },
      subagentId,
      type: spec.type,
      depth,
      costUsd: 0,
    }
  }

  // Build child deps with fresh state + abort. We inherit provider,
  // registry, sandbox, cwd, limits template, permissionMode, logger —
  // but **override** sessionId, state, and abort. We do NOT share the
  // parent's sessionId because SessionStore events would collide.
  // HooksEngine is inherited so user-installed lifecycle hooks see the
  // entire agent tree (parents and children fire into the same engine).
  //
  // M7 — CostGuard: derive a child scope so this subagent enforces its
  // own (tighter) USD ceiling while sharing records with the parent for
  // a unified breakdown. Default budget: parent budget or $0.50, whichever
  // is smaller.
  const childCostGuard = parentDeps.costGuard
    ? parentDeps.costGuard.child({
        maxCostUsd: Math.min(parentDeps.costGuard.ceiling() || 0.5, 0.5),
        source: 'subagent',
      })
    : undefined
  const childAbort = new TwoLevelAbort()
  const childDeps: AgentLoopDeps = {
    provider: parentDeps.provider,
    registry: parentDeps.registry,
    abort: childAbort,
    state: new StateMachine(),
    limits: {
      ...parentDeps.limits,
      maxSteps: spec.maxSteps ?? Math.min(parentDeps.limits.maxSteps, 25),
      totalTimeoutMs: spec.totalTimeoutMs ?? 120_000,
    },
    cwd: parentDeps.cwd,
    sessionId: subagentId,
    permissionMode: parentDeps.permissionMode,
    logger: parentDeps.logger.child({ component: 'subagent', subagentId, depth }),
    sandbox: parentDeps.sandbox,
    gate: parentDeps.gate,
    subagentDepth: depth,
    hooksEngine: parentDeps.hooksEngine,
    costGuard: childCostGuard,
    trace: parentDeps.trace,
  }

  // Cascade parent hard-abort → child hard-abort. We deliberately do NOT
  // forward soft-abort (the parent should let the child finish if it can).
  const unsubscribe = parentDeps.abort.onAbort((level) => {
    if (level === 'hard') childAbort.trigger('hard')
  })

  const system =
    spec.systemOverride ?? SUBAGENT_SYSTEM_PROMPTS[spec.type] ?? SUBAGENT_SYSTEM_PROMPTS.general!

  parentDeps.logger.info(
    { subagentId, type: spec.type, depth, promptLen: spec.prompt.length },
    'subagent starting',
  )

  // SubagentStart is a GATING event — a deny short-circuits the dispatch.
  // We do this AFTER the recursion-depth check (cheap) but BEFORE we
  // allocate child state, so a denied subagent costs almost nothing.
  const hooksEngine: HooksEngine | undefined = parentDeps.hooksEngine
  let hooksEndStatus: 'success' | 'error' | 'abort' = 'success'
  let hooksEndResult: string | undefined

  if (hooksEngine) {
    try {
      const decision = await hooksEngine.fire('SubagentStart', {
        subagentType: spec.type,
        subagentId,
        task: spec.prompt,
        sessionId: parentDeps.sessionId,
        cwd: parentDeps.cwd,
      })
      if (!decision.allowed) {
        parentDeps.logger.warn(
          { subagentId, type: spec.type, reason: decision.reason },
          'subagent blocked by SubagentStart hook',
        )
        return {
          summary:
            `<subagent-blocked subagentId="${subagentId}" type="${spec.type}">` +
            `${decision.reason ?? 'no reason given'}</subagent-blocked>`,
          steps: 0,
          stopReason: 'aborted',
          usage: { inputTokens: 0, outputTokens: 0 },
          subagentId,
          type: spec.type,
          depth,
          costUsd: 0,
        }
      }
    } catch (err) {
      // Fail-closed: a hook exception denies dispatch.
      const msg = (err as Error).message
      parentDeps.logger.warn(
        { subagentId, err: msg },
        'SubagentStart hook threw (fail-closed)',
      )
      return {
        summary: `<subagent-blocked subagentId="${subagentId}" type="${spec.type}">hook error: ${msg}</subagent-blocked>`,
        steps: 0,
        stopReason: 'aborted',
        usage: { inputTokens: 0, outputTokens: 0 },
        subagentId,
        type: spec.type,
        depth,
        costUsd: 0,
      }
    }
  }

  let resultSummary = ''
  let resultSteps = 0
  let resultStopReason: AgentLoopResult['stopReason'] = 'end_turn'
  let resultUsage: Usage = { inputTokens: 0, outputTokens: 0 }
  let resultCostUsd = 0

  try {
    const result = await runAgentLoop(childDeps, {
      system,
      prompt: spec.prompt,
      history: [],
    })
    parentDeps.logger.info(
      {
        subagentId,
        steps: result.steps,
        stopReason: result.stopReason,
        tokens: result.usage.inputTokens + result.usage.outputTokens,
      },
      'subagent ended',
    )
    resultSummary = extractFinalText(result)
    resultSteps = result.steps
    resultStopReason = result.stopReason
    resultUsage = result.usage
    // CostGuard captures all charges from this subagent's loop. Snapshot
    // the spent total before the child's CostGuard is GC'd (it's still
    // reachable through the parent's records, but capturing it here
    // preserves the per-subagent view).
    resultCostUsd = childCostGuard ? childCostGuard.spent() : 0
    if (resultStopReason === 'aborted') hooksEndStatus = 'abort'
    else hooksEndStatus = 'success'
    hooksEndResult = resultSummary
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    parentDeps.logger.warn({ subagentId, err: msg }, 'subagent threw — capturing as tool error')
    resultSummary = `<subagent-failed subagentId="${subagentId}" type="${spec.type}">${msg}</subagent-failed>`
    resultSteps = 0
    resultStopReason = 'provider_error'
    resultUsage = { inputTokens: 0, outputTokens: 0 }
    resultCostUsd = childCostGuard ? childCostGuard.spent() : 0
    hooksEndStatus = 'error'
    hooksEndResult = msg
  } finally {
    unsubscribe()
    // Best-effort: also hard-abort the child in case it leaked past the
    // loop's own state.release().
    childAbort.trigger('hard')

    // SubagentEnd is INFORMATIONAL — fires after dispatch regardless of
    // outcome (success / error / abort). We never throw out of the hook
    // failure path; it's wrapped in try/catch so a misbehaving hook can't
    // break the caller's tool_result.
    if (hooksEngine) {
      void hooksEngine
        .fire('SubagentEnd', {
          subagentType: spec.type,
          subagentId,
          status: hooksEndStatus,
          result: hooksEndResult,
          sessionId: parentDeps.sessionId,
          cwd: parentDeps.cwd,
        })
        .catch((err) => {
          parentDeps.logger.warn(
            { subagentId, err: (err as Error).message },
            'SubagentEnd hook threw (informational, ignored)',
          )
        })
    }
  }

  return {
    summary: resultSummary,
    steps: resultSteps,
    stopReason: resultStopReason,
    usage: resultUsage,
    subagentId,
    type: spec.type,
    depth,
    costUsd: resultCostUsd,
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function extractFinalText(result: AgentLoopResult): string {
  const msg = result.finalMessage
  if (typeof msg.content === 'string') return msg.content
  return msg.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

// --------------------------------------------------------------------------
// Subagent system prompts — short, focused. Each child gets a system
// prompt that primes it for the task type, plus a header reminding it
// that its result will be returned to the parent.
// --------------------------------------------------------------------------

const SUBAGENT_HEADER = `You are a subagent spawned by a parent YuanCode agent.
You have a FRESH context — no shared history with the parent.
Complete the task given below, then return a concise final answer.
Do not narrate your plan or your intermediate steps; the parent only sees
your final message text.`

const SUBAGENT_SYSTEM_PROMPTS: Record<SubagentType, string> = {
  general:
    SUBAGENT_HEADER +
    `\n\nYou are a general-purpose assistant. Use the available tools to answer ` +
    `the question or complete the task. Prefer reading code over guessing.`,

  explore:
    SUBAGENT_HEADER +
    `\n\nYou are an exploration agent. Your job is to map the codebase: find ` +
    `files, understand structure, locate symbols. Use ONLY read/grep/glob — ` +
    `do NOT modify files. Return a focused summary of what you found, with ` +
    `file paths and line numbers so the parent can act on your findings.`,

  review:
    SUBAGENT_HEADER +
    `\n\nYou are a code review agent. Read the relevant files and produce a ` +
    `concise review covering: (a) correctness, (b) edge cases, (c) style/` +
    `conventions, (d) tests. Format each finding as:\n` +
    `  - <severity: blocker|major|minor|nit> <file:line> <description>\n` +
    `Order by severity. Do not propose fixes — just identify issues.`,
}