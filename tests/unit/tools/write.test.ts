/**
 * Write tool — file write + checkpoint + parent dir creation.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeWriteTool } from '../../../src/tools/write.js'
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
  dir = mkdtempSync(join(tmpdir(), 'yuancode-write-'))
  checkpoints = new CheckpointManager({ maxSnapshots: 50 })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeCtx(cwd: string): import('../../../src/core/tool-registry.js').ToolContext {
  return {
    cwd,
    sandbox: new LocalSandbox({ cwd }) as unknown as import('../../../src/core/sandbox/runner.js').SandboxRunner,
    abort: new TwoLevelAbort(),
    sessionId: 'test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

describe('write tool — basic write', () => {
  it('writes a new file and reports bytes written', async () => {
    const tool = makeWriteTool({ cwd: dir, checkpoints })
    const r = await tool.handler({ path: 'a.txt', content: 'hello' }, makeCtx(dir))
    expect(r.isError).toBeFalsy()
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('hello')
    expect(r.metadata).toMatchObject({ bytes: 5 })
  })

  it('creates parent directories recursively', async () => {
    const tool = makeWriteTool({ cwd: dir, checkpoints })
    const r = await tool.handler(
      { path: 'deep/nested/path/b.txt', content: 'x' },
      makeCtx(dir),
    )
    expect(r.isError).toBeFalsy()
    expect(existsSync(join(dir, 'deep', 'nested', 'path', 'b.txt'))).toBe(true)
  })

  it('overwrites an existing file (the previous content is checkpointed)', async () => {
    const f = join(dir, 'o.txt')
    writeFileSync(f, 'OLD', 'utf8')
    const tool = makeWriteTool({ cwd: dir, checkpoints })
    const r = await tool.handler({ path: 'o.txt', content: 'NEW' }, makeCtx(dir))
    expect(readFileSync(f, 'utf8')).toBe('NEW')
    // The pre-existing content was snapshotted
    expect(checkpoints.list(f)[0]?.content.toString('utf8')).toBe('OLD')
    expect(r.content).toMatch(/<write /)
  })
})

describe('write tool — forbidden path', () => {
  it('throws when path escapes the sandbox (SandboxPathError)', async () => {
    const tool = makeWriteTool({ cwd: dir, checkpoints })
    // PathGuard throws synchronously; the registry's execute() converts
    // this into isError, but the handler itself raises so callers can
    // detect the violation clearly.
    await expect(
      tool.handler(
        { path: '../../../../etc/evil.txt', content: 'x' },
        makeCtx(dir),
      ),
    ).rejects.toThrow(/blocked by sandbox/)
  })
})
