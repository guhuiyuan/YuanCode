/**
 * Permission Gate — full mode × risk × category matrix.
 *
 * The matrix covers 4 modes × 3 risks × 2 representative categories (file, shell).
 * Plus: session cache short-circuit, project rules, onAsk fallback.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolEntry } from '../../../src/core/tool-registry.js'
import {
  PermissionGate,
  decideByMode,
} from '../../../src/core/permission-gate.js'

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

describe('decideByMode — pure matrix', () => {
  const cases: Array<{
    mode: 'manual' | 'acceptEdits' | 'auto' | 'plan'
    risk: 'low' | 'medium' | 'high'
    category: ToolEntry['category']
    expected: 'allow' | 'deny' | 'ask'
  }> = [
    // auto: everything allowed
    { mode: 'auto', risk: 'low', category: 'file', expected: 'allow' },
    { mode: 'auto', risk: 'high', category: 'shell', expected: 'allow' },
    { mode: 'auto', risk: 'medium', category: 'search', expected: 'allow' },

    // plan: only read-only allowed; file + shell denied
    { mode: 'plan', risk: 'low', category: 'search', expected: 'allow' },
    { mode: 'plan', risk: 'low', category: 'plan', expected: 'allow' },
    { mode: 'plan', risk: 'low', category: 'file', expected: 'deny' },
    { mode: 'plan', risk: 'high', category: 'shell', expected: 'deny' },

    // acceptEdits: file allowed; shell asks unless low
    { mode: 'acceptEdits', risk: 'low', category: 'file', expected: 'allow' },
    { mode: 'acceptEdits', risk: 'high', category: 'file', expected: 'allow' },
    { mode: 'acceptEdits', risk: 'low', category: 'shell', expected: 'allow' },
    { mode: 'acceptEdits', risk: 'medium', category: 'shell', expected: 'ask' },
    { mode: 'acceptEdits', risk: 'high', category: 'shell', expected: 'ask' },

    // manual: low allowed, medium+high ask
    { mode: 'manual', risk: 'low', category: 'file', expected: 'allow' },
    { mode: 'manual', risk: 'low', category: 'shell', expected: 'allow' },
    { mode: 'manual', risk: 'medium', category: 'file', expected: 'ask' },
    { mode: 'manual', risk: 'high', category: 'file', expected: 'ask' },
    { mode: 'manual', risk: 'high', category: 'shell', expected: 'ask' },
  ]

  for (const c of cases) {
    it(`${c.mode} + risk=${c.risk} + cat=${c.category} → ${c.expected}`, () => {
      const d = decideByMode(c.mode, c.risk, c.category)
      expect(d.action).toBe(c.expected)
      expect(d.reason).toMatch(new RegExp(`^mode=${c.mode}`))
    })
  }
})

describe('PermissionGate — session cache', () => {
  it('short-circuits when tool was previously allowed', async () => {
    const gate = new PermissionGate({ mode: 'manual' })
    gate.cacheOnce('bash', 'allow')
    const d = await gate.decide(entry({ name: 'bash', risk: 'high', category: 'shell' }), {})
    expect(d.action).toBe('allow')
    expect(d.reason).toMatch(/session cache/)
  })

  it('short-circuits when tool was previously denied', async () => {
    const gate = new PermissionGate({ mode: 'auto' })
    gate.cacheOnce('bash', 'deny')
    const d = await gate.decide(entry({ name: 'bash', risk: 'low' }), {})
    expect(d.action).toBe('deny')
  })

  it('resetCache wipes all session overrides', async () => {
    const gate = new PermissionGate({ mode: 'auto' })
    gate.cacheOnce('bash', 'deny')
    gate.resetCache()
    expect(gate.getCached('bash')).toBeUndefined()
    const d = await gate.decide(entry({ name: 'bash', risk: 'low' }), {})
    expect(d.action).toBe('allow') // auto now wins
  })

  it('getCached returns undefined for unknown tools', () => {
    const gate = new PermissionGate({ mode: 'auto' })
    expect(gate.getCached('nothing')).toBeUndefined()
  })
})

describe('PermissionGate — project rules', () => {
  it('exact-match rule overrides mode', async () => {
    const gate = new PermissionGate({
      mode: 'auto',
      rules: [{ toolName: 'bash', action: 'deny' }],
    })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high' }), {})
    expect(d.action).toBe('deny')
    expect(d.reason).toMatch(/rule:/)
  })

  it('regex toolName matches multiple tools', async () => {
    const gate = new PermissionGate({
      mode: 'auto',
      rules: [{ toolName: /^file_/, action: 'ask' }],
    })
    const d1 = await gate.decide(entry({ name: 'file_read', risk: 'low' }), {})
    const d2 = await gate.decide(entry({ name: 'other', risk: 'low' }), {})
    expect(d1.action).toBe('ask')
    expect(d2.action).toBe('allow') // auto still applies
  })

  it('inputMatcher can restrict the rule to specific inputs', async () => {
    const gate = new PermissionGate({
      mode: 'auto',
      rules: [
        { toolName: 'bash', inputMatcher: /rm -rf/, action: 'deny' },
      ],
    })
    const dangerous = await gate.decide(
      entry({ name: 'bash', risk: 'high' }),
      { command: 'rm -rf /' },
    )
    const safe = await gate.decide(
      entry({ name: 'bash', risk: 'high' }),
      { command: 'echo hello' },
    )
    expect(dangerous.action).toBe('deny')
    expect(safe.action).toBe('allow')
  })

  it('non-matching rules fall through to mode matrix', async () => {
    const gate = new PermissionGate({
      mode: 'auto',
      rules: [{ toolName: 'bash', action: 'deny' }],
    })
    const d = await gate.decide(entry({ name: 'read', risk: 'low' }), {})
    expect(d.action).toBe('allow')
  })
})

describe('PermissionGate — onAsk fallback', () => {
  it('uses onAsk when the matrix returns ask', async () => {
    const gate = new PermissionGate({
      mode: 'manual',
      onAsk: async () => 'allow',
    })
    const d = await gate.decide(entry({ name: 'bash', risk: 'high' }), {})
    expect(d.action).toBe('allow')
    expect(d.reason).toMatch(/user prompt/)
  })

  it('passes the tool entry to onAsk for context', async () => {
    let receivedName = ''
    const gate = new PermissionGate({
      mode: 'manual',
      onAsk: async (t) => {
        receivedName = t.name
        return 'deny'
      },
    })
    await gate.decide(entry({ name: 'webfetch', risk: 'medium' }), {})
    expect(receivedName).toBe('webfetch')
  })

  it('default onAsk returns ask (loop semantics)', async () => {
    // Default constructor wires onAsk to return 'ask' so the loop can surface it.
    // We just verify the default by calling decide and checking the action.
    const gate = new PermissionGate({ mode: 'manual' })
    const d = await gate.decide(entry({ name: 'high_tool', risk: 'high' }), {})
    expect(d.action).toBe('ask')
  })
})
