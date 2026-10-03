/**
 * Unit tests: progress events emitted by runAgentLoop.
 *
 * The `onProgress` callback fires for step-start, step-llm-end, tool-start,
 * tool-end, and step-end. These events power the TUI's live activity log,
 * so we lock their order and content here.
 */
import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { runAgentLoop, type LoopProgressEvent } from '../../../dist/core/loop.js'
import { TwoLevelAbort } from '../../../dist/core/abort.js'
import { StateMachine } from '../../../dist/core/state-machine.js'
import { LocalSandbox } from '../../../dist/core/sandbox/local.js'
import { ToolRegistry } from '../../../dist/core/tool-registry.js'
import type {
  Provider,
  ChatRequest,
  ChatResponse,
  ContentBlock,
} from '../../../dist/model/provider.js'

const silentPino = () => pino({ level: 'silent' })

function scriptProvider(steps: Array<{ stopReason: ChatResponse['stopReason']; text?: string; toolUse?: { id: string; name: string; input: unknown }; usage: { inputTokens: number; outputTokens: number } }>): Provider {
  let i = 0
  return {
    name: 'script',
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      const step = steps[Math.min(i++, steps.length - 1)]!
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
        model: 'MiniMax-M3',
      }
    },
  }
}

describe('runAgentLoop progress events', () => {
  it('emits step-start + step-llm-end + step-end with no tools', async () => {
    const events: LoopProgressEvent[] = []
    const cwd = process.cwd()
    const provider = scriptProvider([
      { stopReason: 'end_turn', text: 'hello world', usage: { inputTokens: 5, outputTokens: 3 } },
    ])
    await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 5.0, parallelTools: 8 },
        cwd,
        sessionId: 'progress-1',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        onProgress: (e) => events.push(e),
      },
      { system: 'sys', prompt: 'hi' },
    )
    const types = events.map((e) => e.type)
    expect(types).toContain('step-start')
    expect(types).toContain('step-llm-end')
    expect(types).toContain('step-end')
    // No tool calls → no tool-start / tool-end.
    expect(types).not.toContain('tool-start')
    expect(types).not.toContain('tool-end')
    // step-start fires before step-llm-end.
    expect(types.indexOf('step-start')).toBeLessThan(types.indexOf('step-llm-end'))
    // step-end fires after step-llm-end.
    expect(types.indexOf('step-llm-end')).toBeLessThan(types.indexOf('step-end'))
  })

  it('step-llm-end carries textPreview + toolCalls when tools are issued', async () => {
    const events: LoopProgressEvent[] = []
    const cwd = process.cwd()
    const provider = scriptProvider([
      {
        stopReason: 'tool_use',
        text: 'let me try',
        toolUse: { id: 't1', name: 'echo', input: { x: 1 } },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      { stopReason: 'end_turn', text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 5.0, parallelTools: 8 },
        cwd,
        sessionId: 'progress-2',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        onProgress: (e) => events.push(e),
      },
      { system: 'sys', prompt: 'go' },
    )
    const llmEnd = events.find((e) => e.type === 'step-llm-end')
    expect(llmEnd).toBeDefined()
    if (llmEnd && llmEnd.type === 'step-llm-end') {
      expect(llmEnd.textPreview).toBe('let me try')
      expect(llmEnd.toolCalls).toEqual([{ id: 't1', name: 'echo' }])
    }
    const toolStart = events.find((e) => e.type === 'tool-start')
    expect(toolStart).toBeDefined()
    if (toolStart && toolStart.type === 'tool-start') {
      expect(toolStart.name).toBe('echo')
      expect(toolStart.id).toBe('t1')
      expect(toolStart.input).toEqual({ x: 1 })
    }
    const toolEnd = events.find((e) => e.type === 'tool-end')
    expect(toolEnd).toBeDefined()
    if (toolEnd && toolEnd.type === 'tool-end') {
      expect(toolEnd.name).toBe('echo')
      expect(typeof toolEnd.durationMs).toBe('number')
      expect(toolEnd.durationMs).toBeGreaterThanOrEqual(0)
    }
  })

  it('onProgress throwing does NOT crash the loop', async () => {
    const cwd = process.cwd()
    const provider = scriptProvider([
      { stopReason: 'end_turn', text: 'ok', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    let calls = 0
    const result = await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 5.0, parallelTools: 8 },
        cwd,
        sessionId: 'progress-throws',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        onProgress: () => {
          calls++
          throw new Error('UI is broken')
        },
      },
      { system: 'sys', prompt: 'go' },
    )
    expect(result.stopReason).toBe('end_turn')
    expect(calls).toBeGreaterThan(0)
  })

  it('emits step numbers starting at 1, incrementing', async () => {
    const events: LoopProgressEvent[] = []
    const cwd = process.cwd()
    const provider = scriptProvider([
      {
        stopReason: 'tool_use',
        toolUse: { id: 't1', name: 'echo', input: { x: 1 } },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        stopReason: 'tool_use',
        toolUse: { id: 't2', name: 'echo', input: { x: 2 } },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      { stopReason: 'end_turn', text: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ])
    await runAgentLoop(
      {
        provider,
        registry: new ToolRegistry(),
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 30_000, perStepTimeoutMs: 60_000, maxCostUsd: 5.0, parallelTools: 8 },
        cwd,
        sessionId: 'progress-multi',
        permissionMode: 'auto',
        logger: silentPino(),
        sandbox: new LocalSandbox({ cwd }),
        onProgress: (e) => events.push(e),
      },
      { system: 'sys', prompt: 'go' },
    )
    const stepStarts = events.filter((e) => e.type === 'step-start')
    expect(stepStarts.length).toBe(3)
    expect(stepStarts[0]!.type === 'step-start' && stepStarts[0]!.step).toBe(1)
    expect(stepStarts[1]!.type === 'step-start' && stepStarts[1]!.step).toBe(2)
    expect(stepStarts[2]!.type === 'step-start' && stepStarts[2]!.step).toBe(3)
  })
})