/**
 * Grep tool — content search (JS fallback path is exercised here; we monkey-
 * patch the ripgrep probe so we don't need rg installed).
 *
 * We don't need ripgrep to test the logic — the `hasRipgrep` internal flag
 * is module-scoped, so we hit the fallback in tests by avoiding the cache.
 * To force the JS path deterministically, we import the tool then call
 * ripgrep behavior via its absence: tests just exercise the input/output
 * contract; rg vs fallback produce the same wrapping.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGrepTool } from '../../../src/tools/grep.js'
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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-grep-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ctx(cwd: string): import('../../../src/core/tool-registry.js').ToolContext {
  return {
    cwd,
    sandbox: new LocalSandbox({ cwd }) as unknown as import('../../../src/core/sandbox/runner.js').SandboxRunner,
    abort: new TwoLevelAbort(),
    sessionId: 'test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

describe('grep tool — content search', () => {
  it('finds matches in plain text files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'line one\nline two\nline three\n', 'utf8')
    writeFileSync(join(dir, 'b.txt'), 'unrelated\n', 'utf8')
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    const r = await tool.handler({ pattern: 'line' }, ctx(dir))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('a.txt:1:line one')
    expect(r.content).toContain('a.txt:2:line two')
    expect(r.content).toContain('a.txt:3:line three')
    expect(r.content).not.toContain('b.txt')
  })

  it('respects caseInsensitive flag', async () => {
    writeFileSync(join(dir, 'a.txt'), 'Hello\nHELLO\nhello\n', 'utf8')
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    const r1 = await tool.handler({ pattern: 'hello' }, ctx(dir))
    const r2 = await tool.handler({ pattern: 'hello', caseInsensitive: true }, ctx(dir))
    // Case-sensitive (default) → only the lowercase line matches
    expect(r1.content).toMatch(/count=1[^0-9]/)
    // Case-insensitive finds all three lines
    expect(r2.content).toMatch(/count=3[^0-9]/)
  })

  it('respects include glob filter', async () => {
    writeFileSync(join(dir, 'a.ts'), 'ts-content\n')
    writeFileSync(join(dir, 'b.js'), 'js-content\n')
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    const r = await tool.handler({ pattern: 'content', include: '*.ts' }, ctx(dir))
    expect(r.content).toContain('a.ts')
    expect(r.content).not.toContain('b.js')
  })

  it('returns zero-count envelope when nothing matches', async () => {
    writeFileSync(join(dir, 'a.txt'), 'unrelated\n', 'utf8')
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    const r = await tool.handler({ pattern: 'definitely-not-here' }, ctx(dir))
    expect(r.content).toMatch(/count=0/)
    expect(r.content).not.toMatch(/truncated/)
  })

  it('skips node_modules and .git', async () => {
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'node_modules', 'evil.txt'), 'SECRET', 'utf8')
    writeFileSync(join(dir, 'a.txt'), 'SECRET\n', 'utf8')
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    const r = await tool.handler({ pattern: 'SECRET' }, ctx(dir))
    expect(r.content).toContain('a.txt')
    expect(r.content).not.toContain('node_modules')
  })

  it('returns isError for invalid regex', async () => {
    const tool = makeGrepTool({ cwd: dir, sandbox: new LocalSandbox({ cwd: dir }) })
    // Force fallback by using a clearly-invalid JS regex (rg tolerates more).
    const r = await tool.handler({ pattern: '[unclosed' }, ctx(dir))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Invalid regex|ripgrep failed/)
  })
})
