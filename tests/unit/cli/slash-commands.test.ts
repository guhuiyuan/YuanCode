/**
 * Slash commands — /exit, /help, /compact, /rewind, /clear, /session.
 */
import { describe, expect, it } from 'vitest'
import { handleSlash, type SlashContext } from '../../../src/cli/slash-commands.js'

const baseCtx: SlashContext = {
  sessionId: 's1',
}

describe('slash — exit', () => {
  it('/exit, /quit, /q all return exit', () => {
    expect(handleSlash('/exit', baseCtx)).toEqual({ kind: 'exit' })
    expect(handleSlash('/quit', baseCtx)).toEqual({ kind: 'exit' })
    expect(handleSlash('/q', baseCtx)).toEqual({ kind: 'exit' })
  })
})

describe('slash — help', () => {
  it('/help shows the command list', () => {
    const r = handleSlash('/help', baseCtx)
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.text).toContain('/compact')
      expect(r.text).toContain('/rewind')
      expect(r.text).toContain('/clear')
    }
  })
})

describe('slash — compact', () => {
  it('/compact returns a manual trigger', () => {
    expect(handleSlash('/compact', baseCtx)).toEqual({
      kind: 'compact',
      trigger: 'manual',
    })
  })
})

describe('slash — rewind', () => {
  it('returns snapshots from the context', () => {
    const ctx: SlashContext = {
      ...baseCtx,
      listCheckpoints: () => [
        {
          id: 'a',
          path: '/foo',
          mode: 0o644,
          content: Buffer.from(''),
          createdAt: 1,
          label: 'write',
        },
      ],
    }
    const r = handleSlash('/rewind', ctx)
    expect(r.kind).toBe('rewind')
    if (r.kind === 'rewind') {
      expect(r.snapshots).toHaveLength(1)
      expect(r.sessionId).toBe('s1')
    }
  })

  it('reports no checkpoints gracefully', () => {
    const r = handleSlash('/rewind', { ...baseCtx, listCheckpoints: () => [] })
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.tone).toBe('info')
      expect(r.text).toMatch(/No checkpoints/)
    }
  })

  it('handles /rewind list explicitly', () => {
    const ctx: SlashContext = {
      ...baseCtx,
      listCheckpoints: () => [
        {
          id: 'a',
          path: '/foo',
          mode: 0,
          content: Buffer.from(''),
          createdAt: 1,
          label: 'x',
        },
      ],
    }
    const r = handleSlash('/rewind list', ctx)
    expect(r.kind).toBe('rewind')
  })

  it('handles /rewind with no listCheckpoints function', () => {
    const r = handleSlash('/rewind', baseCtx)
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.text).toMatch(/No checkpoints/)
    }
  })

  it('rejects unknown subcommands', () => {
    const r = handleSlash('/rewind foo', {
      ...baseCtx,
      listCheckpoints: () => [
        {
          id: 'a',
          path: '/a',
          mode: 0,
          content: Buffer.from(''),
          createdAt: 1,
          label: 'x',
        },
      ],
    })
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.tone).toBe('error')
    }
  })
})

describe('slash — clear', () => {
  it('/clear returns clear-history', () => {
    expect(handleSlash('/clear', baseCtx)).toEqual({ kind: 'clear-history' })
  })
})

describe('slash — session', () => {
  it('prints session id, message count, step count, tokens', () => {
    const r = handleSlash('/session', {
      ...baseCtx,
      usage: { input: 100, output: 50 },
      steps: 3,
      messageCount: 7,
    })
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.multiline).toBe(true)
      expect(r.text).toContain('session: s1')
      expect(r.text).toContain('100 / 50')
      expect(r.text).toContain('steps this turn: 3')
      expect(r.text).toContain('messages in flight: 7')
    }
  })

  it('handles missing usage / steps', () => {
    const r = handleSlash('/session', baseCtx)
    if (r.kind === 'show') {
      expect(r.text).toContain('0 / 0')
    }
  })
})

describe('slash — unknown command', () => {
  it('returns an error tone result', () => {
    const r = handleSlash('/whatever', baseCtx)
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.tone).toBe('error')
      expect(r.text).toContain('Unknown command')
    }
  })
})

describe('slash — non-slash input', () => {
  it('returns an error for plain text input', () => {
    const r = handleSlash('hello world', baseCtx)
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.tone).toBe('error')
    }
  })

  it('returns an error for an empty string', () => {
    const r = handleSlash('', baseCtx)
    expect(r.kind).toBe('show')
    if (r.kind === 'show') {
      expect(r.tone).toBe('error')
    }
  })
})

describe('slash — case insensitivity', () => {
  it('upper-case command names work', () => {
    expect(handleSlash('/EXIT', baseCtx).kind).toBe('exit')
    expect(handleSlash('/Help', baseCtx).kind).toBe('show')
    expect(handleSlash('/Compact', baseCtx).kind).toBe('compact')
  })
})