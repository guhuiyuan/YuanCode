/**
 * Yuan.md loader — three-layer merge with no-fail on missing files.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import { loadYuanMd } from '../../../src/extensions/yuan-md.js'

let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-yuan-'))
  // Redirect homedir()-based user layer to our temp dir by symlinking.
  // We can't redirect homedir() inside the loader (it uses os.homedir()),
  // so the user-layer test reads/writes `~/.yuancode/YUAN.md` for real.
  // To avoid touching the real home, we set HOME/USERPROFILE.
  prevHome = process.env.HOME
  if (process.platform === 'win32') {
    process.env.USERPROFILE = dir
    process.env.HOME = dir
  } else {
    process.env.HOME = dir
  }
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  if (process.platform === 'win32') {
    // Best effort — restore whatever USERPROFILE was originally.
    delete process.env.USERPROFILE
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('loadYuanMd — missing files', () => {
  it('returns all-null layers when no Yuan.md exists anywhere', () => {
    const y = loadYuanMd(dir)
    expect(y.user).toBeNull()
    expect(y.project).toBeNull()
    expect(y.local).toBeNull()
    expect(y.combined).toBe('')
  })

  it('returns null when the file is empty (no content)', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, '.yuancode', 'YUAN.md'), '   \n  \n', 'utf8')
    const y = loadYuanMd(dir)
    // empty content → loader returns null for that layer
    expect(y.user).toBeNull()
    expect(y.combined).toBe('')
  })
})

describe('loadYuanMd — single layer', () => {
  it('loads only the project layer', () => {
    writeFileSync(join(dir, 'Yuan.md'), '# Project Rules\nUse TypeScript.', 'utf8')
    const y = loadYuanMd(dir)
    expect(y.project).not.toBeNull()
    expect(y.project?.content).toContain('TypeScript')
    expect(y.user).toBeNull()
    expect(y.local).toBeNull()
    expect(y.combined).toMatch(/<YUAN_SCOPE name="project"/)
    expect(y.combined).toContain('TypeScript')
  })

  it('loads only the local layer', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, '.yuancode', 'YUAN.local.md'), 'local-only', 'utf8')
    const y = loadYuanMd(dir)
    expect(y.local).not.toBeNull()
    expect(y.local?.content).toBe('local-only')
    expect(y.combined).toMatch(/<YUAN_SCOPE name="local"/)
  })

  it('loads the user layer (via HOME/USERPROFILE)', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, '.yuancode', 'YUAN.md'), 'user-level rule', 'utf8')
    const y = loadYuanMd(dir)
    expect(y.user).not.toBeNull()
    expect(y.user?.content).toBe('user-level rule')
    expect(y.combined).toMatch(/<YUAN_SCOPE name="user"/)
  })
})

describe('loadYuanMd — three-layer merge', () => {
  it('merges user → project → local in that order', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, '.yuancode', 'YUAN.md'), 'USER_LAYER', 'utf8')
    writeFileSync(join(dir, 'Yuan.md'), 'PROJECT_LAYER', 'utf8')
    writeFileSync(join(dir, '.yuancode', 'YUAN.local.md'), 'LOCAL_LAYER', 'utf8')

    const y = loadYuanMd(dir)
    expect(y.combined).toContain('USER_LAYER')
    expect(y.combined).toContain('PROJECT_LAYER')
    expect(y.combined).toContain('LOCAL_LAYER')

    // user must come before project must come before local
    const u = y.combined.indexOf('USER_LAYER')
    const p = y.combined.indexOf('PROJECT_LAYER')
    const l = y.combined.indexOf('LOCAL_LAYER')
    expect(u).toBeLessThan(p)
    expect(p).toBeLessThan(l)
  })

  it('records absolute paths in each layer', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, 'Yuan.md'), 'x', 'utf8')
    const y = loadYuanMd(dir)
    expect(y.project?.path.startsWith(dir)).toBe(true)
    // path should be absolute on every platform
    const expected = dir.split(sep).join(sep)
    expect(y.project?.path.startsWith(expected)).toBe(true)
  })

  it('drops layers with invalid (empty) content silently', () => {
    mkdirSync(join(dir, '.yuancode'), { recursive: true })
    writeFileSync(join(dir, '.yuancode', 'YUAN.md'), 'USER', 'utf8')
    writeFileSync(join(dir, 'Yuan.md'), '   \n\n', 'utf8') // empty → null
    const y = loadYuanMd(dir)
    expect(y.user).not.toBeNull()
    expect(y.project).toBeNull()
    expect(y.combined).toContain('USER')
    expect(y.combined).not.toContain('PROJECT') // it was empty
  })
})
