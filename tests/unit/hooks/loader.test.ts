/**
 * Hooks config loader — merge user + project files, validate, never throw.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadHooksConfig } from '../../../src/hooks/loader.js'

let TMP: string

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'yuancode-loader-'))
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const USER = (): string => join(TMP, 'user-hooks.yaml')
const PROJ = (): string => join(TMP, 'project-hooks.yaml')

describe('loadHooksConfig', () => {
  it('returns empty config when both files are missing', () => {
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks).toEqual({})
    expect(r.sources).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('reads user file when present', () => {
    writeFileSync(
      USER(),
      `hooks:
  PreToolUse:
    - type: bash
      matcher: bash
      command: ./audit.sh
`,
    )
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.sources).toEqual([USER()])
    expect(r.config.hooks.PreToolUse).toHaveLength(1)
    expect(r.config.hooks.PreToolUse![0]).toMatchObject({ type: 'bash', command: './audit.sh' })
  })

  it('reads project file when present', () => {
    writeFileSync(
      PROJ(),
      `hooks:
  SessionStart:
    - type: http
      url: https://example.com/hook
`,
    )
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks.SessionStart).toHaveLength(1)
  })

  it('merges both files per event', () => {
    writeFileSync(
      USER(),
      `hooks:
  PreToolUse:
    - type: bash
      command: user-hook.sh
`,
    )
    writeFileSync(
      PROJ(),
      `hooks:
  PreToolUse:
    - type: bash
      command: project-hook.sh
`,
    )
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks.PreToolUse).toHaveLength(2)
    const cmds = r.config.hooks.PreToolUse!.map((e) => e.command)
    expect(cmds).toContain('user-hook.sh')
    expect(cmds).toContain('project-hook.sh')
    // Both sources surfaced
    expect(r.sources.sort()).toEqual([USER(), PROJ()].sort())
  })

  it('warns and skips invalid YAML', () => {
    writeFileSync(USER(), 'hooks:\n  PreToolUse:\n    - this is: not valid: yaml: at: all\n')
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks.PreToolUse ?? []).toHaveLength(0)
    expect(r.warnings.some((w) => /yaml/i.test(w))).toBe(true)
  })

  it('warns and skips entries with bad schema', () => {
    writeFileSync(
      USER(),
      `hooks:
  PreToolUse:
    - type: bash
      command: ''
`,
    )
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks.PreToolUse ?? []).toHaveLength(0)
    expect(r.warnings.some((w) => /schema/i.test(w))).toBe(true)
  })

  it('warns and skips entries with invalid matcher regex', () => {
    writeFileSync(
      USER(),
      `hooks:
  PreToolUse:
    - type: bash
      matcher: '/[unclosed/'
      command: echo bad
`,
    )
    const r = loadHooksConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.config.hooks.PreToolUse ?? []).toHaveLength(0)
    expect(r.warnings.some((w) => /bad matcher/.test(w))).toBe(true)
  })
})
