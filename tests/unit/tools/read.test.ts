/**
 * Read tool — basic read, line paging, binary detection, path guard.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeReadTool } from '../../../src/tools/read.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'

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

let dir: string
let tool: ReturnType<typeof makeReadTool>
let ctx: import('../../../src/core/tool-registry.js').ToolContext

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-read-'))
  tool = makeReadTool({ cwd: dir })
  const sandbox = new LocalSandbox({ cwd: dir })
  // Tame the sandbox to the tmp dir so writes are also allowed.
  sandbox.pathGuard = undefined as unknown as typeof sandbox.pathGuard
  ctx = {
    cwd: dir,
    sandbox: sandbox as unknown as import('../../../src/core/sandbox/runner.js').SandboxRunner,
    abort: new TwoLevelAbort(),
    sessionId: 'test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('read tool — happy path', () => {
  it('reads a small text file and returns numbered lines', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
    const r = await tool.handler({ path: 'a.txt' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('<file')
    expect(r.content).toContain('1\tone')
    expect(r.content).toContain('3\tthree')
    expect(r.metadata).toMatchObject({ lines: 4 })  // 3 lines + trailing empty
  })

  it('paginates with offset and limit', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(join(dir, 'b.txt'), lines, 'utf8')
    const r = await tool.handler({ path: 'b.txt', offset: 5, limit: 3 }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('6\tline 6')
    expect(r.content).toContain('8\tline 8')
    expect(r.content).not.toContain('9\tline 9')
  })

  it('returns truncation hint when there is more', async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `L${i}`).join('\n')
    writeFileSync(join(dir, 'c.txt'), lines, 'utf8')
    const r = await tool.handler({ path: 'c.txt', offset: 0, limit: 2 }, ctx)
    expect(r.content).toMatch(/more lines/)
    expect(r.content).toMatch(/use offset=2/)
  })
})

describe('read tool — binary detection', () => {
  it('returns a hex preview when a NUL byte is in the first 8 KiB', async () => {
    // First 4 bytes are NUL → binary path
    const buf = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('rest')])
    writeFileSync(join(dir, 'bin.dat'), buf)
    const r = await tool.handler({ path: 'bin.dat' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toMatch(/<binary file:/)
    expect(r.content).toMatch(/<hex preview/)
    expect(r.metadata).toMatchObject({ binary: true })
  })
})

describe('read tool — errors', () => {
  it('returns isError when path does not exist', async () => {
    const r = await tool.handler({ path: 'missing.txt' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })

  it('returns isError when path is a directory, not a file', async () => {
    mkdirSync(join(dir, 'sub'))
    const r = await tool.handler({ path: 'sub' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Not a regular file/)
  })
})

describe('read tool — path guard', () => {
  it('throws when the resolved path is outside the sandbox', async () => {
    const t = makeReadTool({ cwd: dir })
    await expect(
      t.handler({ path: '../../../etc/passwd' }, ctx),
    ).rejects.toThrow(/blocked by sandbox/)
  })
})
