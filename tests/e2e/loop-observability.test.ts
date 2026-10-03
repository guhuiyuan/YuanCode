/**
 * E2E: loop observability — cost + trace integration
 *
 * Runs `runAgentLoop` with a scripted provider that returns a fixed
 * `tool_use` then `end_turn`. Verifies that:
 *   1. CostGuard records usage on each LLM call
 *   2. TraceLogger captures loop.run / loop.llm spans
 *   3. stopReason='end_turn' terminates cleanly
 *
 * Uses the real CostGuard + TraceLogger — the only mock is the Provider.
 */
import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { runAgentLoop } from '../../dist/core/loop.js'
import { CostGuard, DEFAULT_PRICING } from '../../dist/core/cost-guard.js'
import { TraceLogger } from '../../dist/core/trace-logger.js'
import { TwoLevelAbort } from '../../dist/core/abort.js'
import { StateMachine } from '../../dist/core/state-machine.js'
import { LocalSandbox } from '../../dist/core/sandbox/local.js'
import { ToolRegistry } from '../../dist/core/tool-registry.js'
import { PermissionGate } from '../../dist/core/permission-gate.js'
import type {
  Provider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
} from '../../dist/model/provider.js'

function silentPino() {
  return pino({ level: 'silent' })
}

function scriptProvider(steps: Array<{ stopReason: ChatResponse['stopReason']; text?: string; toolUse?: { id: string; name: string; input: unknown }; usage: { inputTokens: number; outputTokens: number }; model?: string }>): Provider {
  let i = 0
  return {
    name: 'script',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const step = steps[i++] ?? steps[steps.length - 1]!
      const content: ContentBlock[] = []
      if (step.text) content.push({ type: 'text', text: step.text })
      if (step.toolUse) {
        content.push({
          type: 'tool_use',
          id: step.toolUse.id,
          name: step.toolUse.name,
          input: step.toolUse.input,
        })
      }
      return {
        message: { role: 'assistant', content },
        stopReason: step.stopReason,
        usage: step.usage,
        model: step.model ?? 'MiniMax-M3',
      }
    },
  }
}

describe('loop observability (e2e)', () => {
  it('records cost + emits trace spans across one-step loop', async () => {
    const costGuard = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 1.0,
      model: 'MiniMax-M3',
      sessionId: 'e2e-loop-1',
    })
    const trace = new TraceLogger({ sessionId: 'e2e-loop-1', logger: silentPino() })
    const provider = scriptProvider([
      { stopReason: 'end_turn', text: 'all done', usage: { inputTokens: 100, outputTokens: 50 } },
    ])
    const cwd = process.cwd()
    const result = await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 1.0, parallelTools: 8 },
        cwd,
        sessionId: 'e2e-loop-1',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        costGuard,
        trace,
      },
      { system: 'you are a test agent', prompt: 'hello' },
    )
    expect(result.stopReason).toBe('end_turn')
    expect(result.steps).toBe(1)
    expect(costGuard.spent()).toBeGreaterThan(0)
    // Trace should have loop.run (root) + loop.llm (child)
    const spans = trace.snapshot().spans.map((s) => s.name)
    expect(spans).toContain('loop.run')
    expect(spans).toContain('loop.llm')
    expect(trace.liveCount()).toBe(0)
  })

  it('breaks with cost_limit when CostGuard over budget', async () => {
    const costGuard = new CostGuard({
      pricing: DEFAULT_PRICING,
      maxCostUsd: 0.0001,
      model: 'MiniMax-M3',
      sessionId: 'e2e-loop-2',
    })
    const trace = new TraceLogger({ sessionId: 'e2e-loop-2', logger: silentPino() })
    const provider = scriptProvider([
      // First call: tool_use
      {
        stopReason: 'tool_use',
        toolUse: { id: 't1', name: 'echo', input: { x: 1 } },
        usage: { inputTokens: 5000, outputTokens: 5000 },
      },
      // Second call (won't happen if budget breaks)
      { stopReason: 'end_turn', text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    const cwd = process.cwd()
    const result = await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 1.0, parallelTools: 8 },
        cwd,
        sessionId: 'e2e-loop-2',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        costGuard,
        trace,
      },
      { system: 'sys', prompt: 'go' },
    )
    expect(result.stopReason).toBe('cost_limit')
  })

  it('no CostGuard falls back to heuristic budget (no throw)', async () => {
    const trace = new TraceLogger({ sessionId: 'e2e-loop-3', logger: silentPino() })
    const provider = scriptProvider([
      { stopReason: 'end_turn', text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } },
    ])
    const cwd = process.cwd()
    const result = await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 5.0, parallelTools: 8 },
        cwd,
        sessionId: 'e2e-loop-3',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        trace,
      },
      { system: 'sys', prompt: 'go' },
    )
    expect(result.stopReason).toBe('end_turn')
    expect(trace.snapshot().spans.length).toBeGreaterThan(0)
  })
})