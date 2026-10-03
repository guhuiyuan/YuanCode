/**
 * Bash tool tests.
 */
import { describe, expect, it } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { z } from 'zod'
import type { Logger as PinoLogger } from 'pino'
import { ToolRegistry } from '../../../src/core/tool-registry.js'
import { TwoLevelAbort } from '../../../src/core/abort.js'
import { LocalSandbox } from '../../../src/core/sandbox/local.js'
import { makeBashTool, BashInputSchema } from '../../../src/tools/bash.js'

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

const TMP = join(tmpdir(), `yuancode-bash-${Date.now()}`)
mkdirSync(TMP, { recursive: true })
const isWin = process.platform === 'win32'

describe('BashInputSchema', () => {
  it('requires command', () => {
    const r = BashInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  it('accepts command only', () => {
    const r = BashInputSchema.safeParse({ command: 'ls' })
    expect(r.success).toBe(true)
  })

  it('rejects empty command', () => {
    const r = BashInputSchema.safeParse({ command: '' })
    expect(r.success).toBe(false)
  })

  it('bounds timeoutMs to 10 minutes', () => {
    expect(BashInputSchema.safeParse({ command: 'x', timeoutMs: 1_000_000 }).success).toBe(false)
    expect(BashInputSchema.safeParse({ command: 'x', timeoutMs: 60_000 }).success).toBe(true)
  })
})

describe('bash tool', () => {
  function setup() {
    const sandbox = new LocalSandbox({ cwd: TMP })
    const registry = new ToolRegistry()
    registry.register(makeBashTool(sandbox))
    const ctx = {
      cwd: TMP,
      sandbox,
      abort: new TwoLevelAbort(),
      sessionId: 'test',
      permissionMode: 'acceptEdits' as const,
      logger: noopLogger,
    }
    return { registry, ctx }
  }

  it('is registered as a high-risk, non-parallel-safe shell tool', () => {
    const { registry } = setup()
    const t = registry.get('bash')!
    expect(t.risk).toBe('high')
    expect(t.parallelSafe).toBe(false)
    expect(t.category).toBe('shell')
  })

  it('runs a command and returns formatted stdout', async () => {
    const { registry, ctx } = setup()
    const r = await registry.execute('bash', { command: 'echo hi-from-bash' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('hi-from-bash')
    expect(r.content).toContain('<exit_code>0</exit_code>')
    expect(r.metadata?.exitCode).toBe(0)
  })

  it('surfaces non-zero exit codes', async () => {
    const { registry, ctx } = setup()
    const r = await registry.execute('bash', { command: 'exit 42' }, ctx)
    expect(r.content).toContain('<exit_code>42</exit_code>')
  })

  it('reports timeout when the command runs longer than timeoutMs', async () => {
    const { registry, ctx } = setup()
    const cmd = isWin ? 'ping -n 30 127.0.0.1 > NUL' : 'sleep 30'
    const r = await registry.execute('bash', { command: cmd, timeoutMs: 150 }, ctx)
    expect(r.metadata?.timedOut).toBe(true)
    expect(r.content).toContain('<status>timed out')
  })

  it('exposes a Zod schema that produces a JSON schema the model can read', () => {
    const { registry } = setup()
    const tools = registry.toModelTools()
    expect(tools[0]?.name).toBe('bash')
    expect(tools[0]?.input_schema.type).toBe('object')
    expect(tools[0]?.input_schema.required).toContain('command')
  })
})

afterAll(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true })
})

import { afterAll } from 'vitest'
