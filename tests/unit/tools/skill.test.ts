/**
 * Skill tool — load SKILL.md body on demand.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { Logger as PinoLogger } from 'pino'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeSkillTool } from '../../../src/tools/skill.js'
import { loadSkillsIndex } from '../../../src/extensions/skills.js'
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
  dir = mkdtempSync(join(tmpdir(), 'yuancode-skill-tool-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeSkill(name: string, desc: string, body: string): void {
  const d = join(dir, 'skills', name)
  mkdirSync(d, { recursive: true })
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n\n${body}\n`,
    'utf8',
  )
}

function ctx(): import('../../../src/core/tool-registry.js').ToolContext {
  return {
    cwd: process.cwd(),
    sandbox: new LocalSandbox({ cwd: process.cwd() }) as unknown as import('../../../src/core/sandbox/runner.js').SandboxRunner,
    abort: new TwoLevelAbort(),
    sessionId: 'test',
    permissionMode: 'manual',
    logger: noopLogger,
  }
}

describe('skill tool — basic load', () => {
  it('returns the body wrapped in <skill> tags', async () => {
    makeSkill('demo', 'demo skill', '# Demo\nBody text.')
    const idx = loadSkillsIndex(dir)
    const tool = makeSkillTool({ index: idx })
    const r = await tool.handler({ name: 'demo' }, ctx())
    expect(r.isError).toBeFalsy()
    expect(r.content).toContain('<skill name="demo"')
    expect(r.content).toContain('# Demo')
    expect(r.content).toContain('Body text.')
    expect(r.metadata).toMatchObject({ name: 'demo' })
  })

  it('returns isError when the skill is unknown', async () => {
    makeSkill('demo', 'd', 'b')
    const idx = loadSkillsIndex(dir)
    const tool = makeSkillTool({ index: idx })
    const r = await tool.handler({ name: 'unknown' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Unknown skill/)
    expect(r.content).toContain('demo')
  })

  it('returns empty available-list when no skills are present', async () => {
    const idx = loadSkillsIndex(dir)
    const tool = makeSkillTool({ index: idx })
    const r = await tool.handler({ name: 'whatever' }, ctx())
    expect(r.isError).toBe(true)
    expect(r.content).toMatch(/Available: \(none\)/)
  })
})
