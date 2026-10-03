/**
 * E2E: TraceLogger
 *
 * Exercises span lifecycle, child relationships, JSONL flush, sampling,
 * FIFO drop on overflow.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pino from 'pino'
import { TraceLogger } from '../../dist/core/trace-logger.js'

function silentPino() {
  return pino({ level: 'silent' })
}

describe('TraceLogger (e2e)', () => {
  it('startRoot produces a uuid traceId + spanId', () => {
    const t = new TraceLogger({ sessionId: 'e2e-tr', logger: silentPino() })
    const s = t.startRoot('loop.run')
    expect(s.traceId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.spanId).toMatch(/^[0-9a-f-]{36}$/)
    expect(s.status).toBe('running')
    t.endSpan(s, 'ok')
    expect(s.status).toBe('ok')
    expect(t.liveCount()).toBe(0)
  })

  it('child inherits traceId, sets parentSpanId', () => {
    const t = new TraceLogger({ sessionId: 'e2e-tr', logger: silentPino() })
    const root = t.startRoot('r')
    const child = t.startChild(root, 'c')
    expect(child.traceId).toBe(root.traceId)
    expect(child.parentSpanId).toBe(root.spanId)
    t.endSpan(child, 'ok')
    t.endSpan(root, 'ok')
  })

  it('run() auto-ends with ok on resolve, error on throw', async () => {
    const t = new TraceLogger({ sessionId: 'e2e-tr', logger: silentPino() })
    await expect(
      t.run(null, 'op', async () => 42),
    ).resolves.toBe(42)
    await expect(
      t.run(null, 'fail', async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
    const snap = t.snapshot()
    expect(snap.spans.find((s) => s.name === 'op')?.status).toBe('ok')
    expect(snap.spans.find((s) => s.name === 'fail')?.status).toBe('error')
  })

  it('flush() writes JSONL with parent + child', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trace-e2e-'))
    const sink = join(dir, 'trace.jsonl')
    try {
      const t = new TraceLogger({ sessionId: 'e2e-flush', logger: silentPino(), sinkPath: sink })
      const root = t.startRoot('root')
      const c = t.startChild(root, 'child')
      t.endSpan(c, 'ok')
      t.endSpan(root, 'ok')
      await t.flush()
      expect(existsSync(sink)).toBe(true)
      const lines = readFileSync(sink, 'utf8').trim().split('\n')
      expect(lines.length).toBe(2)
      const parsed = lines.map((l) => JSON.parse(l))
      expect(parsed[0].name).toBe('root')
      expect(parsed[1].name).toBe('child')
      expect(parsed[1].parentSpanId).toBe(parsed[0].spanId)
      expect(parsed[1].traceId).toBe(parsed[0].traceId)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sampleRate=0 records nothing', () => {
    const t = new TraceLogger({
      sessionId: 'e2e-tr',
      logger: silentPino(),
      sampleRate: 0,
    })
    t.startRoot('x')
    expect(t.snapshot().spans.length).toBe(0)
  })

  it('maxSpans drops oldest (FIFO)', () => {
    const t = new TraceLogger({
      sessionId: 'e2e-tr',
      logger: silentPino(),
      maxSpans: 3,
    })
    for (let i = 0; i < 5; i++) {
      const s = t.startRoot(`s-${i}`)
      t.endSpan(s, 'ok')
    }
    expect(t.totalSpans()).toBe(3)
    const names = t.snapshot().spans.map((s) => s.name)
    expect(names).toEqual(['s-2', 's-3', 's-4'])
  })

  it('addEvent is ignored after endSpan', () => {
    const t = new TraceLogger({ sessionId: 'e2e-tr', logger: silentPino() })
    const s = t.startRoot('op')
    t.addEvent(s, 'evt1', { k: 1 })
    t.endSpan(s, 'ok')
    t.addEvent(s, 'late')
    expect(s.events.length).toBe(1)
  })
})