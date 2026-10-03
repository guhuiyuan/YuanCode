/**
 * Tool Registry + Zod → JSON Schema unit tests.
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { ToolRegistry, TimeoutError } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { zodToJsonSchema } from '../../../src/core/zod-to-json.js'

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

function makeCtx() {
  const sandbox = new LocalSandbox({ cwd: process.cwd() })
  return {
    ctx: {
      cwd: process.cwd(),
      sandbox,
      abort: new TwoLevelAbort(),
      sessionId: 'test-session',
      permissionMode: 'manual' as const,
      logger: noopLogger,
    },
    sandbox,
  }
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('registers a tool and exposes it via list/get', () => {
    const schema = z.object({ x: z.number() })
    registry.register({
      name: 'echo',
      description: 'Echoes x back',
      schema,
      handler: async (input) => ({ content: `got ${input.x}` }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    expect(registry.has('echo')).toBe(true)
    expect(registry.get('echo')?.name).toBe('echo')
    expect(registry.list()).toHaveLength(1)
  })

  it('rejects duplicate registrations', () => {
    const schema = z.object({})
    const entry = {
      name: 'dup',
      description: 'd',
      schema,
      handler: async () => ({ content: '' }),
      risk: 'low' as const,
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'plan' as const,
    }
    registry.register(entry)
    expect(() => registry.register(entry)).toThrow(/already registered/)
  })

  it('rejects uppercase tool names', () => {
    const schema = z.object({})
    expect(() =>
      registry.register({
        name: 'BadName',
        description: 'd',
        schema,
        handler: async () => ({ content: '' }),
        risk: 'low',
        parallelSafe: true,
        timeoutMs: 1000,
        category: 'plan',
      }),
    ).toThrow(/lowercase/)
  })

  it('rejects names with hyphens', () => {
    const schema = z.object({})
    expect(() =>
      registry.register({
        name: 'bad-name',
        description: 'd',
        schema,
        handler: async () => ({ content: '' }),
        risk: 'low',
        parallelSafe: true,
        timeoutMs: 1000,
        category: 'plan',
      }),
    ).toThrow(/\[a-z\]\[a-z0-9_\]\*\$/)
  })

  it('returns an error tool_result for unknown tool name', async () => {
    const { ctx } = makeCtx()
    const r = await registry.execute('does_not_exist', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not registered/)
  })

  it('returns an error tool_result for invalid input', async () => {
    const { ctx } = makeCtx()
    registry.register({
      name: 'add',
      description: 'add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async (input) => ({ content: String(input.a + input.b) }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const r = await registry.execute('add', { a: 'not a number' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Invalid input/)
  })

  it('runs a valid call and returns the handler output', async () => {
    const { ctx } = makeCtx()
    registry.register({
      name: 'add',
      description: 'add two numbers',
      schema: z.object({ a: z.number(), b: z.number() }),
      handler: async (input) => ({ content: String(input.a + input.b) }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const r = await registry.execute('add', { a: 2, b: 3 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toBe('5')
    expect(r.tool).toBe('add')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('times out long-running handlers and returns isError', async () => {
    const { ctx } = makeCtx()
    registry.register({
      name: 'slow',
      description: 'sleeps',
      schema: z.object({ ms: z.number() }),
      handler: async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms))
        return { content: 'done' }
      },
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 50,
      category: 'knowledge',
    })
    const r = await registry.execute('slow', { ms: 500 }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/timed out/)
    expect(r.metadata?.timedOut).toBe(true)
  })

  it('catches handler exceptions and returns isError', async () => {
    const { ctx } = makeCtx()
    registry.register({
      name: 'throws',
      description: 'throws',
      schema: z.object({}),
      handler: async () => {
        throw new Error('boom')
      },
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const r = await registry.execute('throws', {}, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/boom/)
  })

  it('toModelTools produces JSON schemas the model can consume', () => {
    registry.register({
      name: 'greet',
      description: 'Greets a person',
      schema: z.object({
        name: z.string().min(1).describe('Person name'),
        loud: z.boolean().optional(),
      }),
      handler: async () => ({ content: '' }),
      risk: 'low',
      parallelSafe: true,
      timeoutMs: 1000,
      category: 'knowledge',
    })
    const tools = registry.toModelTools()
    expect(tools[0]).toMatchObject({
      name: 'greet',
      description: 'Greets a person',
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, description: 'Person name' },
          loud: { type: 'boolean' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    })
  })
})

describe('zodToJsonSchema', () => {
  it('converts primitives', () => {
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'string' })
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' })
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' })
  })

  it('converts enums', () => {
    expect(zodToJsonSchema(z.enum(['a', 'b']))).toEqual({
      type: 'string',
      enum: ['a', 'b'],
    })
  })

  it('strips optionals from required[]', () => {
    const s = zodToJsonSchema(
      z.object({ a: z.string(), b: z.string().optional() }),
    )
    expect(s.required).toEqual(['a'])
    expect(s.properties?.b).toEqual({ type: 'string' })
  })

  it('handles arrays', () => {
    expect(zodToJsonSchema(z.array(z.number()))).toEqual({
      type: 'array',
      items: { type: 'number' },
    })
  })

  it('handles unions', () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    })
  })

  it('preserves descriptions', () => {
    expect(zodToJsonSchema(z.string().describe('a string')).description).toBe('a string')
  })
})

describe('TimeoutError', () => {
  it('is an Error subclass with the right name', () => {
    const e = new TimeoutError(123)
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('TimeoutError')
    expect(e.message).toContain('123')
  })
})
