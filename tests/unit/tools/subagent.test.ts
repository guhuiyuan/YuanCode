/**
 * subagent tool — schema, handler, error propagation, depth tracking.
 */
import { describe, expect, it } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { makeSubagentTool } from '../../../src/tools/subagent.js'
import type { ToolContext } from '../../../src/core/tool-registry.js'
import type { AgentLoopDeps } from '../../../src/core/loop.js'
import type { SubagentSpec } from '../../../src/core/subagent.js'

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

function makeCtx(): ToolContext {
  return {
    cwd: process.cwd(),
    sandbox: new LocalSandbox({ cwd: process.cwd() }),
    abort: new TwoLevelAbort(),
    sessionId: 'parent',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

function makeDeps(opts?: { subagentDepth?: number }): AgentLoopDeps {
  return {
    provider: {} as AgentLoopDeps['provider'],
    registry: {} as AgentLoopDeps['registry'],
    abort: new TwoLevelAbort(),
    state: {} as AgentLoopDeps['state'],
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
    subagentDepth: opts?.subagentDepth ?? 0,
  }
}

describe('subagent tool — schema', () => {
  it('has the expected shape', () => {
    const tool = makeSubagentTool({ getParentDeps: () => makeDeps() })
    expect(tool.name).toBe('subagent')
    expect(tool.risk).toBe('medium')
    expect(tool.parallelSafe).toBe(false)
    expect(tool.category).toBe('agent')
    expect(tool.schema.safeParse({ type: 'general', prompt: 'x' }).success).toBe(true)
  })

  it('rejects empty prompt', () => {
    const tool = makeSubagentTool({ getParentDeps: () => makeDeps() })
    const r = tool.schema.safeParse({ type: 'general', prompt: '' })
    expect(r.success).toBe(false)
  })

  it('defaults type to general', () => {
    const tool = makeSubagentTool({ getParentDeps: () => makeDeps() })
    const r = tool.schema.safeParse({ prompt: 'x' })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.type).toBe('general')
  })
})

describe('subagent tool — handler', () => {
  it('invokes the factory with depth = parentDepth + 1', async () => {
    const seen: SubagentSpec[] = []
    const factory = async (
      _parent: AgentLoopDeps,
      spec: SubagentSpec,
    ): Promise<{ summary: string; subagentId?: string; steps?: number; stopReason?: string }> => {
      seen.push(spec)
      return { summary: 'fake summary', subagentId: 'x', steps: 1, stopReason: 'end_turn' }
    }
    const tool = makeSubagentTool({ factory, getParentDeps: () => makeDeps({ subagentDepth: 2 }) })
    const r = await tool.handler({ type: 'explore', prompt: 'find files' }, makeCtx())
    expect(r.isError).toBeFalsy()
    expect(seen).toHaveLength(1)
    expect(seen[0]?.type).toBe('explore')
    expect(seen[0]?.depth).toBe(3)
    expect(r.content).toContain('<subagent-result')
    expect(r.content).toContain('fake summary')
    expect(r.content).toContain('depth="3"')
  })

  it('starts at depth 1 when parent depth is 0', async () => {
    const seen: SubagentSpec[] = []
    const factory = async (
      _parent: AgentLoopDeps,
      spec: SubagentSpec,
    ): Promise<{ summary: string }> => {
      seen.push(spec)
      return { summary: 'ok' }
    }
    const tool = makeSubagentTool({ factory, getParentDeps: () => makeDeps({ subagentDepth: 0 }) })
    await tool.handler({ type: 'general', prompt: 'x' }, makeCtx())
    expect(seen[0]?.depth).toBe(1)
  })

  it('wraps factory errors into isError tool_result', async () => {
    const factory = async (): Promise<{ summary: string }> => {
      throw new Error('factory boom')
    }
    const tool = makeSubagentTool({ factory, getParentDeps: () => makeDeps() })
    // The factory throws → runSubagent-style wrapper would catch — but our
    // test factory isn't wrapped. The tool re-throws because it awaits
    // directly. To validate the production path, use the real runSubagent
    // and verify error capture via the spec's recursion refusal (handled
    // by runSubagent itself, not the tool).
    //
    // Here we just assert that unhandled factory throws DO surface as
    // exceptions from the tool handler (so the registry's execute()
    // wrapper turns them into isError tool_results).
    await expect(tool.handler({ type: 'general', prompt: 'x' }, makeCtx())).rejects.toThrow(
      /factory boom/,
    )
  })

  it('uses runSubagent by default (depth recursion refusal)', async () => {
    // Make the parent report a very deep subagentDepth so runSubagent
    // refuses with a summary message.
    const tool = makeSubagentTool({ getParentDeps: () => makeDeps({ subagentDepth: 4 }) })
    // depth = 4+1 = 5; runSubagent caps at 3, so the in-factory refusal
    // returns a summary instead of throwing. The tool returns that as
    // normal content (not isError) — the parent agent sees the refusal
    // text and can act on it.
    const r = await tool.handler({ type: 'general', prompt: 'x' }, makeCtx())
    expect(r.content).toMatch(/recursion depth 5 exceeds maximum/i)
  })
})
