/**
 * TraceLogger — light-weight span/trace layer for observability.
 *
 * Inspired by OpenTelemetry but deliberately minimal — no SDK, no exporter
 * protocol, no dependencies beyond pino (which we already use).
 *
 * Two output channels:
 *   1. Live log: every `endSpan()` writes a single pino `info` line with
 *      `{ traceId, spanId, name, durMs, status, ...attrs }`. Correlate with
 *      normal logs by `traceId`.
 *   2. JSONL sink: optional file path; `flush()` appends all recorded spans
 *      as one JSON object per line (newline-delimited). Useful for offline
 *      analysis or piping into a tracing backend later.
 *
 * Sampling and memory bounds:
 *   - `sampleRate` (0..1) — drop `startRoot`/`startChild` calls randomly.
 *     Sampled-out spans don't even allocate.
 *   - `maxSpans` — when exceeded, oldest spans are dropped (FIFO). Spans
 *     are still logged live; only the in-memory history is bounded.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Logger as PinoLogger } from 'pino'
import { randomUUID } from 'node:crypto'

export type SpanStatus = 'running' | 'ok' | 'error'

export interface SpanEvent {
  name: string
  time: number
  attributes?: Record<string, unknown>
}

export interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  startTime: number
  endTime?: number
  status: SpanStatus
  errorMessage?: string
  attributes: Record<string, unknown>
  events: SpanEvent[]
}

export interface TraceRecord {
  spans: Span[]
}

export interface TraceLoggerOptions {
  sessionId: string
  logger: PinoLogger
  /** Optional JSONL sink path. Created if missing. */
  sinkPath?: string
  /** 0..1, default 1 (record every span). */
  sampleRate?: number
  /** Default 1000. Older spans dropped from snapshot on overflow. */
  maxSpans?: number
}

interface RootInfo {
  traceId: string
  /** True if any span in this trace was sampled-in. */
  sampled: boolean
}

export class TraceLogger {
  private readonly sessionId: string
  private readonly logger: PinoLogger
  private readonly sinkPath: string | undefined
  private readonly sampleRate: number
  private readonly maxSpans: number

  /** Spans retained for `snapshot()` / `flush()`. FIFO-dropped on overflow. */
  private readonly spans: Span[] = []
  /** Live spans keyed by spanId — so `addEvent` can find them by id. */
  private readonly live = new Map<string, Span>()
  /** Maps each spanId → its root's traceId (for endSpan log). */
  private readonly rootOf = new Map<string, RootInfo>()

  constructor(opts: TraceLoggerOptions) {
    this.sessionId = opts.sessionId
    this.logger = opts.logger
    this.sinkPath = opts.sinkPath
    this.sampleRate = Math.min(1, Math.max(0, opts.sampleRate ?? 1))
    this.maxSpans = opts.maxSpans ?? 1000
  }

  /** Start a root span — no parent. */
  startRoot(name: string, attributes: Record<string, unknown> = {}): Span {
    const traceId = randomUUID()
    const rootSampled = this.shouldSample()
    if (rootSampled) {
      this.rootOf.set(traceId, { traceId, sampled: true })
    }
    const span = this.allocateSpan({
      traceId,
      spanId: randomUUID(),
      name,
      startTime: Date.now(),
      status: 'running',
      attributes,
      events: [],
    }, rootSampled)
    return span
  }

  /** Start a child span under `parent`. Inherits parent's traceId. */
  startChild(parent: Span, name: string, attributes: Record<string, unknown> = {}): Span {
    const sampled = this.rootOf.get(parent.traceId)?.sampled ?? false
    const span = this.allocateSpan({
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      spanId: randomUUID(),
      name,
      startTime: Date.now(),
      status: 'running',
      attributes,
      events: [],
    }, sampled)
    return span
  }

  /** Record a named event on an open span. */
  addEvent(span: Span, name: string, attributes: Record<string, unknown> = {}): void {
    if (span.status !== 'running') return // closed spans are immutable
    span.events.push({ name, time: Date.now(), attributes })
  }

  /** End a span with status. Emits a single pino log line (if sampled). */
  endSpan(span: Span, status: 'ok' | 'error', error?: Error): void {
    span.endTime = Date.now()
    span.status = status
    if (status === 'error' && error) span.errorMessage = error.message
    const root = this.rootOf.get(span.traceId)
    const sampled = root?.sampled ?? false
    if (sampled) {
      const durMs = span.endTime - span.startTime
      this.logger.info(
        {
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          durMs,
          status,
          ...(span.errorMessage ? { error: span.errorMessage } : {}),
          ...span.attributes,
        },
        `span_end ${span.name}`,
      )
    }
    this.live.delete(span.spanId)
    // Spans are added in allocateSpan; if not sampled we never pushed.
    // EOF check happens on flush.
  }

  /**
   * Convenience: wrap an async function in a child span. Auto-ends with
   * 'ok' on resolve, 'error' on throw (the throw is re-thrown).
   */
  async run<T>(
    parent: Span | null,
    name: string,
    fn: (span: Span) => Promise<T>,
    attributes: Record<string, unknown> = {},
  ): Promise<T> {
    const span = parent ? this.startChild(parent, name, attributes) : this.startRoot(name, attributes)
    try {
      const out = await fn(span)
      this.endSpan(span, 'ok')
      return out
    } catch (err) {
      this.endSpan(span, 'error', err instanceof Error ? err : new Error(String(err)))
      throw err
    }
  }

  /** Snapshot of all retained spans (sampled-in only). */
  snapshot(): TraceRecord {
    return { spans: [...this.spans] }
  }

  /** Live span count (running). Useful for `/inspect` UI. */
  liveCount(): number {
    return this.live.size
  }

  /** Total spans in history. */
  totalSpans(): number {
    return this.spans.length
  }

  /**
   * Flush to JSONL sink (if configured). Creates parent dirs lazily.
   * No-op when `sinkPath` is undefined.
   *
   * Intentionally not called automatically — caller controls cadence
   * (typically at session-end via the CLI shutdown path).
   */
  async flush(): Promise<void> {
    if (!this.sinkPath) return
    if (this.spans.length === 0) return
    await mkdir(dirname(this.sinkPath), { recursive: true })
    const lines = this.spans.map((s) => JSON.stringify(serialize(s))).join('\n') + '\n'
    await appendFile(this.sinkPath, lines, 'utf8')
  }

  // ----- internals -----

  private shouldSample(): boolean {
    if (this.sampleRate >= 1) return true
    return Math.random() < this.sampleRate
  }

  private allocateSpan(span: Span, sampled: boolean): Span {
    if (sampled) {
      this.spans.push(span)
      // FIFO — drop oldest on overflow
      while (this.spans.length > this.maxSpans) this.spans.shift()
    }
    this.live.set(span.spanId, span)
    return span
  }
}

/**
 * Serialize a span for the JSONL sink. Keeps the shape flat so jq-friendly
 * consumers can pipe it without unwrapping nested objects.
 */
function serialize(s: Span): Record<string, unknown> {
  return {
    traceId: s.traceId,
    spanId: s.spanId,
    parentSpanId: s.parentSpanId ?? null,
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime ?? null,
    durationMs: s.endTime !== undefined ? s.endTime - s.startTime : null,
    status: s.status,
    error: s.errorMessage ?? null,
    attributes: s.attributes,
    events: s.events,
  }
}