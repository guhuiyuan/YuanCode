#!/usr/bin/env node
/**
 * M5 smoke demo — exercise TaskManager + BackgroundTaskPool + Subagent
 * end-to-end without an LLM.
 *
 * Verifies:
 *   1. TaskManager.create / update / nextUnblocked / persistence / cycle rejection
 *   2. BackgroundTaskPool.start / drainNotifications / cancelAll on hard-abort
 *   3. Subagent fresh-context run via a scripted provider (no real LLM)
 *
 * Run with:  node scripts/m5-smoke.mjs
 */
import { mkdtempSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

// Hand-rolled ANSI helpers (no chalk dep needed for a smoke).
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

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'yuancode-m5-'))
  info(`scratch dir: ${dir}`)

  // --------------------------------------------------------------
  // 1. TaskManager: build a 3-node DAG, run nextUnblocked, persist
  // --------------------------------------------------------------
  header('TaskManager: 3-node DAG (a → b → c)')

  const { TaskManager } = await import('../dist/core/task-manager.js')
  const sessionId = 'smoke'
  const tm = await TaskManager.load({ projectRoot: dir, sessionId })

  const a = await tm.create({ title: 'set up project', description: 'create folder' })
  const b = await tm.create({ title: 'add tests', deps: [a.id] })
  const c = await tm.create({ title: 'run CI', deps: [b.id] })
  ok(`created ${[a, b, c].map((t) => t.id.slice(0, 8)).join(' → ')}`)

  // nextUnblocked: only `a` is pending and has no deps
  let ready = await tm.nextUnblocked()
  if (ready.length !== 1 || ready[0].id !== a.id) {
    fail(`nextUnblocked expected [a], got ${ready.map((t) => t.id.slice(0, 8))}`)
  } else {
    ok('nextUnblocked correctly returns only `a`')
  }

  // Cycle rejection: try to make `a` depend on `c`
  try {
    await tm.update(a.id, { deps: [c.id] })
    fail('cycle was not rejected!')
  } catch (e) {
    if (e.code === 'cycle') {
      ok('cycle detection rejected update() that would create a loop')
    } else {
      fail(`expected cycle error, got ${e.code ?? e.message}`)
    }
  }

  // Persist + reload
  await tm.update(a.id, { status: 'in_progress' })
  await tm.update(a.id, { status: 'completed', result: 'project created' })
  const tm2 = await TaskManager.load({ projectRoot: dir, sessionId })
  const reloaded = await tm2.get(a.id)
  if (reloaded?.status !== 'completed') fail(`reload lost status, got ${reloaded?.status}`)
  else ok('task state persisted + reloaded from disk')

  ready = await tm2.nextUnblocked()
  if (ready.length !== 1 || ready[0].id !== b.id) {
    fail(`after completing a, nextUnblocked expected [b], got ${ready.map((t) => t.id.slice(0, 8))}`)
  } else {
    ok('after completing a, nextUnblocked returns `b`')
  }

  // --------------------------------------------------------------
  // 2. BackgroundTaskPool: start, drain, hard-abort cancelAll
  // --------------------------------------------------------------
  header('BackgroundTaskPool: start, drain, hard-abort')

  const { BackgroundTaskPool } = await import('../dist/core/background-tasks.js')
  const { TwoLevelAbort } = await import('../dist/core/abort.js')
  const { ToolRegistry } = await import('../dist/core/tool-registry.js')
  const { z } = await import('zod')
  const { LocalSandbox } = await import('../dist/core/sandbox/local.js')

  const abort = new TwoLevelAbort()
  const pool = new BackgroundTaskPool({ abort, maxConcurrent: 2 })
  const registry = new ToolRegistry()

  // Register a fake "echo" + a slow handler that respects the abort signal.
  registry.register({
    name: 'echo',
    description: 'echo',
    schema: z.object({ value: z.string() }),
    handler: async (input) => ({ content: `echo:${input.value}` }),
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 5_000,
    category: 'knowledge',
  })
  registry.register({
    name: 'slow',
    description: 'sleeps',
    schema: z.object({ ms: z.number() }),
    handler: async ({ ms }, ctx) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, ms)
        ctx.abort.hardSignal.addEventListener('abort', () => {
          clearTimeout(t)
          reject(new Error('Aborted'))
        }, { once: true })
      })
      return { content: 'slept' }
    },
    risk: 'low',
    parallelSafe: true,
    timeoutMs: 60_000,
    category: 'knowledge',
  })

  const ctx = {
    cwd: dir,
    sandbox: new LocalSandbox({ cwd: dir }),
    abort,
    sessionId,
    permissionMode: 'manual',
    logger: {
      info() {}, warn() {}, error() {}, debug() {}, trace() {},
      fatal() {}, silent() {}, child() { return this },
    },
  }

  // Two fast tasks that complete normally
  const id1 = await pool.start({ tool: 'echo', args: { value: 'first' }, ctx }, registry)
  const id2 = await pool.start({ tool: 'echo', args: { value: 'second' }, ctx }, registry)
  ok(`started 2 echo tasks: ${id1.slice(0, 8)}, ${id2.slice(0, 8)}`)

  // Wait for completion
  for (let i = 0; i < 50; i++) {
    if (pool.check(id1)?.status === 'done' && pool.check(id2)?.status === 'done') break
    await new Promise((r) => setTimeout(r, 10))
  }
  const drained = pool.drainNotifications()
  if (drained.length === 2 && drained.every((t) => t.status === 'done')) {
    ok(`drainNotifications returned 2 completed tasks (done × 2)`)
  } else {
    fail(`drainNotifications expected 2 done, got ${drained.map((t) => `${t.id.slice(0, 8)}=${t.status}`).join(', ')}`)
  }
  if (pool.drainNotifications().length === 0) ok('second drain returns empty (queue cleared)')
  else fail('queue was not cleared after first drain')

  // Now test hard-abort: start 2 slow tasks, cancel via parent abort.
  const id3 = await pool.start({ tool: 'slow', args: { ms: 5_000 }, ctx }, registry)
  const id4 = await pool.start({ tool: 'slow', args: { ms: 5_000 }, ctx }, registry)
  info(`started 2 slow tasks: ${id3.slice(0, 8)}, ${id4.slice(0, 8)}`)
  if (pool.running !== 2) fail(`expected 2 running, got ${pool.running}`)
  else ok('both slow tasks are running')

  const t0 = performance.now()
  abort.trigger('hard')
  for (let i = 0; i < 100; i++) {
    if (pool.running === 0) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const elapsed = performance.now() - t0
  if (pool.running === 0) ok(`hard-abort cancelled both tasks in ${elapsed.toFixed(0)}ms`)
  else fail(`expected 0 running after hard-abort, got ${pool.running}`)

  const cancelled = pool.drainNotifications()
  if (cancelled.length === 2 && cancelled.every((t) => t.status === 'cancelled')) {
    ok('drainNotifications returns both tasks as cancelled')
  } else {
    fail(`expected 2 cancelled, got ${cancelled.map((t) => `${t.id.slice(0, 8)}=${t.status}`).join(', ')}`)
  }

  // --------------------------------------------------------------
  // 3. Subagent: fresh-context run via scripted provider
  // --------------------------------------------------------------
  header('Subagent: fresh-context child loop')

  const { runSubagent } = await import('../dist/core/subagent.js')
  const { StateMachine } = await import('../dist/core/state-machine.js')

  // A scripted provider that returns a fixed end_turn response.
  let receivedMessages = []
  const scriptedProvider = {
    name: 'scripted',
    async chat(req) {
      // Snapshot messages at call time.
      receivedMessages = req.messages.slice()
      return {
        message: { role: 'assistant', content: 'child summary: did the task' },
        stopReason: 'end_turn',
        usage: { inputTokens: 5, outputTokens: 3 },
      }
    },
  }

  const parentDeps = {
    provider: scriptedProvider,
    registry,
    abort: new TwoLevelAbort(),
    state: new StateMachine(),
    limits: {
      maxSteps: 50,
      perStepTimeoutMs: 60_000,
      totalTimeoutMs: 30 * 60_000,
      maxCostUsd: 5,
      parallelTools: 8,
    },
    cwd: dir,
    sessionId: 'parent',
    permissionMode: 'manual',
    logger: {
      info() {}, warn() {}, error() {}, debug() {}, trace() {},
      fatal() {}, silent() {}, child() { return this },
    },
    sandbox: new LocalSandbox({ cwd: dir }),
    subagentDepth: 0,
  }

  const result = await runSubagent(parentDeps, { type: 'explore', prompt: 'map the repo' })

  if (result.summary !== 'child summary: did the task') {
    fail(`expected child summary, got: ${result.summary}`)
  } else {
    ok('subagent returned summary: "child summary: did the task"')
  }
  if (result.type !== 'explore') fail(`expected type=explore, got ${result.type}`)
  else ok(`subagent type preserved: ${result.type}`)
  if (result.depth !== 0) fail(`expected depth=0, got ${result.depth}`)
  else ok(`subagent depth: ${result.depth}`)

  // Verify history was empty: only 1 message (the prompt)
  if (receivedMessages.length !== 1) {
    fail(`expected 1 message in child chat, got ${receivedMessages.length}`)
  } else if (receivedMessages[0].role !== 'user' || receivedMessages[0].content !== 'map the repo') {
    fail(`child got wrong message: ${JSON.stringify(receivedMessages[0])}`)
  } else {
    ok('child provider received only the user prompt (fresh context confirmed)')
  }

  // Verify system prompt includes "exploration agent" flavor
  // (we can't easily reach the system prompt from here, but the type round-trips)
  ok(`subagent lifecycle: ${result.steps} steps, stopReason=${result.stopReason}`)

  // Recursion refusal: depth > 3 returns without spawning
  const refused = await runSubagent(parentDeps, { type: 'general', prompt: 'x', depth: 5 })
  if (refused.summary.match(/recursion depth 5 exceeds maximum/i)) {
    ok('subagent at depth 5 refuses to spawn (recursion cap enforced)')
  } else {
    fail(`expected recursion refusal, got: ${refused.summary}`)
  }

  // --------------------------------------------------------------
  // Wrap-up
  // --------------------------------------------------------------
  header('Cleanup')
  if (process.exitCode === 1) {
    fail('one or more checks failed')
  } else {
    ok('all M5 smoke checks passed')
  }

  // Show on-disk persistence artifacts
  const tasksDir = join(dir, '.yuancode', 'sessions', sessionId, 'tasks')
  if (existsSync(tasksDir)) {
    info(`tasks on disk: ${readdirSync(tasksDir).map((f) => f.slice(0, 8)).join(', ')}`)
    const sample = JSON.parse(readFileSync(join(tasksDir, `${a.id}.json`), 'utf8'))
    info(`sample task: title="${sample.title}" status=${sample.status} result="${sample.result ?? ''}"`)
  }

  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
