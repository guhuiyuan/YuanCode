/**
 * Skills loader — index scan, body load, format.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSkillsIndex,
  loadSkillBody,
  formatSkillsIndex,
} from '../../../src/extensions/skills.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'yuancode-skills-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function makeSkill(name: string, desc: string, body: string, whenToUse?: string): void {
  const d = join(dir, 'skills', name)
  mkdirSync(d, { recursive: true })
  const front = whenToUse ? `when_to_use: ${whenToUse}\n` : ''
  writeFileSync(
    join(d, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n${front}---\n\n${body}\n`,
    'utf8',
  )
}

describe('loadSkillsIndex — empty / missing root', () => {
  it('returns empty index when skills/ does not exist', () => {
    const idx = loadSkillsIndex(dir)
    expect(idx.entries).toHaveLength(0)
    expect(idx.byName.size).toBe(0)
  })

  it('returns empty index when skills/ is empty', () => {
    mkdirSync(join(dir, 'skills'))
    const idx = loadSkillsIndex(dir)
    expect(idx.entries).toHaveLength(0)
  })
})

describe('loadSkillsIndex — happy path', () => {
  it('parses a single SKILL.md with name + description', () => {
    makeSkill('greet', 'Say hello to the user.', 'Howdy!')
    const idx = loadSkillsIndex(dir)
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.name).toBe('greet')
    expect(idx.entries[0]?.description).toContain('hello')
    expect(idx.entries[0]?.body).toContain('Howdy!')
    expect(idx.byName.get('greet')).toBe(idx.entries[0])
  })

  it('parses when_to_use into the entry', () => {
    makeSkill('greet', 'greeting', 'body', "user says 'hi'")
    const idx = loadSkillsIndex(dir)
    expect(idx.entries[0]?.whenToUse).toBe("user says 'hi'")
  })

  it('skips directories without SKILL.md', () => {
    mkdirSync(join(dir, 'skills', 'no-skill-md'), { recursive: true })
    makeSkill('greet', 'd', 'b')
    const idx = loadSkillsIndex(dir)
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.name).toBe('greet')
  })

  it('skips non-directory files at the root of skills/', () => {
    mkdirSync(join(dir, 'skills'))
    writeFileSync(join(dir, 'skills', 'README.md'), 'ignore me')
    makeSkill('greet', 'd', 'b')
    const idx = loadSkillsIndex(dir)
    expect(idx.entries.map((e) => e.name)).toEqual(['greet'])
  })

  it('reports broken entries when frontmatter is missing', () => {
    mkdirSync(join(dir, 'skills', 'bad'), { recursive: true })
    writeFileSync(
      join(dir, 'skills', 'bad', 'SKILL.md'),
      'No frontmatter here.\nJust body.',
      'utf8',
    )
    const idx = loadSkillsIndex(dir)
    expect(idx.entries).toHaveLength(1)
    expect(idx.entries[0]?.description).toMatch(/missing.*frontmatter/)
  })

  it('sorts entries alphabetically by name', () => {
    makeSkill('z', 'z', 'z')
    makeSkill('a', 'a', 'a')
    makeSkill('m', 'm', 'm')
    const idx = loadSkillsIndex(dir)
    expect(idx.entries.map((e) => e.name)).toEqual(['a', 'm', 'z'])
  })
})

describe('loadSkillBody', () => {
  it('returns the body after the front-matter block', () => {
    makeSkill('greet', 'd', '# Heading\n\nBody line.')
    const idx = loadSkillsIndex(dir)
    const body = loadSkillBody(idx, 'greet')
    expect(body).toBe('# Heading\n\nBody line.')
  })

  it('returns null for an unknown skill name', () => {
    makeSkill('greet', 'd', 'b')
    const idx = loadSkillsIndex(dir)
    expect(loadSkillBody(idx, 'does-not-exist')).toBeNull()
  })

  it('caches the body on the entry', () => {
    makeSkill('greet', 'd', 'body')
    const idx = loadSkillsIndex(dir)
    const e = idx.byName.get('greet')!
    expect(e.body).toBe('body') // already populated by loadSkillsIndex
  })
})

describe('formatSkillsIndex', () => {
  it('returns empty string for an empty index', () => {
    const idx = loadSkillsIndex(dir)
    expect(formatSkillsIndex(idx)).toBe('')
  })

  it('produces a token-cheap one-liner per skill', () => {
    makeSkill('a', 'first', 'body')
    makeSkill('b', 'second', 'body', "user says 'b'")
    const idx = loadSkillsIndex(dir)
    const out = formatSkillsIndex(idx)
    expect(out).toMatch(/<SKILLS>/)
    expect(out).toContain('`a`: first')
    expect(out).toContain('`b`: second — user says \'b\'')
    // No skill body should leak in
    expect(out).not.toContain('body')
  })
})
