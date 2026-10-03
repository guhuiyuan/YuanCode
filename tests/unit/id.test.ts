import { describe, expect, it } from 'vitest'
import { newId, randomId, shortId } from '../../src/utils/id.js'

describe('id helpers', () => {
  it('newId returns a UUID v7 (time-ordered)', () => {
    const a = newId()
    const b = newId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    // v7 IDs generated in the same millisecond must sort lexicographically
    // because the first 48 bits are a unix timestamp in ms.
    expect(a < b).toBe(true)
  })

  it('randomId returns a UUID v4', () => {
    const a = randomId()
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('shortId is 8 characters', () => {
    expect(shortId()).toHaveLength(8)
  })
})
