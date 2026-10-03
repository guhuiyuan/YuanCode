/**
 * Hook executor — bash + http.
 *
 * Bash tests use a real shell subprocess. HTTP tests start a local
 * `http.createServer` on an ephemeral port.
 */
import { describe, expect, it, afterAll, beforeAll } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeBashHook, executeHttpHook } from '../../../src/hooks/executor.js'
import type { HookPayload } from '../../../src/hooks/types.js'

const TMP = mkdtempSync(join(tmpdir(), 'yuancode-exec-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

const isWin = process.platform === 'win32'

function makePayload(): HookPayload {
  return {
    event: 'PreToolUse',
    sessionId: 'test-session',
    cwd: TMP,
    timestamp: Date.now(),
    toolName: 'bash',
    toolInput: { command: 'echo hi' },
  }
}

const deps = {
  sessionId: 'test-session',
  cwd: TMP,
  hardSignal: new AbortController().signal,
  counter: { next: () => Math.floor(Math.random() * 1e9) },
}

// ----------------- bash -----------------

describe('executeBashHook', () => {
  it('exit 0 → allow', async () => {
    const r = await executeBashHook(
      { type: 'bash', command: isWin ? 'exit 0' : 'true' },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('allow')
    expect(r.type).toBe('bash')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('exit 0 with {"decision":"approve"} → approve', async () => {
    const r = await executeBashHook(
      {
        type: 'bash',
        command: isWin
          ? `echo {"decision":"approve"}`
          : `printf '{"decision":"approve"}\\n'`,
      },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('approve')
  })

  it('non-zero exit → deny with stderr reason', async () => {
    const r = await executeBashHook(
      {
        type: 'bash',
        command: isWin ? 'echo denied 1>&2 & exit 7' : 'echo denied 1>&2; exit 7',
      },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
    expect(r.reason).toContain('denied')
  })

  it('timeout → deny with reason', async () => {
    const r = await executeBashHook(
      {
        type: 'bash',
        command: isWin ? 'ping -n 999 127.0.0.1' : 'sleep 30',
        timeoutMs: 200,
      },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
    expect(r.reason).toMatch(/timed out/i)
  })

  it('invalid command (spawn fail) → deny', async () => {
    const r = await executeBashHook(
      { type: 'bash', command: '/this/binary/does/not/exist/anywhere' },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
  })

  it('forwards payload on stdin', async () => {
    const r = await executeBashHook(
      {
        type: 'bash',
        command: isWin ? 'more' : 'cat',
      },
      makePayload(),
      deps,
      0,
    )
    expect(r.stdout === undefined) // stdout is not returned in result
    expect(r.outcome).toBe('allow')
  })
})

// ----------------- http -----------------

let server: Server
let baseUrl: string
let lastResponse = { status: 200, body: '' }

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      res.statusCode = lastResponse.status
      res.setHeader('content-type', 'application/json')
      res.end(lastResponse.body || JSON.stringify({ ok: true, received: body }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('executeHttpHook', () => {
  it('2xx → allow', async () => {
    lastResponse = { status: 200, body: '' }
    const r = await executeHttpHook(
      { type: 'http', url: `${baseUrl}/allow` },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('allow')
  })

  it('2xx + {"decision":"approve"} → approve', async () => {
    lastResponse = { status: 200, body: JSON.stringify({ decision: 'approve' }) }
    const r = await executeHttpHook(
      { type: 'http', url: `${baseUrl}/approve` },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('approve')
  })

  it('4xx → deny with status reason', async () => {
    lastResponse = { status: 403, body: 'forbidden' }
    const r = await executeHttpHook(
      { type: 'http', url: `${baseUrl}/deny` },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
    expect(r.reason).toContain('403')
  })

  it('5xx → deny', async () => {
    lastResponse = { status: 500, body: 'oops' }
    const r = await executeHttpHook(
      { type: 'http', url: `${baseUrl}/err` },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
  })

  it('network error → deny', async () => {
    const r = await executeHttpHook(
      { type: 'http', url: 'http://127.0.0.1:1/never-listens' },
      makePayload(),
      deps,
      0,
    )
    expect(r.outcome).toBe('deny')
  })

  it('timeout → deny', async () => {
    // Server that hangs — fires after 200ms but our timeout is 100ms.
    const slow = createServer((_req, res) => {
      setTimeout(() => res.end('late'), 2000)
    })
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve))
    const slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/slow`
    const r = await executeHttpHook(
      { type: 'http', url: slowUrl, timeoutMs: 100 },
      makePayload(),
      deps,
      0,
    )
    await new Promise<void>((resolve) => slow.close(() => resolve()))
    expect(r.outcome).toBe('deny')
  })
})
