/**
 * Hook matcher — compile + test.
 */
import { describe, expect, it } from 'vitest'
import { compileMatcher } from '../../../src/hooks/matcher.js'

describe('compileMatcher', () => {
  it('undefined → matches everything', () => {
    const m = compileMatcher(undefined)
    expect(m.test('anything')).toBe(true)
    expect(m.test('')).toBe(true)
    expect(m.source).toBeNull()
  })

  it('null → matches everything', () => {
    const m = compileMatcher(null)
    expect(m.test('bash')).toBe(true)
  })

  it('empty string → matches everything', () => {
    const m = compileMatcher('')
    expect(m.test('bash')).toBe(true)
  })

  it('plain string → exact match', () => {
    const m = compileMatcher('bash')
    expect(m.test('bash')).toBe(true)
    expect(m.test('BASH')).toBe(false)
    expect(m.test('bash_extra')).toBe(false)
  })

  it('literal /regex/ → uses RegExp', () => {
    const m = compileMatcher('/^mcp__.*$/')
    expect(m.test('mcp__filesystem__read')).toBe(true)
    expect(m.test('mcp__github__list_issues')).toBe(true)
    expect(m.test('bash')).toBe(false)
  })

  it('string starting with ^ → uses RegExp', () => {
    const m = compileMatcher('^mcp__filesystem__')
    expect(m.test('mcp__filesystem__read')).toBe(true)
    expect(m.test('mcp__github__list')).toBe(false)
  })

  it('string with .* → uses RegExp', () => {
    const m = compileMatcher('.*_tool$')
    expect(m.test('a_tool')).toBe(true)
    expect(m.test('my_tool')).toBe(true)
    expect(m.test('tool')).toBe(false)
    expect(m.test('my_other')).toBe(false)
  })

  it('invalid regex (literal /.../) throws at compile time', () => {
    expect(() => compileMatcher('/[unclosed/')).toThrow(/Invalid hook matcher regex/)
  })

  it('over-long regex throws at compile time', () => {
    const huge = '/' + 'a'.repeat(2000) + '/'
    expect(() => compileMatcher(huge)).toThrow(/too long/)
  })
})
