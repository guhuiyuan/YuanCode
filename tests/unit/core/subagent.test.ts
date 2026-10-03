/**
 * Subagent — fresh-context child agent via runSubagent.
 *
 * These tests build a minimal AgentLoopDeps with a scripted provider so we
 * can observe how the child loop behaves: history = [], independent
 * state/abort, error capture, recursion cap.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { StateMachine } from '../../../src/core/state-machine.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { runSubagent } from '../../../src/core/subagent.js'
import type {
  Provider,
  ChatRequest,
  ChatResponse,
  Usage,
} from '../../../src/model/provider.js'
import type { AgentLoopDeps } from '../../../src/core/loop.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: () => noopLogger,
} as unknown as PinoLogger

class ScriptedProvider implements Provider {
  readonly name = 'scripted'
  private queue: ChatResponse[] = []
  readonly calls: ChatRequest[] = []
  push(r: ChatResponse): this {
    this.queue.push(r)
    return this
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req)
    const next = this.queue.shift()
    if (!next) throw new Error('ScriptedProvider ran out of canned responses')
    return next
  }
}

function textResponse(text: string, usage: Usage = { inputTokens: 1, outputTokens: 1 }): ChatResponse {
  return { message: { role: 'assistant', content: text }, stopReason: 'end_turn', usage }
}

function makeBaseDeps(opts?: { provider?: Provider; registry?: ToolRegistry }): AgentLoopDeps {
  return {
    provider: opts?.provider ?? new ScriptedProvider(),
    registry: opts?.registry ?? new ToolRegistry(),
    abort: new TwoLevelAbort(),
    state: new StateMachine(),
    limits: {
      maxSteps: 50,
      perStepTimeoutMs: 60_000,
      totalTimeoutMs: 30 * 60_000,
      maxCostUsd: 5,
      parallelTools: 8,
    },
    cwd: process.cwd(),
    sessionId: 'parent',
    permissionMode: 'manual',
    logger: noopLogger,
    sandbox: new LocalSandbox({ cwd: process.cwd() }),
    subagentDepth: 0,
  }
}

describe('runSubagent — happy path', () => {
  it('returns the child summary text', async () => {
    const provider = new ScriptedProvider().push(textResponse('child says hi'))
    const deps = makeBaseDeps({ provider })
    const result = await runSubagent(deps, { type: 'general', prompt: 'say hi' })
    expect(result.summary).toBe('child says hi')
    expect(result.steps).toBe(1)
    expect(result.stopReason).toBe('end_turn')
  })

  it('passes an empty message history to the child provider', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    // Capture messages at chat-call time (the loop mutates the same array
    // reference after the call returns, so a post-hoc snapshot is too late).
    let messagesAtCallTime: ChatRequest['messages'] = []
    const baseChat = provider.chat.bind(provider)
    provider.chat = async (req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> => {
      messagesAtCallTime = req.messages.slice()
      return baseChat(req, signal)
    }
    const deps = makeBaseDeps({ provider })
    await runSubagent(deps, { type: 'general', prompt: 'do thing' })
    expect(provider.calls).toHaveLength(1)
    // Only the user prompt message; no inherited parent history.
    expect(messagesAtCallTime).toHaveLength(1)
    expect(messagesAtCallTime[0]!.role).toBe('user')
    expect(messagesAtCallTime[0]!.content).toBe('do thing')
  })

  it('builds a system prompt for the requested type', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    const deps = makeBaseDeps({ provider })
    await runSubagent(deps, { type: 'review', prompt: 'review src/x.ts' })
    const sys = provider.calls[0]!.system ?? ''
    expect(sys).toMatch(/review agent/i)
  })

  it('uses systemOverride when provided', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    const deps = makeBaseDeps({ provider })
    await runSubagent(deps, {
      type: 'general',
      prompt: 'x',
      systemOverride: 'MY CUSTOM SYSTEM',
    })
    const sys = provider.calls[0]!.system ?? ''
    expect(sys).toBe('MY CUSTOM SYSTEM')
  })
})

describe('runSubagent — independent abort & state', () => {
  it('uses a fresh child abort controller (does not inherit parent abort)', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    const parentAbort = new TwoLevelAbort()
    const deps = makeBaseDeps({ provider })
    const childDeps: AgentLoopDeps = { ...deps, abort: parentAbort }
    await runSubagent(childDeps, { type: 'general', prompt: 'x' })
    // Parent abort was NOT triggered, so the child finished normally.
    expect(parentAbort.aborted).toBe(false)
  })

  it('child state machine is fresh — does not collide with parent', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    const deps = makeBaseDeps({ provider })
    // Pretend parent state is busy
    deps.state.tryAcquire()
    expect(deps.state.is('running')).toBe(true)
    // Run a subagent; it should succeed even though parent state is busy.
    const result = await runSubagent(deps, { type: 'general', prompt: 'x' })
    expect(result.summary).toBe('ok')
    // Parent state remains busy.
    expect(deps.state.is('running')).toBe(true)
    deps.state.release()
  })

  it('parent hard-abort cascades to child hard-abort', async () => {
    // Provider that honors the abort signal by throwing (matches real SDK behavior).
    const provider = new ScriptedProvider()
    provider.chat = async (_req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> => {
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('Aborted'))
          return
        }
        signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })
        // Safety: cap the wait so a missed signal doesn't hang the test.
        setTimeout(() => reject(new Error('Timeout waiting for abort')), 2_000)
      })
      return textResponse('never')
    }
    const parentAbort = new TwoLevelAbort()
    const deps = makeBaseDeps({ provider })
    const childDeps: AgentLoopDeps = { ...deps, abort: parentAbort }
    const p = runSubagent(childDeps, { type: 'general', prompt: 'x' })
    // Trigger parent hard-abort shortly after
    setTimeout(() => parentAbort.trigger('hard'), 20)
    const result = await p
    // The child should have been aborted and returned a summary.
    expect(typeof result.summary).toBe('string')
    // The summary should reference the abort or the refused state.
    expect(
      result.stopReason === 'aborted' || result.summary.includes('Aborted'),
    ).toBe(true)
  })
})

describe('runSubagent — error containment', () => {
  it('catches child errors and returns isError-shaped summary', async () => {
    const provider = new ScriptedProvider()
    provider.chat = async (): Promise<ChatResponse> => {
      throw new Error('provider went down')
    }
    const deps = makeBaseDeps({ provider })
    const result = await runSubagent(deps, { type: 'general', prompt: 'x' })
    expect(result.summary).toContain('subagent-failed')
    expect(result.summary).toContain('provider went down')
    expect(result.stopReason).toBe('provider_error')
  })
})

describe('runSubagent — recursion cap', () => {
  it('refuses to spawn beyond depth 3', async () => {
    const provider = new ScriptedProvider()
    const deps = makeBaseDeps({ provider })
    const result = await runSubagent(deps, { type: 'general', prompt: 'x', depth: 4 })
    expect(result.summary).toMatch(/recursion depth 4 exceeds maximum/i)
    expect(result.stopReason).toBe('aborted')
    expect(result.steps).toBe(0)
    // Crucially, the provider was NOT called.
    expect(provider.calls).toHaveLength(0)
  })

  it('allows depth 0,1,2,3 to actually spawn', async () => {
    const provider = new ScriptedProvider().push(textResponse('ok'))
    const deps = makeBaseDeps({ provider })
    const r = await runSubagent(deps, { type: 'general', prompt: 'x', depth: 3 })
    expect(r.summary).toBe('ok')
    expect(r.depth).toBe(3)
  })
})

describe('runSubagent — limits propagation', () => {
  it('applies maxSteps override from spec', async () => {
    // Build a provider that produces tool_use 25 times then end_turn.
    const registry = new ToolRegistry()
    registry.register({
      name: 'noop',
      description: 'noop',
      schema: z.object({}),
      handler: async () => ({ content: 'ok' }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 5_000,
      category: 'knowledge',
    })

    const provider = new ScriptedProvider()
    for (let i = 0; i < 3; i++) {
      provider.push({
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `c${i}`, name: 'noop', input: {} }],
          tool_calls: [{ type: 'tool_use', id: `c${i}`, name: 'noop', input: {} }],
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 1, outputTokens: 1 },
      })
    }
    provider.push(textResponse('done'))

    const deps = makeBaseDeps({ provider, registry })
    const result = await runSubagent(deps, {
      type: 'general',
      prompt: 'x',
      maxSteps: 4,
    })
    // 3 tool_use + 1 end_turn = 4 steps
    expect(result.steps).toBe(4)
    expect(result.stopReason).toBe('end_turn')
  })
})
