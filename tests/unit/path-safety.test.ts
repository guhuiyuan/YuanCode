/**
 * Unit tests for src/utils/path-safety.ts.
 *
 * These are deliberately platform-agnostic: we construct paths via
 * `path.join` and use `..` segments the same way on any OS.
 */
import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  PathAccessError,
  displayPath,
  ensureInsideRoot,
  isForbiddenPath,
  safeResolve,
} from '../../src/utils/path-safety.js'

describe('ensureInsideRoot', () => {
  it('accepts a path equal to the root', async () => {
    const root = resolve('/tmp')
    const out = await ensureInsideRoot(root, root)
    expect(out).toBe(root)
  })

  it('accepts a path inside the root', async () => {
    const root = resolve('/tmp')
    const out = await ensureInsideRoot(join(root, 'foo', 'bar.ts'), root)
    expect(out).toBe(join(root, 'foo', 'bar.ts'))
  })

  it('rejects a path with ../ traversal', async () => {
    const root = resolve('/tmp')
    await expect(ensureInsideRoot(join(root, '..', 'etc', 'passwd'), root)).rejects.toThrow(
      PathAccessError,
    )
  })

  it('rejects an absolute path outside the root', async () => {
    const root = resolve('/tmp/project')
    await expect(ensureInsideRoot('/etc/passwd', root)).rejects.toThrow(PathAccessError)
  })
})

describe('isForbiddenPath', () => {
  it('blocks ~/.ssh', () => {
    expect(isForbiddenPath('/home/user/.ssh/id_rsa')).toBe(true)
  })

  it('blocks ~/.aws', () => {
    expect(isForbiddenPath('/Users/me/.aws/credentials')).toBe(true)
  })

  it('blocks C:\\Windows\\System32', () => {
    expect(isForbiddenPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true)
  })

  it('blocks /etc/passwd', () => {
    expect(isForbiddenPath('/etc/passwd')).toBe(true)
  })

  it('does not block normal project paths', () => {
    expect(isForbiddenPath('/home/user/project/src/foo.ts')).toBe(false)
  })
})

describe('safeResolve', () => {
  it('passes through normal paths', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuan-safe-'))
    try {
      const f = join(dir, 'a.txt')
      await writeFile(f, 'hi', 'utf8')
      const out = await safeResolve(f, dir)
      expect(out).toBe(f)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'yuan-safe-'))
    try {
      const evil = join(dir, '..', 'evil.txt')
      await expect(safeResolve(evil, dir)).rejects.toThrow(PathAccessError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects forbidden system paths', async () => {
    await expect(safeResolve('/home/user/.ssh/id_rsa', '/tmp')).rejects.toThrow(
      PathAccessError,
    )
  })
})

describe('displayPath', () => {
  it('shows relative path when inside root', () => {
    expect(displayPath('/tmp/proj/src/foo.ts', '/tmp/proj')).toBe(
      join('src', 'foo.ts'),
    )
  })

  it('falls back to absolute when outside root', () => {
    expect(displayPath('/etc/passwd', '/tmp/proj')).toBe('/etc/passwd')
  })

  it('returns the absolute path when no root given', () => {
    expect(displayPath('/etc/passwd')).toBe('/etc/passwd')
  })
})
