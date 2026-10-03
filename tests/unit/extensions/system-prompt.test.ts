/**
 * System prompt builder.
 */
import { describe, expect, it } from 'vitest'
import { loadYuanMd, loadSkillsIndex, buildSystemPrompt } from '../../../src/extensions/index.js'

describe('buildSystemPrompt', () => {
  it('returns the base identity when nothing is configured', () => {
    const prompt = buildSystemPrompt({
      yuan: { user: null, project: null, local: null, combined: '' },
      skills: { entries: [], byName: new Map() },
    })
    expect(prompt).toContain('You are YuanCode')
    expect(prompt).not.toContain('<YUAN>')
    expect(prompt).not.toContain('<SKILLS>')
  })

  it('includes a <YUAN> block when any Yuan.md layer is present', () => {
    const yuan = loadYuanMd('tests') // may or may not exist; we mock instead
    const overridden = { ...yuan, combined: '<YUAN_SCOPE name="user" source="x">\nfoo\n</YUAN_SCOPE>' }
    const prompt = buildSystemPrompt({
      yuan: overridden,
      skills: { entries: [], byName: new Map() },
    })
    expect(prompt).toContain('<YUAN>')
    expect(prompt).toContain('<YUAN_SCOPE name="user"')
    expect(prompt).toContain('foo')
  })

  it('includes a <SKILLS> block when the skill index has entries', () => {
    const prompt = buildSystemPrompt({
      yuan: { user: null, project: null, local: null, combined: '' },
      skills: {
        entries: [
          {
            name: 'demo',
            description: 'demo skill',
            path: '/tmp/skills/demo/SKILL.md',
            dir: '/tmp/skills/demo',
          },
        ],
        byName: new Map(),
      },
    })
    expect(prompt).toContain('<SKILLS>')
    expect(prompt).toContain('`demo`: demo skill')
  })

  it('base identity comes first; Yuan.md second; Skills third', () => {
    const prompt = buildSystemPrompt({
      yuan: {
        user: null,
        project: null,
        local: null,
        combined: '<YUAN_SCOPE name="local" source="x">\nlocal content\n</YUAN_SCOPE>',
      },
      skills: {
        entries: [
          {
            name: 'demo',
            description: 'demo skill',
            path: '/x',
            dir: '/x',
          },
        ],
        byName: new Map(),
      },
    })
    const i = prompt.indexOf('You are YuanCode')
    const y = prompt.indexOf('<YUAN>')
    const s = prompt.indexOf('<SKILLS>')
    expect(i).toBeLessThan(y)
    expect(y).toBeLessThan(s)
  })
})
