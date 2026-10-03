/**
 * ContextCompactor — three-layer compression.
 *
 * We test each layer independently (snip, microcompact, collapse) and the
 * combined `compact()` API. The collapse layer needs a mock Provider — we
 * build a minimal one inline.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  ContextCompactor,
  snipToolResults,
  microcompact,
  type CompactorOptions,
} from '../../../src/core/context-compactor.js'
import type { ChatMessage, ContentBlock, Provider, ChatResponse } from '../../../src/model/provider.js'

function opts(over: Partial<CompactorOptions> = {}): CompactorOptions {
  return { contextWindow: 1000, ...over }
}

function mockProvider(reply = 'summary text'): Provider {
  return {
    name: 'mock',
    async chat({ messages }): Promise<ChatResponse> {
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: reply }],
        },
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      }
    },
    async *stream(): AsyncGenerator<never> {},
  } as unknown as Provider
}

describe('snipToolResults', () => {
  it('truncates oversized tool_result content', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'x'.repeat(5000),
            is_error: false,
          },
        ],
      },
    ]
    snipToolResults(messages, 1000)
    const block = (messages[0]!.content as ContentBlock[])[0]! as { content: string }
    expect((block.content as string).length).toBeLessThan(1100)
    expect(block.content).toMatch(/truncated/)
  })

  it('leaves short tool_results alone', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'short', is_error: false },
        ],
      },
    ]
    snipToolResults(messages, 1024)
    const block = (messages[0]!.content as ContentBlock[])[0]! as { content: string }
    expect(block.content).toBe('short')
  })

  it('is idempotent — does not double-truncate', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000), is_error: false },
        ],
      },
    ]
    snipToolResults(messages, 1000)
    const before = (messages[0]!.content as ContentBlock[])[0]! as { content: string }
    snipToolResults(messages, 1000)
    const after = (messages[0]!.content as ContentBlock[])[0]! as { content: string }
    expect(after.content).toBe(before.content)
  })

  it('does not touch plain text messages', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }]
    snipToolResults(messages, 10)
    expect(messages[0]!.content).toBe('hi')
  })

  it('handles tool_result with array content', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [
              { type: 'text', text: 'A'.repeat(2000) },
              { type: 'text', text: 'B'.repeat(2000) },
            ],
            is_error: false,
          },
        ],
      },
    ]
    snipToolResults(messages, 1000)
    const block = (messages[0]!.content as ContentBlock[])[0]! as { content: unknown }
    // snipToolResults rewrites block.content to a single truncated string
    expect(typeof block.content).toBe('string')
    expect((block.content as string).length).toBeLessThan(1100)
    expect(block.content as string).toMatch(/truncated/)
  })
})

describe('microcompact', () => {
  it('replaces old tool steps with a placeholder', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'step 1 prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'edit', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '1', content: 'old result', is_error: false }],
      },
      { role: 'user', content: 'step 2 prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '2', name: 'edit', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: '2', content: 'recent result', is_error: false }],
      },
    ]
    microcompact(messages, 2)
    // The older tool_use/tool_result pair (and any leading prompt) should be
    // collapsed into a single placeholder string. The recent step (index 3-5)
    // is preserved.
    expect(messages[0]!.role).toBe('user')
    expect(typeof messages[0]!.content).toBe('string')
    expect(messages[0]!.content as string).toMatch(/omitted/i)
    expect(messages.length).toBeLessThan(6)
    // The recent step must still be present
    const hasRecent = messages.some(
      (m) =>
        typeof m.content !== 'string' &&
        (m.content as ContentBlock[]).some((b) => b.type === 'tool_result'),
    )
    expect(hasRecent).toBe(true)
  })

  it('does nothing when message list is shorter than keepLast', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'edit', input: {} }],
      },
    ]
    const before = messages.length
    microcompact(messages, 5)
    expect(messages.length).toBe(before)
  })

  it('does nothing if the head contains no tool steps', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]
    const before = JSON.stringify(messages)
    microcompact(messages, 1)
    expect(JSON.stringify(messages)).toBe(before)
  })
})

describe('ContextCompactor — auto mode', () => {
  it('runs snip every call', async () => {
    const c = new ContextCompactor(opts({ snipBytes: 100 }))
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(500), is_error: false },
        ],
      },
    ]
    await c.compact(messages, mockProvider())
    expect(messages.length).toBe(1)
  })

  it('does not run microcompact before the every-N threshold', async () => {
    const c = new ContextCompactor(opts({ microcompactEvery: 5 }))
    const messages: ChatMessage[] = [
      { role: 'user', content: 'old prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'edit', input: {} }],
      },
      { role: 'user', content: 'recent prompt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '2', name: 'edit', input: {} }],
      },
    ]
    const before = messages.length
    await c.compact(messages, mockProvider())
    expect(messages.length).toBe(before)
  })

  it('runs microcompact after the every-N threshold', async () => {
    const c = new ContextCompactor(opts({ microcompactEvery: 3, microcompactKeepLast: 1 }))
    const baseMessages: ChatMessage[] = [
      { role: 'user', content: 'p1' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '1', name: 'edit', input: {} }],
      },
      { role: 'user', content: 'p2' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '2', name: 'edit', input: {} }],
      },
      { role: 'user', content: 'p3' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: '3', name: 'edit', input: {} }],
      },
    ]
    // Need to call compact() microcompactEvery times before it fires (auto mode).
    let result
    for (let i = 0; i < 3; i++) {
      const m = baseMessages.slice()
      result = await c.compact(m, mockProvider())
    }
    expect(result!.fired).toContain('microcompact')
  })

  it('runs collapse only when over threshold', async () => {
    const provider = mockProvider('SUMMARY')
    // Threshold 0.8, window 100 tokens. With 10 long messages we'll exceed it.
    const c = new ContextCompactor(opts({ contextWindow: 100, collapseThreshold: 0.5 }))
    const longText = 'word '.repeat(40)
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${longText}` })
    }
    const result = await c.compact(messages, provider)
    expect(result.fired).toContain('collapse')
  })

  it('skips collapse when provider returns empty text', async () => {
    const provider = mockProvider('   ') // whitespace only
    const c = new ContextCompactor(opts({ contextWindow: 100, collapseThreshold: 0.5 }))
    const longText = 'word '.repeat(40)
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${longText}` })
    }
    const result = await c.compact(messages, provider)
    expect(result.fired).not.toContain('collapse')
  })

  it('skips collapse when provider throws', async () => {
    const provider: Provider = {
      name: 'mock',
      async chat() {
        throw new Error('network down')
      },
      async *stream() {},
    } as unknown as Provider
    const c = new ContextCompactor(opts({ contextWindow: 100, collapseThreshold: 0.5 }))
    const longText = 'word '.repeat(40)
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${longText}` })
    }
    const result = await c.compact(messages, provider)
    expect(result.fired).not.toContain('collapse')
  })
})

describe('ContextCompactor — manual mode', () => {
  it('forces a collapse even when below threshold', async () => {
    const provider = mockProvider('MANUAL')
    const c = new ContextCompactor(opts({ contextWindow: 100000, collapseThreshold: 0.99 }))
    const longText = 'word '.repeat(40) // enough tokens to clear the 200-token min
    const messages: ChatMessage[] = []
    for (let i = 0; i < 12; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m-${i}: ${longText}`,
      })
    }
    const result = await c.compact(messages, provider, { trigger: 'manual' })
    expect(result.fired).toContain('collapse')
  })

  it('collapses only once (maxSummaries)', async () => {
    const provider = mockProvider('SUMMARY')
    const c = new ContextCompactor(opts({ contextWindow: 100, collapseThreshold: 0.5 }))
    const longText = 'word '.repeat(40)
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${longText}` })
    }
    await c.compact(messages, provider, { trigger: 'manual' })
    const r2 = await c.compact(messages, provider, { trigger: 'manual' })
    expect(r2.fired).not.toContain('collapse')
  })

  it('reports before/after token counts', async () => {
    const c = new ContextCompactor(opts())
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a'.repeat(2000) },
      { role: 'assistant', content: 'b'.repeat(2000) },
    ]
    const r = await c.compact(messages, mockProvider())
    expect(r.tokensBefore).toBeGreaterThan(0)
    expect(r.tokensAfter).toBeGreaterThan(0)
  })

  it('exposes provider spy correctly (sanity check on mock)', async () => {
    const chat = vi.fn(async () => ({
      message: { role: 'assistant', content: 'ok' },
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn' as const,
    }))
    const provider: Provider = {
      name: 'spy',
      chat,
      async *stream() {},
    } as unknown as Provider
    const c = new ContextCompactor(opts({ contextWindow: 50, collapseThreshold: 0.5 }))
    const longText = 'word '.repeat(40)
    const messages: ChatMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `${i}: ${longText}` })
    }
    await c.compact(messages, provider)
    expect(chat).toHaveBeenCalled()
  })
})