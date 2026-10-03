import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnv } from '../../src/utils/env.js'

describe('loadEnv', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'yuan-env-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    delete process.env.YUAN_TEST_VAR
    delete process.env.YUAN_TEST_QUOTED
    delete process.env.YUAN_TEST_REF
  })

  it('loads simple KEY=VALUE pairs', () => {
    const p = join(dir, '.env')
    writeFileSync(p, 'YUAN_TEST_VAR=hello\n# a comment\n\nYUAN_TEST_QUOTED="quoted value"\n')
    const r = loadEnv({ path: p })
    expect(r.loaded).toBe(2)
    expect(process.env.YUAN_TEST_VAR).toBe('hello')
    expect(process.env.YUAN_TEST_QUOTED).toBe('quoted value')
  })

  it('expands ${VAR} references', () => {
    process.env.OUTER = 'outer-value'
    const p = join(dir, '.env')
    writeFileSync(p, 'YUAN_TEST_REF=prefix-${OUTER}-suffix\n')
    loadEnv({ path: p })
    expect(process.env.YUAN_TEST_REF).toBe('prefix-outer-value-suffix')
  })

  it('does not overwrite pre-existing env vars when preserveExisting=true', () => {
    process.env.YUAN_TEST_VAR = 'pre'
    const p = join(dir, '.env')
    writeFileSync(p, 'YUAN_TEST_VAR=file-value\n')
    loadEnv({ path: p, preserveExisting: true })
    expect(process.env.YUAN_TEST_VAR).toBe('pre')
  })

  it('returns loaded=0 when file missing', () => {
    const r = loadEnv({ path: join(dir, 'nope.env') })
    expect(r.loaded).toBe(0)
    expect(r.path).toBeNull()
  })
})
