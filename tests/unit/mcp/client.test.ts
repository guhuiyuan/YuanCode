/**
 * McpServerConnection unit tests.
 *
 * The SDK is heavy (child_process, fetch, JSON-RPC framing). To keep these
 * tests fast and deterministic we mock all three entry points
 * (`@modelcontextprotocol/sdk/client/index`, `.../client/stdio`,
 * `.../client/streamableHttp`) and inject a fake `Client` whose methods
 * resolve to hand-crafted responses. This lets us assert on the *wiring*
 * (constructor → transport choice, connect() → signal passthrough, callTool
 * → error swallowing) without actually spawning anything.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the SUT
// ---------------------------------------------------------------------------

type OnClose = (() => void) | undefined
type OnError = ((err: Error) => void) | undefined

interface FakeTransport {
  onclose?: OnClose
  onerror?: OnError
  close: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  // Test-only helpers
  fireClose: () => void
  fireError: (e: Error) => void
}

function makeFakeTransport(): FakeTransport {
  const t: FakeTransport = {
    onclose: undefined,
    onerror: undefined,
    close: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    fireClose: function () {
      this.onclose?.()
    },
    fireError: function (e: Error) {
      this.onerror?.(e)
    },
  }
  return t
}

const fakeStdioTransport = makeFakeTransport()
const fakeHttpTransport = makeFakeTransport()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const Client = vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'echo',
          description: 'echoes input',
          inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
        },
        {
          name: 'add',
          description: 'adds two numbers',
          inputSchema: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b'],
          },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'mock-result' }],
      isError: false,
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }))
  return { Client }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => fakeStdioTransport),
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => fakeHttpTransport),
}))

// Now safe to import SUT
import { McpServerConnection, McpUnavailableError } from '../../../src/mcp/client.js'
import type { McpServerConfig } from '../../../src/mcp/types.js'

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

function makeStdioConfig(): McpServerConfig {
  return {
    command: 'mock-server',
    args: ['--port', '0'],
    env: { TOKEN: 'abc' },
  }
}

function makeHttpConfig(): McpServerConfig {
  return { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x' } }
}

const ac = (): AbortSignal => new AbortController().signal

beforeEach(() => {
  vi.clearAllMocks()
  // reset transport callback slots between tests so one test's onclose
  // doesn't leak into the next
  fakeStdioTransport.onclose = undefined
  fakeStdioTransport.onerror = undefined
  fakeHttpTransport.onclose = undefined
  fakeHttpTransport.onerror = undefined
})

afterEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpServerConnection', () => {
  it('normalizes the server name to [a-z0-9_]+', () => {
    const c = new McpServerConnection('My Server!', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    expect(c.originalName).toBe('My Server!')
    expect(c.normalizedName).toBe('my_server')
  })

  it('routes a stdio config to StdioClientTransport', async () => {
    const { StdioClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/stdio.js'
    )
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    expect(StdioClientTransport).toHaveBeenCalledTimes(1)
    const arg = (StdioClientTransport as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as Record<string, unknown>
    expect(arg.command).toBe('mock-server')
    expect(arg.args).toEqual(['--port', '0'])
    expect(arg.env).toMatchObject({ TOKEN: 'abc' })
    expect(arg.stderr).toBe('pipe')
    await c.dispose()
  })

  it('routes a remote config to StreamableHTTPClientTransport', async () => {
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    )
    const c = new McpServerConnection('gh', makeHttpConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    expect(StreamableHTTPClientTransport).toHaveBeenCalledTimes(1)
    const [url, opts] = (StreamableHTTPClientTransport as unknown as {
      mock: { calls: Array<[URL, Record<string, unknown>]> }
    }).mock.calls[0]!
    expect(url).toBeInstanceOf(URL)
    expect(url.toString()).toBe('https://example.com/mcp')
    expect(opts.requestInit.headers).toEqual({ Authorization: 'Bearer x' })
    await c.dispose()
  })

  it('connect() forwards hardSignal to Client.connect', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const instance = (Client as unknown as { mock: { results: Array<{ value: { connect: ReturnType<typeof vi.fn> } }> } })
      .mock.results[0]!.value
    expect(instance.connect).toHaveBeenCalledTimes(1)
    expect(instance.connect).toHaveBeenCalledWith(fakeStdioTransport, {
      signal: expect.any(AbortSignal),
    })
    await c.dispose()
  })

  it('listTools() maps SDK output into McpToolSpec[]', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    const tools = await c.listTools()
    expect(tools).toHaveLength(2)
    expect(tools[0]).toMatchObject({
      name: 'echo',
      description: 'echoes input',
      serverName: 'fs',
      originalServerName: 'fs',
    })
    expect(tools[0]!.inputSchema).toEqual({
      type: 'object',
      properties: { msg: { type: 'string' } },
    })
    await c.dispose()
  })

  it('listTools() throws when not connected', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await expect(c.listTools()).rejects.toBeInstanceOf(McpUnavailableError)
  })

  it('callTool() forwards name + arguments and returns content', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    const result = await c.callTool('echo', { msg: 'hi' })
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: 'text', text: 'mock-result' }])

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const instance = (Client as unknown as { mock: { results: Array<{ value: { callTool: ReturnType<typeof vi.fn> } }> } })
      .mock.results[0]!.value
    expect(instance.callTool).toHaveBeenCalledWith(
      { name: 'echo', arguments: { msg: 'hi' } },
      undefined,
      { signal: expect.any(AbortSignal) },
    )
    await c.dispose()
  })

  it('callTool() on a closed connection returns isError instead of throwing', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    await c.dispose()
    const result = await c.callTool('echo', { msg: 'hi' })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/unavailable|crashed/i)
  })

  it('callTool() swallows SDK errors and surfaces them as isError:true', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()

    // Patch the mock's callTool to throw for this test only
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const instance = (Client as unknown as { mock: { results: Array<{ value: { callTool: ReturnType<typeof vi.fn> } }> } })
      .mock.results[0]!.value
    instance.callTool.mockRejectedValueOnce(new Error('boom'))

    const result = await c.callTool('echo', { msg: 'hi' })
    expect(result.isError).toBe(true)
    expect(String(result.content)).toMatch(/boom/)
    await c.dispose()
  })

  it('transport.onclose marks crashed and fires onCrash', async () => {
    const onCrash = vi.fn()
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
      onCrash,
    })
    await c.connect()
    expect(c.isCrashed()).toBe(false)

    fakeStdioTransport.fireClose()
    expect(c.isCrashed()).toBe(true)
    expect(c.isConnected()).toBe(false)
    expect(onCrash).toHaveBeenCalledWith('fs', expect.any(Error))
  })

  it('transport.onclose after dispose() does NOT fire onCrash', async () => {
    const onCrash = vi.fn()
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
      onCrash,
    })
    await c.connect()
    await c.dispose()
    fakeStdioTransport.fireClose()
    expect(onCrash).not.toHaveBeenCalled()
  })

  it('dispose() is idempotent', async () => {
    const c = new McpServerConnection('fs', makeStdioConfig(), {
      hardSignal: ac(),
      logger: silentLogger(),
    })
    await c.connect()
    await c.dispose()
    await c.dispose() // should not throw
    expect(c.isClosed()).toBe(true)
  })
})
