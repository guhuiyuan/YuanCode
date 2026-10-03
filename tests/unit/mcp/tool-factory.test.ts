/**
 * MCP tool factory tests — covers both `makeMcpTool` (the ToolEntry factory)
 * and `jsonSchemaToZod` (the JSON Schema → Zod converter that backs it).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// SUT
// ---------------------------------------------------------------------------
import { jsonSchemaToZod, makeMcpTool } from '../../../src/mcp/tool-factory.js'
import type { McpToolSpec } from '../../../src/mcp/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger
}

function fakeContext() {
  return {
    cwd: process.cwd(),
    sandbox: {} as never,
    abort: { hardSignal: new AbortController().signal } as never,
    sessionId: 'test-session',
    permissionMode: 'auto' as const,
    logger: silentLogger(),
  }
}

function makeSpec(overrides: Partial<McpToolSpec> = {}): McpToolSpec {
  return {
    name: 'echo',
    description: 'echoes input',
    inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
    serverName: 'fs',
    originalServerName: 'filesystem',
    ...overrides,
  }
}

function fakeManager(opts: {
  connected?: boolean
  crashed?: boolean
  result?: { content: unknown; isError?: boolean }
  throwOnCall?: boolean
}) {
  const callTool = opts.throwOnCall
    ? vi.fn().mockRejectedValue(new Error('boom'))
    : vi.fn().mockResolvedValue(
        opts.result ?? { content: [{ type: 'text', text: 'ok' }], isError: false },
      )
  const conn = {
    isConnected: vi.fn().mockReturnValue(opts.connected ?? true),
    isCrashed: vi.fn().mockReturnValue(opts.crashed ?? false),
    callTool,
  }
  return { getConnection: vi.fn().mockReturnValue(conn), _conn: conn }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// jsonSchemaToZod
// ---------------------------------------------------------------------------

describe('jsonSchemaToZod', () => {
  it('handles type=string', () => {
    const s = jsonSchemaToZod({ type: 'string' })
    expect(s.safeParse('hi').success).toBe(true)
    expect(s.safeParse(42).success).toBe(false)
  })

  it('handles type=string with enum', () => {
    const s = jsonSchemaToZod({ type: 'string', enum: ['a', 'b', 'c'] })
    expect(s.safeParse('a').success).toBe(true)
    expect(s.safeParse('z').success).toBe(false)
  })

  it('handles type=number and integer', () => {
    expect(jsonSchemaToZod({ type: 'number' }).safeParse(3.14).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(3).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse('3').success).toBe(false)
  })

  it('handles type=boolean', () => {
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse('true').success).toBe(false)
  })

  it('handles type=array with items', () => {
    const s = jsonSchemaToZod({
      type: 'array',
      items: { type: 'string' },
    })
    expect(s.safeParse(['a', 'b']).success).toBe(true)
    expect(s.safeParse([1, 2]).success).toBe(false)
  })

  it('handles type=object with required and optional keys', () => {
    const s = jsonSchemaToZod({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    })
    expect(s.safeParse({ a: 'x' }).success).toBe(true) // b optional
    expect(s.safeParse({}).success).toBe(false) // a required
    expect(s.safeParse({ a: 'x', b: 1 }).success).toBe(true)
  })

  it('falls back to z.unknown() for unrecognised shapes', () => {
    const s = jsonSchemaToZod({ type: 'weird-thing' })
    expect(s.safeParse('anything').success).toBe(true)
    expect(s.safeParse(42).success).toBe(true)
  })

  it('falls back to z.record(unknown) for object with no properties', () => {
    const s = jsonSchemaToZod({ type: 'object' })
    expect(s.safeParse({ whatever: 1 }).success).toBe(true)
  })

  it('preserves description via .describe()', () => {
    const s = jsonSchemaToZod({ type: 'string', description: 'a name' })
    expect(s.description).toBe('a name')
  })

  it('guards against cyclic schemas', () => {
    // Construct a self-referencing schema and confirm no infinite loop.
    const a: Record<string, unknown> = { type: 'object', properties: {} }
    a.properties = { self: a }
    expect(() => jsonSchemaToZod(a)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// makeMcpTool
// ---------------------------------------------------------------------------

describe('makeMcpTool', () => {
  it('produces a ToolEntry with the right shape', () => {
    const mgr = fakeManager({})
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    expect(tool.name).toBe('mcp__fs__echo')
    expect(tool.description).toContain('echoes input')
    expect(tool.category).toBe('mcp')
    expect(tool.risk).toBe('low')
    expect(tool.parallelSafe).toBe(true)
    expect(tool.timeoutMs).toBe(30_000)
    // Schema derived from spec.inputSchema
    expect(tool.schema).toBeInstanceOf(z.ZodType)
  })

  it('falls back to a generic description when spec has none', () => {
    const tool = makeMcpTool({
      spec: makeSpec({ description: undefined }),
      manager: fakeManager({}) as never,
      logger: silentLogger(),
    })
    expect(tool.description).toMatch(/MCP tool "echo" from server "filesystem"/)
  })

  it('handler returns isError when the connection is missing', async () => {
    const mgr = { getConnection: vi.fn().mockReturnValue(undefined) }
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({ msg: 'hi' }, fakeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not registered/)
    expect(r.metadata).toMatchObject({ serverName: 'fs' })
  })

  it('handler returns isError when the connection is crashed', async () => {
    const mgr = fakeManager({ connected: false, crashed: true })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({ msg: 'hi' }, fakeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/unavailable/)
    expect(r.metadata).toMatchObject({ crashed: true })
  })

  it('handler forwards input to callTool and renders text content', async () => {
    const mgr = fakeManager({
      result: { content: [{ type: 'text', text: 'echoed: hi' }], isError: false },
    })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({ msg: 'hi' }, fakeContext())
    expect(r.isError).toBe(false)
    expect(r.content).toContain('echoed: hi')
    expect(mgr._conn.callTool).toHaveBeenCalledWith('echo', { msg: 'hi' })
    expect(r.metadata).toMatchObject({
      fullName: 'mcp__fs__echo',
      serverName: 'fs',
      toolName: 'echo',
    })
  })

  it('handler formats image / audio / resource blocks', async () => {
    const mgr = fakeManager({
      result: {
        content: [
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          { type: 'audio', data: 'BBBB', mimeType: 'audio/mp3' },
          {
            type: 'resource',
            resource: { uri: 'file://a', text: 'inside-text', mimeType: 'text/plain' },
          },
          { type: 'resource_link', uri: 'file://b', name: 'B' },
        ],
        isError: false,
      },
    })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({}, fakeContext())
    expect(r.content).toContain('image')
    expect(r.content).toContain('audio')
    expect(r.content).toContain('file://a')
    expect(r.content).toContain('inside-text')
    expect(r.content).toContain('file://b')
  })

  it('handler renders isError=true from the SDK result', async () => {
    const mgr = fakeManager({
      result: {
        content: [{ type: 'text', text: 'permission denied' }],
        isError: true,
      },
    })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({}, fakeContext())
    expect(r.isError).toBe(true)
    expect(r.content).toContain('permission denied')
  })

  it('handler tolerates non-array content (stringifies it)', async () => {
    const mgr = fakeManager({ result: { content: 'just-a-string', isError: false } })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({}, fakeContext())
    expect(r.isError).toBe(false)
    expect(r.content).toContain('just-a-string')
  })

  it('handler renders empty result cleanly', async () => {
    const mgr = fakeManager({ result: { content: [], isError: false } })
    const tool = makeMcpTool({
      spec: makeSpec(),
      manager: mgr as never,
      logger: silentLogger(),
    })
    const r = await tool.handler({}, fakeContext())
    expect(r.content).toMatch(/empty result/)
  })
})
