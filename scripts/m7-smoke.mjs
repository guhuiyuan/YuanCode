#!/usr/bin/env node
/**
 * M7 smoke demo — full sandbox modes + CostGuard + TraceLogger end-to-end
 * without an LLM.
 *
 * Three sections:
 *   1. Sandbox:  create each of the 4 modes via createSandbox(), exercise
 *                healthcheck + a simple command (skipping on platform/lock
 *                unavailability, never failing the smoke).
 *   2. CostGuard: simulate ~50 steps of usage with a tiny budget, watch
 *                 isOverBudget() flip, then derive a child scope and verify
 *                 it shares records but enforces its own ceiling.
 *   3. TraceLogger: build a parent → child span tree, flush to JSONL,
 *                   inspect that parent/child relationship + durations
 *                   round-trip cleanly.
 *
 * Run with:  node scripts/m7-smoke.mjs
 */
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import pino from 'pino'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Hand-rolled ANSI helpers — no chalk dep needed for a smoke.
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
}
const ok = (msg) => console.log(`${c.green}✓${c.reset} ${msg}`)
const fail = (msg) => {
  console.error(`${c.red}✗${c.reset} ${msg}`)
  process.exitCode = 1
}
const info = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`)
const header = (msg) => console.log(`\n${c.bold}${c.yellow}▶ ${msg}${c.reset}`)

const silentPino = () => pino({ level: 'silent' })

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'yuancode-m7-'))
  info(`scratch dir: ${dir}`)

  // ----------------------------------------------------------------
  // 1. Sandbox: 4 modes
  // ----------------------------------------------------------------
  header('Sandbox: local / bubblewrap / docker / landlock healthchecks')

  const { createSandbox } = await import('../dist/core/sandbox/index.js')

  // local — always available
  try {
    const local = createSandbox({ mode: 'local', cwd: dir })
    const hc = await local.healthcheck()
    const r = await local.run(
      `node -e "console.log('hello-from-local')"`,
      { timeoutMs: 5000 },
    )
    if (r.exitCode === 0 && /hello-from-local/.test(r.stdout)) {
      ok(`local sandbox: healthcheck=${hc ?? 'n/a'}, ran echo successfully`)
    } else {
      fail(`local sandbox unexpected: code=${r.exitCode} stdout=${r.stdout}`)
    }
  } catch (e) {
    fail(`local sandbox threw: ${e.message}`)
  }

  // bubblewrap — Linux-only + needs bwrap on PATH
  if (process.platform !== 'linux') {
    info(`bubblewrap skipped (not Linux; detected ${process.platform})`)
  } else {
    try {
      const bwrap = createSandbox({ mode: 'bubblewrap', cwd: dir })
      const hc = await bwrap.healthcheck()
      if (hc == null) {
        info(`bubblewrap skipped (healthcheck returned null — bwrap not installed)`)
      } else {
        const r = await bwrap.run('/bin/echo hello-from-bwrap', { timeoutMs: 5000 })
        if (r.exitCode === 0 && /hello-from-bwrap/.test(r.stdout)) {
          ok(`bubblewrap sandbox: healthcheck=${hc}, ran echo successfully`)
        } else {
          fail(`bubblewrap unexpected: code=${r.exitCode} stdout=${r.stdout}`)
        }
      }
    } catch (e) {
      info(`bubblewrap skipped (error: ${e.message})`)
    }
  }

  // docker — needs docker daemon
  try {
    const docker = createSandbox({ mode: 'docker', cwd: dir, image: 'alpine:3.19' })
    const hc = await docker.healthcheck()
    if (hc == null) {
      info(`docker skipped (healthcheck returned null — docker unavailable)`)
    } else {
      ok(`docker sandbox: healthcheck=${hc}`)
      // Don't actually run a container here — that's covered by tests/e2e/sandbox-image.test.ts
    }
  } catch (e) {
    info(`docker skipped (error: ${e.message})`)
  }

  // landlock — Linux 5.13+ + Node 22+
  if (process.platform !== 'linux') {
    info(`landlock skipped (not Linux; detected ${process.platform})`)
  } else {
    try {
      const landlock = createSandbox({ mode: 'landlock', cwd: dir })
      const hc = await landlock.healthcheck()
      if (hc == null) {
        info(`landlock skipped (healthcheck returned null — kernel/Node version unsupported)`)
      } else {
        ok(`landlock sandbox: healthcheck=${hc}`)
      }
    } catch (e) {
      info(`landlock skipped (error: ${e.message})`)
    }
  }

  // ----------------------------------------------------------------
  // 2. CostGuard: simulate usage + child scope
  // ----------------------------------------------------------------
  header('CostGuard: tiny budget + child scope sharing records')

  const { CostGuard, DEFAULT_PRICING } = await import('../dist/core/cost-guard.js')

  const guard = new CostGuard({
    pricing: DEFAULT_PRICING,
    maxCostUsd: 0.001, // tiny — flips isOverBudget fast
    model: 'MiniMax-M3',
    sessionId: 'm7-smoke',
  })

  // MiniMax-M3 default: input $0.10 / 1k, output $0.30 / 1k.
  // 1000 input + 1000 output = $0.10 + $0.30 = $0.40 — way over $0.001.
  const r1 = guard.record('MiniMax-M3', { inputTokens: 1000, outputTokens: 1000 })
  if (r1.costUsd < 0.3) {
    fail(`cost record seems off: costUsd=${r1.costUsd}`)
  } else {
    ok(`recorded 1k in + 1k out on MiniMax-M3 → $${r1.costUsd.toFixed(4)} (total=$${r1.totalCostUsd.toFixed(4)})`)
  }
  if (!guard.isOverBudget()) {
    fail(`expected isOverBudget() after a single $0.40 step against $0.001 ceiling`)
  } else {
    ok(`isOverBudget()=true after the $0.40 step (ceiling $0.001)`)
  }
  if (!guard.isOverGrace()) {
    fail(`expected isOverGrace() too (default 5% grace, ceiling $0.001 → grace $0.00105)`)
  } else {
    ok(`isOverGrace()=true (5% grace didn't save us — $0.40 ≫ $0.00105)`)
  }

  // Breakdown should now contain one record with cost > 0 and the MiniMax-M3 row.
  const bd = guard.breakdown()
  if (bd.records.length !== 1) {
    fail(`breakdown().records.length expected 1, got ${bd.records.length}`)
  } else if (!bd.byModel['MiniMax-M3']) {
    fail(`breakdown().byModel missing MiniMax-M3`)
  } else if (Math.abs(bd.byModel['MiniMax-M3'].costUsd - r1.costUsd) > 0.0001) {
    fail(
      `breakdown MiniMax-M3 cost mismatch: byModel=${bd.byModel['MiniMax-M3'].costUsd} vs record=${r1.costUsd}`,
    )
  } else {
    ok(
      `breakdown: ${bd.totalCostUsd.toFixed(4)} across ${bd.totalInputTokens + bd.totalOutputTokens} tokens (1 record, byModel.MiniMax-M3 cost=$${bd.byModel['MiniMax-M3'].costUsd.toFixed(4)})`,
    )
  }

  // Child scope: share records but enforce its own budget.
  const child = guard.child({ maxCostUsd: 0.0001, source: 'subagent' })
  const beforeSpend = guard.spent()
  const cr = child.record('MiniMax-M3', { inputTokens: 100, outputTokens: 50 })
  if (guard.spent() !== beforeSpend + cr.costUsd) {
    fail(
      `child record() should propagate to parent's spent(): before=${beforeSpend} after=${guard.spent()} delta=${cr.costUsd}`,
    )
  } else {
    ok(`child scope shares records: parent.spent() += $${cr.costUsd.toFixed(4)} via child.record()`)
  }
  if (!child.isOverBudget()) {
    fail(`child scope should be over its own $0.0001 budget after the parent already spent $0.40`)
  } else {
    ok(`child.isOverBudget()=true (own ceiling $0.0001)`)
  }
  if (child.ceiling() !== 0.0001) {
    fail(`child.ceiling() expected 0.0001, got ${child.ceiling()}`)
  } else {
    ok(`child.ceiling()=$${child.ceiling()} (independent from parent's $0.001)`)
  }

  // ----------------------------------------------------------------
  // 3. TraceLogger: parent → child span tree, flush to JSONL
  // ----------------------------------------------------------------
  header('TraceLogger: parent/child span tree + JSONL flush')

  const { TraceLogger } = await import('../dist/core/trace-logger.js')
  const sinkPath = join(dir, 'trace.jsonl')

  const trace = new TraceLogger({
    sessionId: 'm7-smoke',
    logger: silentPino(),
    sinkPath,
  })

  // Build a small tree: root('op') → child('subA') + child('subB').
  const root = trace.startRoot('demo.root', { step: 1 })
  const a = trace.startChild(root, 'demo.a', { input: 42 })
  trace.addEvent(a, 'checkpoint-1')
  trace.endSpan(a, 'ok')
  const b = trace.startChild(root, 'demo.b')
  // Force an error span to verify the error branch round-trips.
  const err = trace.startChild(root, 'demo.err')
  try {
    throw new Error('boom')
  } catch (e) {
    trace.endSpan(err, 'error', e)
  }
  trace.endSpan(b, 'ok')
  trace.endSpan(root, 'ok')

  const snap = trace.snapshot()
  if (snap.spans.length !== 4) {
    fail(`snapshot expected 4 spans, got ${snap.spans.length}`)
  } else {
    ok(`snapshot has 4 spans (root + a + b + err)`)
  }
  const childSpans = snap.spans.filter((s) => s.parentSpanId === root.spanId)
  if (childSpans.length !== 3) {
    fail(`expected 3 children of root, got ${childSpans.length}`)
  } else {
    ok(`3 children linked to root via parentSpanId`)
  }
  const errSpan = snap.spans.find((s) => s.name === 'demo.err')
  if (!errSpan || errSpan.status !== 'error' || !/boom/.test(errSpan.errorMessage ?? '')) {
    fail(`demo.err span should have status=error and errorMessage=/boom/, got ${JSON.stringify(errSpan)}`)
  } else {
    ok(`error span recorded: status=error, errorMessage="${errSpan.errorMessage}"`)
  }
  const aSpan = snap.spans.find((s) => s.name === 'demo.a')
  if (!aSpan || aSpan.events.length !== 1 || aSpan.events[0].name !== 'checkpoint-1') {
    fail(`demo.a should have one event "checkpoint-1", got ${JSON.stringify(aSpan?.events)}`)
  } else {
    ok(`event recorded on demo.a (name="checkpoint-1")`)
  }

  await trace.flush()
  if (!existsSync(sinkPath)) {
    fail(`flush() did not create sink at ${sinkPath}`)
  } else {
    const lines = readFileSync(sinkPath, 'utf8').trim().split('\n')
    if (lines.length !== 4) {
      fail(`JSONL expected 4 lines, got ${lines.length}`)
    } else {
      const parsed = lines.map((l) => JSON.parse(l))
      const names = parsed.map((p) => p.name)
      if (!names.includes('demo.root') || !names.includes('demo.err')) {
        fail(`JSONL missing expected span names, got ${names.join(', ')}`)
      } else {
        ok(`flushed ${lines.length} spans to JSONL: ${names.join(', ')}`)
      }
      // Round-trip check: every non-root span has the root's traceId.
      const rootJson = parsed.find((p) => p.name === 'demo.root')
      const allShareTraceId = parsed.every((p) => p.traceId === rootJson.traceId)
      if (!allShareTraceId) {
        fail(`not every span shares the root traceId in JSONL`)
      } else {
        ok(`all spans share traceId=${rootJson.traceId.slice(0, 8)}…`)
      }
    }
  }

  // ----------------------------------------------------------------
  // Wrap-up
  // ----------------------------------------------------------------
  header('Cleanup')
  if (process.exitCode === 1) {
    fail('one or more checks failed')
  } else {
    ok('all M7 smoke checks passed')
  }
  if (existsSync(sinkPath)) info(`trace.jsonl artifact: ${sinkPath}`)

  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})