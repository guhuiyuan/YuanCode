/**
 * Glob tool — file pattern match, recursion, default skips.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeGlobTool } from '../../../src/tools/glob.js'
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
  dir = mkdtempSync(join(tmpdir(), 'yuancode-glob-'))
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

describe('glob tool — basic matching', () => {
  it('matches *.ts in the root', async () => {
    writeFileSync(join(dir, 'a.ts'), '')
    writeFileSync(join(dir, 'b.js'), '')
    const tool = makeGlobTool({ cwd: dir })
    const r = await tool.handler({ pattern: '*.ts' }, ctx(dir))
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('a.ts')
    expect(r.content).not.toContain('b.js')
  })

  it('matches **/*.ts recursively', async () => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'inner.ts'), '')
    writeFileSync(join(dir, 'top.ts'), '')
    const tool = makeGlobTool({ cwd: dir })
    const r = await tool.handler({ pattern: '**/*.ts' }, ctx(dir))
    expect(r.content).toContain('src/inner.ts')
    expect(r.content).toContain('top.ts')
  })

  it('hides dotfiles by default', async () => {
    writeFileSync(join(dir, 'visible.ts'), '')
    writeFileSync(join(dir, '.hidden.ts'), '')
    const tool = makeGlobTool({ cwd: dir })
    const r = await tool.handler({ pattern: '*.ts' }, ctx(dir))
    expect(r.content).toContain('visible.ts')
    expect(r.content).not.toContain('.hidden.ts')
  })

  it('always skips node_modules and dist', async () => {
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(dir, 'dist'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'x.ts'), '')
    writeFileSync(join(dir, 'dist', 'y.ts'), '')
    writeFileSync(join(dir, 'keep.ts'), '')
    const tool = makeGlobTool({ cwd: dir })
    const r = await tool.handler({ pattern: '**/*.ts' }, ctx(dir))
    expect(r.content).toContain('keep.ts')
    expect(r.content).not.toContain('node_modules')
    expect(r.content).not.toContain('dist/')
  })

  it('returns count=0 when nothing matches', async () => {
    writeFileSync(join(dir, 'a.txt'), '')
    const tool = makeGlobTool({ cwd: dir })
    const r = await tool.handler({ pattern: '*.py' }, ctx(dir))
    expect(r.content).toMatch(/count=0/)
  })
})
