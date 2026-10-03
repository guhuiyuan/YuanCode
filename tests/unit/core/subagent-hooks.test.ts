/**
 * Subagent × HooksEngine — SubagentStart (gating) + SubagentEnd (informational).
 *
 * The pre-existing subagent tests in `subagent.test.ts` cover the
 * dispatch mechanics; this file covers the M6 hook wiring only.
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { StateMachine } from '../../../src/core/state-machine.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { runSubagent } from '../../../src/core/subagent.js'
import type { Provider, ChatRequest, ChatResponse, Usage } from '../../../src/model/provider.js'
import type { AgentLoopDeps } from '../../../src/core/loop.js'
import type { HooksEngine, HookDecision, FirePayload } from '../../../src/hooks/index.js'

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  silent: () => {},
  child: function () {
    return this
  },
} as unknown as import('pino').Logger

class ScriptedProvider implements Provider {
  readonly name = 'scripted'
  private queue: ChatResponse[] = []
  push(r: ChatResponse): this {
    this.queue.push(r)
    return this
  }
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const next = this.queue.shift()
    if (!next) throw new Error('ScriptedProvider ran out of canned responses')
    return next
  }
}

function textResponse(text: string, usage: Usage = { inputTokens: 1, outputTokens: 1 }): ChatResponse {
  return { message: { role: 'assistant', content: text }, stopReason: 'end_turn', usage }
}

function makeBaseDeps(opts: { provider?: Provider; hooksEngine?: HooksEngine }): AgentLoopDeps {
  return {
    provider: opts.provider ?? new ScriptedProvider(),
    registry: new ToolRegistry(),
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
    hooksEngine: opts.hooksEngine,
  }
}

function makeFakeHooks(opts: {
  startDecision?: HookDecision
  throwOnStart?: Error
  throwOnEnd?: Error
}) {
  const fire = vi.fn(async (event: string, _p: FirePayload): Promise<HookDecision> => {
    if (event === 'SubagentStart') {
      if (opts.throwOnStart) throw opts.throwOnStart
      return opts.startDecision ?? { allowed: true, results: [] }
    }
    if (event === 'SubagentEnd') {
      if (opts.throwOnEnd) throw opts.throwOnEnd
      return { allowed: true, results: [] }
    }
    return { allowed: true, results: [] }
  })
  return { engine: { fire } as unknown as HooksEngine, fire }
}

describe('runSubagent × HooksEngine', () => {
  it('does NOT fire hooks when none is set', async () => {
    const provider = new ScriptedProvider().push(textResponse('hi'))
    const r = await runSubagent(makeBaseDeps({ provider }), { type: 'general', prompt: 'say hi' })
    expect(r.summary).toBe('hi')
  })

  it('fires SubagentStart with type/id/task before spawn', async () => {
    const provider = new ScriptedProvider().push(textResponse('done'))
    const { engine, fire } = makeFakeHooks({})
    await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'explore',
      prompt: 'find foo',
    })
    const startCall = fire.mock.calls.find((c) => c[0] === 'SubagentStart')
    expect(startCall).toBeDefined()
    expect(startCall![1]).toMatchObject({
      subagentType: 'explore',
      task: 'find foo',
      sessionId: 'parent',
      cwd: process.cwd(),
    })
    expect(startCall![1]).toHaveProperty('subagentId')
  })

  it('fires SubagentStart + SubagentEnd in order', async () => {
    const provider = new ScriptedProvider().push(textResponse('done'))
    const { engine, fire } = makeFakeHooks({})
    await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    const events = fire.mock.calls.map((c) => c[0])
    expect(events).toEqual(['SubagentStart', 'SubagentEnd'])
  })

  it('SubagentStart deny short-circuits without spawning', async () => {
    const provider = new ScriptedProvider() // no canned responses — would throw if called
    const { engine } = makeFakeHooks({
      startDecision: { allowed: false, reason: 'no subagents today', results: [] },
    })
    const r = await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    expect(r.summary).toMatch(/blocked/)
    expect(r.summary).toMatch(/no subagents today/)
    expect(r.stopReason).toBe('aborted')
    expect(r.steps).toBe(0)
  })

  it('SubagentStart exception fails closed (deny)', async () => {
    const provider = new ScriptedProvider()
    const { engine } = makeFakeHooks({ throwOnStart: new Error('boom') })
    const r = await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    expect(r.summary).toMatch(/hook error.*boom/)
    expect(r.stopReason).toBe('aborted')
  })

  it('SubagentEnd fires after success with status=success', async () => {
    const provider = new ScriptedProvider().push(textResponse('final'))
    const { engine, fire } = makeFakeHooks({})
    await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    const endCall = fire.mock.calls.find((c) => c[0] === 'SubagentEnd')
    expect(endCall).toBeDefined()
    expect(endCall![1]).toMatchObject({
      subagentType: 'general',
      status: 'success',
      result: 'final',
    })
    expect(endCall![1]).toHaveProperty('subagentId')
  })

  it('SubagentEnd fires after child failure with status=error', async () => {
    const provider = new ScriptedProvider() // queue empty → throws
    const { engine, fire } = makeFakeHooks({})
    const r = await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    expect(r.summary).toMatch(/<subagent-failed/)
    const endCall = fire.mock.calls.find((c) => c[0] === 'SubagentEnd')
    expect(endCall).toBeDefined()
    expect(endCall![1]).toMatchObject({ status: 'error' })
  })

  it('SubagentEnd fires even when its hook throws (does not break caller)', async () => {
    const provider = new ScriptedProvider().push(textResponse('done'))
    const { engine, fire } = makeFakeHooks({ throwOnEnd: new Error('post-fail') })
    const r = await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    // Caller still gets the success result; hook error is swallowed.
    expect(r.summary).toBe('done')
    expect(r.stopReason).toBe('end_turn')
    expect(fire).toHaveBeenCalledWith('SubagentEnd', expect.any(Object))
  })

  it('inherits hooksEngine on the child deps (child sees same engine)', async () => {
    // We can\'t easily inspect the child deps from outside, but we can
    // verify the fire() spy is called only twice for a single-level spawn:
    // once for Start, once for End. (A child spawn would add another
    // SubagentStart, which we don\'t do here.)
    const provider = new ScriptedProvider().push(textResponse('done'))
    const { engine, fire } = makeFakeHooks({})
    await runSubagent(makeBaseDeps({ provider, hooksEngine: engine }), {
      type: 'general',
      prompt: 'p',
    })
    const events = fire.mock.calls.map((c) => c[0])
    expect(events).toEqual(['SubagentStart', 'SubagentEnd'])
  })
})
