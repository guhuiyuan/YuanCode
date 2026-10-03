/**
 * ls tool — non-recursive default, depth, hidden, truncation.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeLsTool } from '../../../src/tools/ls.js'
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
  dir = mkdtempSync(join(tmpdir(), 'yuancode-ls-'))
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

describe('ls tool — basic', () => {
  it('lists files and directories with directories first', async () => {
    writeFileSync(join(dir, 'a.txt'), '')
    writeFileSync(join(dir, 'b.txt'), '')
    mkdirSync(join(dir, 'sub'))
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: '.' }, ctx(dir))
    expect(r.isError).toBeFalsy()
    // Trailing separator for dirs (uses platform sep — '/' on POSIX, '\' on Windows)
    expect(r.content).toMatch(/sub[\\/]?/)
    expect(r.content).toContain('a.txt')
    expect(r.content).toContain('b.txt')
    // Directory appears before file (sort key: dirs=0, files=1)
    const subIdx = r.content.search(/sub[\\/]/)
    const aIdx = r.content.indexOf('a.txt')
    expect(subIdx).toBeGreaterThanOrEqual(0)
    expect(subIdx).toBeLessThan(aIdx)
  })

  it('hides dotfiles by default', async () => {
    writeFileSync(join(dir, 'visible.txt'), '')
    writeFileSync(join(dir, '.hidden'), '')
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: '.' }, ctx(dir))
    expect(r.content).toContain('visible.txt')
    expect(r.content).not.toContain('.hidden')
  })

  it('showHidden: true includes dotfiles', async () => {
    writeFileSync(join(dir, '.env'), 'KEY=val')
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: '.', showHidden: true }, ctx(dir))
    expect(r.content).toContain('.env')
  })

  it('maxDepth=2 descends one level', async () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'inner.txt'), '')
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: '.', maxDepth: 2 }, ctx(dir))
    expect(r.content).toContain('inner.txt')
  })
})

describe('ls tool — errors', () => {
  it('returns isError for missing directory', async () => {
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: 'does/not/exist' }, ctx(dir))
    expect(r.isError).toBe(true)
  })

  it('returns isError when listing a file', async () => {
    writeFileSync(join(dir, 'f.txt'), '')
    const tool = makeLsTool({ cwd: dir })
    const r = await tool.handler({ path: 'f.txt' }, ctx(dir))
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Not a directory/)
  })
})
