/**
 * PermissionGate × HooksEngine — 3-stage pipeline (mode → hooks → ask) +
 * 'mcp' category handling.
 *
 * The pre-existing matrix tests live in `permission-gate.test.ts`; this
 * file covers the M6 additions only:
 *
 *   - hook veto can deny a mode 'allow'
 *   - hook pre-approve can promote a mode 'ask' to 'allow'
 *   - hook errors fail-closed (deny)
 *   - no hooksEngine → behaviour identical to M1-M5
 *   - 'mcp' category in plan mode + auto mode + manual mode
 */
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import type { ToolEntry } from '../../../src/core/tool-registry.js'
import { PermissionGate, decideByMode } from '../../../src/core/permission-gate.js'
import type { HooksEngine, HookDecision, FirePayload, HookResult } from '../../../src/hooks/index.js'

const schema = z.object({})

function entry(overrides: Partial<ToolEntry>): ToolEntry {
  return {
    name: 'sample',
    description: 'd',
    schema,
    handler: async () => ({ content: '' }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 1000,
    category: 'knowledge',
    ...overrides,
  }
}

function makeFakeHooks(opts: {
  decision?: HookDecision
  throwOnFire?: Error
}) {
  const fire = vi.fn(async (_event: string, _p: FirePayload): Promise<HookDecision> => {
    if (opts.throwOnFire) throw opts.throwOnFire
    return opts.decision ?? { allowed: true, results: [] }
  })
  return { engine: { fire } as unknown as HooksEngine, fire }
}

const approvedResult: HookResult = {
  hookId: 'h1',
  event: 'PreToolUse',
  type: 'bash',
  matcher: null,
  outcome: 'approve',
  durationMs: 0,
}

const deniedResult: HookResult = {
  hookId: 'h1',
  event: 'PreToolUse',
  type: 'bash',
  matcher: null,
  outcome: 'deny',
  reason: 'policy violation',
  durationMs: 0,
}

// ---------------------------------------------------------------------------
// 3-stage pipeline
// ---------------------------------------------------------------------------

describe('PermissionGate × HooksEngine — 3-stage pipeline', () => {
  it('without hooksEngine: behaviour identical to M1-M5 (no fire call)', async () => {
    const gate = new PermissionGate({ mode: 'auto' })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high', category: 'shell' }), {})
    expect(d.action).toBe('allow')
  })

  it('hook veto denies an auto-mode allow', async () => {
    const { engine, fire } = makeFakeHooks({
      decision: { allowed: false, reason: 'policy', results: [deniedResult] },
    })
    const gate = new PermissionGate({ mode: 'auto', hooksEngine: engine })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high', category: 'shell' }), {})
    expect(d.action).toBe('deny')
    expect(d.reason).toMatch(/hook veto.*policy/)
    expect(fire).toHaveBeenCalledWith(
      'PreToolUse',
      expect.objectContaining({ toolName: 'bash' }),
    )
  })

  it('hook approve promotes an ask to allow', async () => {
    const { engine } = makeFakeHooks({
      decision: { allowed: true, results: [approvedResult] },
    })
    // acceptEdits + shell + high → ask. Hook approve → allow.
    const gate = new PermissionGate({ mode: 'acceptEdits', hooksEngine: engine })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high', category: 'shell' }), {})
    expect(d.action).toBe('allow')
    expect(d.reason).toMatch(/hook pre-approved/)
  })

  it('hook allow without approve keeps an ask as ask (no auto-promote)', async () => {
    const { engine } = makeFakeHooks({
      decision: { allowed: true, results: [] },
    })
    const gate = new PermissionGate({ mode: 'manual', hooksEngine: engine })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high', category: 'shell' }), {})
    expect(d.action).toBe('ask')
  })

  it('hook error fails closed (deny)', async () => {
    const { engine } = makeFakeHooks({ throwOnFire: new Error('boom') })
    const gate = new PermissionGate({ mode: 'auto', hooksEngine: engine })
    const d = await gate.decide(entry({ name: 'read', risk: 'low' }), {})
    expect(d.action).toBe('deny')
    expect(d.reason).toMatch(/fail-closed/)
    expect(d.reason).toMatch(/boom/)
  })

  it('session cache short-circuits BEFORE hooks (no fire call)', async () => {
    const { engine, fire } = makeFakeHooks({
      decision: { allowed: false, reason: 'should-not-matter', results: [deniedResult] },
    })
    const gate = new PermissionGate({ mode: 'auto', hooksEngine: engine })
    gate.cacheOnce('bash', 'allow')
    const d = await gate.decide(entry({ name: 'bash', risk: 'high' }), {})
    expect(d.action).toBe('allow')
    expect(d.reason).toMatch(/session cache/)
    expect(fire).not.toHaveBeenCalled()
  })

  it('project rule short-circuits BEFORE hooks (no fire call)', async () => {
    const { engine, fire } = makeFakeHooks({
      decision: { allowed: false, results: [deniedResult] },
    })
    const gate = new PermissionGate({
      mode: 'auto',
      hooksEngine: engine,
      rules: [{ toolName: 'bash', action: 'deny' }],
    })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high' }), {})
    expect(d.action).toBe('deny')
    expect(d.reason).toMatch(/rule:/)
    expect(fire).not.toHaveBeenCalled()
  })

  it('hook veto fires even when mode already said deny (defence in depth)', async () => {
    // plan + file → mode already denies. Hook should still be consulted so
    // users can audit every tool attempt. The hook's deny result is a no-op
    // since we're already denying.
    const { engine, fire } = makeFakeHooks({
      decision: { allowed: false, results: [deniedResult] },
    })
    const gate = new PermissionGate({ mode: 'plan', hooksEngine: engine })
    const d = await gate.decide(entry({ name: 'edit', risk: 'high', category: 'file' }), {})
    expect(d.action).toBe('deny')
    expect(fire).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// 'mcp' category in the mode matrix
// ---------------------------------------------------------------------------

describe('decideByMode — mcp category', () => {
  it('auto + mcp + any risk → allow', () => {
    expect(decideByMode('auto', 'low', 'mcp').action).toBe('allow')
    expect(decideByMode('auto', 'high', 'mcp').action).toBe('allow')
  })

  it('plan + mcp + low → allow (read-only MCP typical)', () => {
    expect(decideByMode('plan', 'low', 'mcp').action).toBe('allow')
  })

  it('plan + mcp + medium → deny (audit but no exec)', () => {
    expect(decideByMode('plan', 'medium', 'mcp').action).toBe('deny')
  })

  it('plan + mcp + high → deny', () => {
    expect(decideByMode('plan', 'high', 'mcp').action).toBe('deny')
  })

  it('acceptEdits + mcp + low → allow', () => {
    expect(decideByMode('acceptEdits', 'low', 'mcp').action).toBe('allow')
  })

  it('acceptEdits + mcp + medium → ask', () => {
    expect(decideByMode('acceptEdits', 'medium', 'mcp').action).toBe('ask')
  })

  it('manual + mcp + low → allow', () => {
    expect(decideByMode('manual', 'low', 'mcp').action).toBe('allow')
  })

  it('manual + mcp + high → ask', () => {
    expect(decideByMode('manual', 'high', 'mcp').action).toBe('ask')
  })
})
