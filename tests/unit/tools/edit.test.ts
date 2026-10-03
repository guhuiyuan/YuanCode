/**
 * Edit tool — surgical replace, uniqueness, globalReplace, checkpoint.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeEditTool } from '../../../src/tools/edit.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { CheckpointManager } from '../../../src/core/checkpoint-manager.js'

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
let checkpoints: CheckpointManager

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-edit-'))
  checkpoints = new CheckpointManager({ maxSnapshots: 50 })
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

describe('edit tool — unique replacement', () => {
  it('replaces a unique oldText and checkpoints the previous content', async () => {
    const f = join(dir, 'a.txt')
    writeFileSync(f, 'hello world', 'utf8')
    const tool = makeEditTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'a.txt', oldText: 'hello', newText: 'howdy' },
      ctx(dir),
    )
    expect(r.isError).toBeFalsy()
    expect(readFileSync(f, 'utf8')).toBe('howdy world')
    expect(checkpoints.list(f)[0]?.content.toString('utf8')).toBe('hello world')
  })

  it('returns isError when oldText appears 0 times', async () => {
    const f = join(dir, 'b.txt')
    writeFileSync(f, 'abc', 'utf8')
    const tool = makeEditTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'b.txt', oldText: 'zzz', newText: 'x' },
      ctx(dir),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not found/)
  })

  it('returns isError when oldText appears more than once without globalReplace', async () => {
    const f = join(dir, 'c.txt')
    writeFileSync(f, 'foo foo foo', 'utf8')
    const tool = makeEditTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'c.txt', oldText: 'foo', newText: 'bar' },
      ctx(dir),
    )
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/not unique/)
    expect(r.content).toMatch(/3 occurrences/)
  })

  it('globalReplace: true replaces all occurrences', async () => {
    const f = join(dir, 'd.txt')
    writeFileSync(f, 'foo foo foo', 'utf8')
    const tool = makeEditTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'd.txt', oldText: 'foo', newText: 'bar', globalReplace: true },
      ctx(dir),
    )
    expect(r.isError).toBeFalsy()
    expect(readFileSync(f, 'utf8')).toBe('bar bar bar')
    expect(r.metadata).toMatchObject({ occurrences: 3 })
  })

  it('reports negative delta_bytes when replacing with shorter text', async () => {
    const f = join(dir, 'e.txt')
    writeFileSync(f, 'longer string here', 'utf8')
    const tool = makeEditTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'e.txt', oldText: 'longer', newText: 'short' },
      ctx(dir),
    )
    expect(r.content).toMatch(/delta_bytes=-1/)
  })
})
