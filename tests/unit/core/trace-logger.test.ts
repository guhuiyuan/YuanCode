/**
 * TraceLogger — span lifecycle, sampling, FIFO cap, JSONL flush.
 */
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TraceLogger } from '../../../src/core/trace-logger.js'

function noopLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    silent: vi.fn(),
    child: vi.fn(function () { return this }),
  }
}

describe('TraceLogger', () => {
  it('starts a root span with traceId + spanId', () => {
    const log = noopLogger()
    const t = new TraceLogger({ sessionId: 's1', logger: log as never })
    const span = t.startRoot('loop.run')
    expect(span.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(span.spanId).toMatch(/^[0-9a-f-]{36}$/)
    expect(span.status).toBe('running')
    expect(t.liveCount()).toBe(1)
  })

  it('startChild inherits traceId, sets parentSpanId', () => {
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never })
    const root = t.startRoot('parent')
    const child = t.startChild(root, 'child')
    expect(child.traceId).toBe(root.traceId)
    expect(child.parentSpanId).toBe(root.spanId)
    expect(child.spanId).not.toBe(root.spanId)
  })

  it('endSpan sets status + duration, drops live, logs once', () => {
    const log = noopLogger()
    const t = new TraceLogger({ sessionId: 's1', logger: log as never })
    const span = t.startRoot('op')
    t.endSpan(span, 'ok')
    expect(span.status).toBe('ok')
    expect(span.endTime).toBeGreaterThanOrEqual(span.startTime)
    expect(t.liveCount()).toBe(0)
    expect(log.info).toHaveBeenCalledTimes(1)
  })

  it('endSpan with error captures errorMessage', () => {
    const log = noopLogger()
    const t = new TraceLogger({ sessionId: 's1', logger: log as never })
    const span = t.startRoot('op')
    t.endSpan(span, 'error', new Error('boom'))
    expect(span.errorMessage).toBe('boom')
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', error: 'boom' }),
      expect.any(String),
    )
  })

  it('run() auto-ends ok on resolve, error on throw', async () => {
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never })
    const out = await t.run(null, 'add', async () => 42)
    expect(out).toBe(42)
    expect(t.snapshot().spans[0]?.status).toBe('ok')

    await expect(t.run(null, 'fail', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    const snap = t.snapshot()
    const failed = snap.spans.find((s) => s.name === 'fail')
    expect(failed?.status).toBe('error')
    expect(failed?.errorMessage).toBe('nope')
  })

  it('addEvent appends to span, ignored after end', () => {
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never })
    const span = t.startRoot('op')
    t.addEvent(span, 'cache_hit', { size: 100 })
    expect(span.events).toEqual([
      { name: 'cache_hit', time: expect.any(Number), attributes: { size: 100 } },
    ])
    t.endSpan(span, 'ok')
    t.addEvent(span, 'late') // should be ignored
    expect(span.events.length).toBe(1)
  })

  it('sampling 0 records no spans and emits no logs', () => {
    const log = noopLogger()
    const t = new TraceLogger({ sessionId: 's1', logger: log as never, sampleRate: 0 })
    t.startRoot('x')
    expect(t.snapshot().spans.length).toBe(0)
    expect(log.info).not.toHaveBeenCalled()
  })

  it('maxSpans drops oldest spans from history (FIFO)', () => {
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never, maxSpans: 3 })
    for (let i = 0; i < 5; i++) {
      const s = t.startRoot(`op-${i}`)
      t.endSpan(s, 'ok')
    }
    expect(t.totalSpans()).toBe(3)
    const names = t.snapshot().spans.map((s) => s.name)
    expect(names).toEqual(['op-2', 'op-3', 'op-4'])
  })

  it('flush() writes JSONL to sink file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-flush-'))
    const sink = join(dir, 'trace.jsonl')
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never, sinkPath: sink })
    const root = t.startRoot('parent')
    const child = t.startChild(root, 'child')
    t.addEvent(child, 'evt')
    t.endSpan(child, 'ok')
    t.endSpan(root, 'ok')
    await t.flush()
    expect(existsSync(sink)).toBe(true)
    const lines = readFileSync(sink, 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].name).toBe('parent')
    expect(parsed[1].name).toBe('child')
    expect(parsed[1].parentSpanId).toBe(parsed[0].spanId)
    expect(parsed[1].status).toBe('ok')
    expect(parsed[1].events[0].name).toBe('evt')
    rmSync(dir, { recursive: true, force: true })
  })

  it('flush() is a no-op when no spans recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-noop-'))
    const sink = join(dir, 'trace.jsonl')
    const t = new TraceLogger({ sessionId: 's1', logger: noopLogger() as never, sinkPath: sink })
    await t.flush()
    expect(existsSync(sink)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })
})