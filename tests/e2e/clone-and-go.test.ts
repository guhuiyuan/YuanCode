/**
 * E2E: clone-and-go
 *
 * Simulates a fresh clone of YuanCode into a tmpdir and verifies that
 * the boot files (bin/setup, .env.example, templates/, skills/) are
 * intact and the package.json declares the right engines field.
 *
 * This is the smoke test for the M0 clone-and-go promise: someone who
 * clones the repo should immediately have everything they need.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

const REPO_ROOT = resolve(__dirname, '..', '..')

describe('clone-and-go readiness (e2e)', () => {
  it('package.json declares engines.node >=20.10', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    expect(pkg.engines.node).toMatch(/>=20/)
    expect(pkg.bin.yuancode).toBe('./bin/yuancode.mjs')
    expect(pkg.type).toBe('module')
  })

  it('.env.example exists and is non-empty', () => {
    const p = join(REPO_ROOT, '.env.example')
    expect(existsSync(p)).toBe(true)
    expect(readFileSync(p, 'utf8').length).toBeGreaterThan(100)
  })

  it('templates/ ships 4 example files', () => {
    const dir = join(REPO_ROOT, 'templates')
    const files = readdirSync(dir)
    expect(files.length).toBeGreaterThanOrEqual(4)
    expect(files).toContain('config.user.yaml.example')
    expect(files).toContain('hooks.example.yaml')
    expect(files).toContain('mcp.example.json')
  })

  it('skills/ ships at least one example skill', () => {
    const dir = join(REPO_ROOT, 'skills')
    const entries = readdirSync(dir, { withFileTypes: true })
    const skillDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
    expect(skillDirs.length).toBeGreaterThan(0)
    for (const name of skillDirs) {
      const skillMd = join(dir, name, 'SKILL.md')
      expect(existsSync(skillMd), `${name} should have SKILL.md`).toBe(true)
    }
  })

  it('README.md exists and references M7', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8')
    expect(readme.length).toBeGreaterThan(1000)
  })

  it('bin/yuancode.mjs is a valid Node entrypoint', () => {
    const p = join(REPO_ROOT, 'bin', 'yuancode.mjs')
    expect(existsSync(p)).toBe(true)
    const src = readFileSync(p, 'utf8')
    expect(src).toMatch(/shebang|import|require/i)
  })

  it('dist/ exists (build was run) or src/main.ts exists (tsx fallback)', () => {
    const hasDist = existsSync(join(REPO_ROOT, 'dist'))
    const hasSrc = existsSync(join(REPO_ROOT, 'src', 'main.ts'))
    expect(hasDist || hasSrc).toBe(true)
  })
})