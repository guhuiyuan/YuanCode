/**
 * AgentLoop tests — uses a scripted mock provider so no network is required.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { StateMachine } from '../../../src/core/state-machine.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { runAgentLoop } from '../../../src/core/loop.js'
import { makeBashTool } from '../../../src/tools/bash.js'
import type { Provider, ChatResponse, ChatMessage, ChatRequest, StopReason, Usage } from '../../../src/model/provider.js'

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

const TMP = join(tmpdir(), `yuancode-loop-${Date.now()}`)
mkdirSync(TMP, { recursive: true })
const isWin = process.platform === 'win32'

/** A scripted provider that returns the next canned response on each chat() call. */
class ScriptedProvider implements Provider {
  readonly name = 'scripted'
  private queue: ChatResponse[] = []
  private calls: ChatRequest[] = []
  /** If set, chat() awaits this signal-aborted promise before returning. */
  blockOn: AbortSignal | null = null

  push(r: ChatResponse): this {
    this.queue.push(r)
    return this
  }

  callsMade(): ChatRequest[] {
    return this.calls
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    this.calls.push(req)
    const next = this.queue.shift()
    if (!next) {
      throw new Error('ScriptedProvider ran out of canned responses')
    }
    // Only block if explicitly opted-in via blockOn (used by the abort test).
    // Otherwise respond immediately so non-abort tests don't hang.
    if (this.blockOn) {
      const blk = this.blockOn
      const aborted = await new Promise<boolean>((resolve) => {
        if (blk.aborted) return resolve(true)
        blk.addEventListener('abort', () => resolve(true), { once: true })
        // Safety: if nothing fires within 5s, resolve as not-aborted.
        setTimeout(() => resolve(false), 5000)
      })
      if (aborted) {
        // Mimic real SDK behavior — throw on abort so the loop catches it.
        const e = new Error('Request aborted')
        e.name = 'AbortError'
        throw e
      }
    }
    return next
  }
}

function textResponse(text: string, opts?: { stopReason?: StopReason; usage?: Usage }): ChatResponse {
  return {
    message: { role: 'assistant', content: text },
    stopReason: opts?.stopReason ?? 'end_turn',
    usage: opts?.usage ?? { inputTokens: 10, outputTokens: 5 },
  }
}

function toolCallResponse(
  calls: Array<{ id: string; name: string; input: unknown }>,
  opts?: { usage?: Usage },
): ChatResponse {
  return {
    message: {
      role: 'assistant',
      content: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
      tool_calls: calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    },
    stopReason: 'tool_use',
    usage: opts?.usage ?? { inputTokens: 10, outputTokens: 5 },
  }
}

const echoSchema = z.object({ text: z.string() })

describe('runAgentLoop', () => {
  it('terminates on end_turn after one step', async () => {
    const provider = new ScriptedProvider().push(textResponse('hello'))
    const registry = new ToolRegistry()
    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's1',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox: new LocalSandbox({ cwd: TMP }),
      },
      { system: 'be terse', prompt: 'hi' },
    )
    expect(result.stopReason).toBe('end_turn')
    expect(result.steps).toBe(1)
    expect((result.finalMessage.content as string)).toBe('hello')
  })

  it('runs a tool call round-trip and feeds the result back to the model', async () => {
    const sandbox = new LocalSandbox({ cwd: TMP })
    const registry = new ToolRegistry()
    registry.register(makeBashTool(sandbox))
    // Add a stub tool that echoes its input — used to verify the loop passes
    // tool results back as content blocks (not strings).
    registry.register({
      name: 'echo',
      description: 'echo input',
      schema: echoSchema,
      handler: async (input) => ({ content: input.text }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })

    const provider = new ScriptedProvider()
      .push(toolCallResponse([{ id: 't1', name: 'echo', input: { text: 'first' } }]))
      .push(textResponse('final answer'))

    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's2',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox,
      },
      { system: '', prompt: 'go' },
    )

    expect(result.stopReason).toBe('end_turn')
    expect(result.steps).toBe(2)

    // The user message after the tool call must contain a tool_result block,
    // not a stringified copy.
    const lastUserMsg = result.messages.findLast((m) => m.role === 'user') as ChatMessage
    const blocks = lastUserMsg.content as Array<{ type: string; tool_use_id?: string; content?: string }>
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]?.type).toBe('tool_result')
    expect(blocks[0]?.tool_use_id).toBe('t1')
    expect(blocks[0]?.content).toBe('first')
  })

  it('runs a real bash tool call', async () => {
    const sandbox = new LocalSandbox({ cwd: TMP })
    const registry = new ToolRegistry()
    registry.register(makeBashTool(sandbox))
    const provider = new ScriptedProvider()
      .push(toolCallResponse([{ id: 'b1', name: 'bash', input: { command: 'echo shell-works' } }]))
      .push(textResponse('done'))

    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's3',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox,
      },
      { system: '', prompt: 'run echo' },
    )
    expect(result.stopReason).toBe('end_turn')

    // Find the tool_result in messages and verify the shell ran
    const resultBlocks = result.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content as Array<{ type: string; content?: string }>)
      .filter((b) => b.type === 'tool_result')
    expect(resultBlocks.length).toBeGreaterThanOrEqual(1)
    expect(resultBlocks.some((b) => b.content?.includes('shell-works'))).toBe(true)
  })

  it('respects maxSteps limit', async () => {
    const provider = new ScriptedProvider()
    // Always request the same tool call so the loop never naturally ends.
    for (let i = 0; i < 10; i++) {
      provider.push(toolCallResponse([{ id: `t${i}`, name: 'echo', input: { text: String(i) } }]))
    }
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echo',
      schema: echoSchema,
      handler: async (input) => ({ content: input.text }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 3, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's4',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox: new LocalSandbox({ cwd: TMP }),
      },
      { system: '', prompt: 'loop' },
    )
    expect(result.stopReason).toBe('max_steps')
    expect(result.steps).toBe(3)
  })

  it('aborts cleanly when the abort controller fires', async () => {
    const ctrl = new TwoLevelAbort()
    const provider = new ScriptedProvider()
    for (let i = 0; i < 10; i++) {
      provider.push(textResponse('x'))
    }
    // Make every chat() call wait until the hard signal aborts.
    provider.blockOn = ctrl.hardSignal
    // Hard abort fires the signal that the (blocking) provider is listening on.
    setTimeout(() => ctrl.trigger('hard'), 20)
    const registry = new ToolRegistry()
    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: ctrl,
        state: new StateMachine(),
        limits: { maxSteps: 10, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's5',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox: new LocalSandbox({ cwd: TMP }),
      },
      { system: '', prompt: 'ab' },
    )
    expect(result.stopReason).toBe('aborted')
  })

  // ---------- M5 — MAINTENANCE background-notifications drain ----------

  it('drains background-task notifications as a synthetic user message', async () => {
    const { BackgroundTaskPool } = await import('../../../src/core/background-tasks.js')
    const sandbox = new LocalSandbox({ cwd: TMP })
    const registry = new ToolRegistry()
    registry.register({
      name: 'echo',
      description: 'echo',
      schema: echoSchema,
      handler: async (input: { text: string }) => ({ content: `echo:${input.text}` }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1_000,
      category: 'knowledge',
    })

    const abort = new TwoLevelAbort()
    const pool = new BackgroundTaskPool({ abort })

    // Pre-populate a completed task so the first MAINTENANCE window has
    // something to drain. We bypass the registry here and craft the task
    // shape directly via an inline start.
    const toolCtx = {
      cwd: TMP,
      sandbox,
      abort,
      sessionId: 's6',
      permissionMode: 'auto' as const,
      logger: noopLogger,
    }
    const id = await pool.start({ tool: 'echo', args: { text: 'bg-finished' }, ctx: toolCtx }, registry)
    // Wait for the task to complete and be queued for notification.
    for (let i = 0; i < 100; i++) {
      if (pool.check(id)?.status === 'done') break
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(pool.check(id)?.status).toBe('done')

    // Scripted loop: first call returns a tool_use, second call ends.
    const provider = new ScriptedProvider()
      .push(toolCallResponse([{ id: 't1', name: 'echo', input: { text: 'foreground' } }]))
      .push(textResponse('noted background completion'))

    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort,
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's6',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox,
        bgTaskPool: pool,
      },
      { system: '', prompt: 'start' },
    )

    // Find the synthetic background-notifications message.
    const notifMsg = result.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('<background-notifications>'),
    )
    expect(notifMsg).toBeDefined()
    const body = notifMsg!.content as string
    expect(body).toContain(`id="${id}"`)
    expect(body).toContain('echo:bg-finished')
  })

  it('does not inject a notifications message when the pool is empty', async () => {
    const { BackgroundTaskPool } = await import('../../../src/core/background-tasks.js')
    const registry = new ToolRegistry()
    const pool = new BackgroundTaskPool({ abort: new TwoLevelAbort() })
    const provider = new ScriptedProvider()
      .push(toolCallResponse([{ id: 't1', name: 'echo', input: { text: 'x' } }]))
      .push(textResponse('done'))

    const result = await runAgentLoop(
      {
        provider,
        registry,
        abort: new TwoLevelAbort(),
        state: new StateMachine(),
        limits: { maxSteps: 5, totalTimeoutMs: 60_000, perStepTimeoutMs: 10_000, maxCostUsd: 1, parallelTools: 4 },
        cwd: TMP,
        sessionId: 's7',
        permissionMode: 'auto',
        logger: noopLogger,
        sandbox: new LocalSandbox({ cwd: TMP }),
        bgTaskPool: pool,
      },
      { system: '', prompt: 'go' },
    )

    const notifMsg = result.messages.find(
      (m) =>
        m.role === 'user' &&
        typeof m.content === 'string' &&
        m.content.includes('<background-notifications>'),
    )
    expect(notifMsg).toBeUndefined()
  })
})

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

import { afterAll } from 'vitest'
