/**
 * BackgroundTaskPool — fire-and-forget tool execution with completion notifications.
 *
 * Many real-world tools are inherently long-running: `npm install`, `tsc --watch`,
 * `pytest`, `cargo build`. Forcing the agent loop to wait for them synchronously
 * wastes time and burns tokens. This pool lets the agent submit a tool call to
 * run "in the background" — the loop gets an id immediately and continues with
 * other work; the completion is surfaced via `drainNotifications()` during the
 * loop's MAINTENANCE phase.
 *
 * Concurrency: capped by `maxConcurrent`. Excess submissions queue in submission
 * order. Cancellation: best-effort — we forward the agent's hard-abort signal to
 * every running task's child process.
 *
 * Errors: handler errors are captured as `task.error` (string), never thrown.
 * This matches the "tools never throw" contract from `ToolRegistry.execute`.
 *
 * Notifications queue: tasks that complete (done/error/cancelled) between two
 * `drainNotifications()` calls are buffered. The first drain returns them and
 * empties the queue — preventing double-delivery to the model.
 */
import { randomUUID } from 'node:crypto'
import type { TwoLevelAbort } from './abort.js'
import type { ToolResult, ToolContext, ToolRegistry } from './tool-registry.js'
import type { HooksEngine } from '../hooks/index.js'

export type BackgroundStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface BackgroundTask {
  id: string
  /** Tool name — must be registered in the ToolRegistry. */
  tool: string
  /** Already-validated input for the tool. */
  args: unknown
  status: BackgroundStatus
  startedAt: number
  finishedAt?: number
  /** Captured ToolResult on success. */
  result?: ToolResult
  /** Error message on error / cancel. */
  error?: string
  /** When queued behind maxConcurrent, this records the wait. */
  queuedAt?: number
}

export interface BackgroundTaskPoolOptions {
  /** Maximum concurrent tasks. Default 4. */
  maxConcurrent?: number
  /** Pool-level abort — when this fires 'hard', all running tasks are cancelled. */
  abort: TwoLevelAbort
  /**
   * Optional hooks engine (M6). When set, the pool fires a `Notification`
   * hook on every background-task finalization (done/error/cancelled).
   * The hook payload carries the task id, status, tool name, and a short
   * preview of the result. Failure to fire the hook never blocks the pool.
   */
  hooksEngine?: HooksEngine
}

// --------------------------------------------------------------------------
// Pool
// --------------------------------------------------------------------------

export class BackgroundTaskPool {
  private readonly maxConcurrent: number
  private readonly abort: TwoLevelAbort
  private readonly hooksEngine?: HooksEngine
  private readonly tasks = new Map<string, BackgroundTask>()
  /** Tasks waiting for a slot, in submission order. */
  private readonly queue: string[] = []
  /** Tasks that completed since the last drain. */
  private readonly notifications: BackgroundTask[] = []
  private runningCount = 0
  private unsubscribeAbort: (() => void) | null = null
  /**
   * Cached session context for hook payloads. Captured from the first
   * `start()` call's `parentCtx`; the pool is per-agent-loop so this is
   * stable for the pool's lifetime.
   */
  private sessionId = ''
  private cwd = ''

  constructor(opts: BackgroundTaskPoolOptions) {
    this.maxConcurrent = opts.maxConcurrent ?? 4
    this.abort = opts.abort
    this.hooksEngine = opts.hooksEngine
    this.unsubscribeAbort = this.abort.onAbort((level) => {
      if (level === 'hard') {
        // Fire and forget — best-effort cancellation.
        void this.cancelAll()
      }
    })
  }

  /** Release the abort listener. Call when the session ends. */
  dispose(): void {
    this.unsubscribeAbort?.()
    this.unsubscribeAbort = null
  }

  // ------------------------------------------------------------ lifecycle

  /**
   * Submit a tool to run in the background. Returns the task id immediately.
   * The actual execution happens asynchronously; check `check(id)` or
   * `drainNotifications()` for completion.
   *
   * The pool needs the ToolRegistry to dispatch — pass it via opts or set it
   * on the pool instance. We accept it on `start` so the pool stays decoupled
   * from any specific registry instance (testability).
   */
  async start(
    opts: { tool: string; args: unknown; ctx: ToolContext },
    registry: ToolRegistry,
  ): Promise<string> {
    const id = randomUUID()
    const task: BackgroundTask = {
      id,
      tool: opts.tool,
      args: opts.args,
      status: 'running',
      startedAt: Date.now(),
      queuedAt: this.runningCount >= this.maxConcurrent ? Date.now() : undefined,
    }
    this.tasks.set(id, task)

    // Capture session context for hook payloads. First call wins; subsequent
    // calls with a different ctx are ignored to keep the pool coherent.
    if (!this.sessionId) this.sessionId = opts.ctx.sessionId
    if (!this.cwd) this.cwd = opts.ctx.cwd

    if (this.runningCount >= this.maxConcurrent) {
      this.queue.push(id)
    } else {
      this.spawn(task, registry, opts.ctx)
    }
    return id
  }

  /** Fetch the current state of a single task. */
  check(id: string): BackgroundTask | null {
    return this.tasks.get(id) ?? null
  }

  /** List all tasks (any status), newest first. */
  list(): BackgroundTask[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /**
   * Cancel a task by id. Running tasks get their ctx.abort triggered (best
   * effort — only works if the tool forwards the signal to its underlying
   * subprocess). Queued tasks are dropped.
   *
   * Returns true if the task existed.
   */
  async cancel(id: string): Promise<boolean> {
    const t = this.tasks.get(id)
    if (!t) return false
    if (t.status !== 'running') return true // idempotent

    // If it's still queued, drop from the queue.
    const qi = this.queue.indexOf(id)
    if (qi >= 0) {
      this.queue.splice(qi, 1)
      this.finalize(t, 'cancelled', 'Cancelled before execution')
      return true
    }

    // Otherwise, try to interrupt the in-flight ctx. The pool doesn't hold
    // the ctx directly — but the spawned wrapper has a per-task abort
    // controller which we forward.
    const ctl = this.runningAborts.get(id)
    ctl?.hardAbort?.()
    return true
  }

  /** Cancel every running task. */
  async cancelAll(): Promise<void> {
    const ids = [...this.tasks.values()]
      .filter((t) => t.status === 'running')
      .map((t) => t.id)
    for (const id of ids) {
      await this.cancel(id)
    }
  }

  /**
   * Return every task that completed (done/error/cancelled) since the last
   * drain, and empty the notification queue. The loop calls this during its
   * MAINTENANCE phase to surface completions to the model.
   */
  drainNotifications(): BackgroundTask[] {
    const out = this.notifications.splice(0)
    return out
  }

  /** Number of running tasks. Useful for tests + UI. */
  get running(): number {
    return this.runningCount
  }

  /** Number of queued tasks waiting for a slot. */
  get queued(): number {
    return this.queue.length
  }

  // ---------------------------------------------------------- internals

  /**
   * Per-task abort wrapper. Each task gets its own controller so we can
   * interrupt it independently of the pool-level abort.
   */
  private readonly runningAborts = new Map<
    string,
    { hardAbort?: () => void }
  >()

  private spawn(
    task: BackgroundTask,
    registry: ToolRegistry,
    parentCtx: ToolContext,
  ): void {
    this.runningCount++

    // Build a child ToolContext that routes aborts through our controller
    // AND inherits the parent's logger / sandbox / cwd. We do NOT share
    // parentCtx.abort directly because we want independent kill control.
    let hardAbort: (() => void) | undefined
    const hardSignal = new AbortController()
    // Initialize the closure immediately so `runningAborts.get(id)?.hardAbort`
    // is callable even when no one ever subscribes via onAbort().
    hardAbort = (): void => hardSignal.abort()
    const childAbort = {
      get hardSignal(): AbortSignal {
        return hardSignal.signal
      },
      get aborted(): boolean {
        return hardSignal.signal.aborted
      },
      trigger: (level: 'soft' | 'hard'): void => {
        if (level === 'hard') hardSignal.abort()
      },
      reset: (): void => {},
      onAbort: (fn: (l: 'soft' | 'hard' | 'reset') => void): (() => void) => {
        const handler = (): void => fn('hard')
        hardSignal.signal.addEventListener('abort', handler, { once: true })
        hardAbort = () => hardSignal.abort()
        return () => hardSignal.signal.removeEventListener('abort', handler)
      },
    }
    this.runningAborts.set(task.id, {
      get hardAbort(): (() => void) | undefined {
        return hardAbort
      },
    })

    const childCtx: ToolContext = {
      cwd: parentCtx.cwd,
      sandbox: parentCtx.sandbox,
      abort: childAbort as unknown as ToolContext['abort'],
      sessionId: parentCtx.sessionId,
      permissionMode: parentCtx.permissionMode,
      logger: parentCtx.logger,
    }

    void (async (): Promise<void> => {
      try {
        const r = await registry.execute(task.tool, task.args, childCtx)
        if (hardSignal.signal.aborted) {
          this.finalize(task, 'cancelled', 'Cancelled by abort')
        } else if (r.isError) {
          this.finalize(
            task,
            'error',
            r.content.slice(0, 2000),
            r,
          )
        } else {
          this.finalize(task, 'done', undefined, r)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        this.finalize(task, 'error', msg)
      } finally {
        this.runningCount--
        this.runningAborts.delete(task.id)
        this.drainQueue(registry, parentCtx)
      }
    })()
  }

  private drainQueue(registry: ToolRegistry, parentCtx: ToolContext): void {
    const next = this.queue.shift()
    if (!next) return
    const t = this.tasks.get(next)
    if (!t || t.status !== 'running') return
    this.spawn(t, registry, parentCtx)
  }

  private finalize(
    task: BackgroundTask,
    status: BackgroundStatus,
    error?: string,
    result?: ToolResult,
  ): void {
    task.status = status
    task.finishedAt = Date.now()
    if (error !== undefined) task.error = error
    if (result !== undefined) task.result = result
    this.notifications.push(task)
    this.fire()

    // Notification hook (M6, informational only). Fire-and-forget — a slow
    // or broken hook must never block the loop's MAINTENANCE drain.
    if (this.hooksEngine) {
      const hookStatus: 'completed' | 'failed' | 'timeout' | 'cancelled' =
        status === 'done'
          ? 'completed'
          : status === 'error'
            ? 'failed'
            : status === 'cancelled'
              ? 'cancelled'
              : 'completed'
      const message =
        error !== undefined
          ? error.slice(0, 500)
          : (result?.content ?? '').slice(0, 500)
      void this.hooksEngine
        .fire('Notification', {
          channel: 'background-task',
          taskId: task.id,
          taskStatus: hookStatus,
          message,
          sessionId: this.sessionId,
          cwd: this.cwd,
        })
        .catch(() => {
          // Swallow — diagnostics hooks must not surface as pool errors.
        })
    }
  }

  private readonly listeners = new Set<() => void>()

  /** Subscribe to state changes (used by TUI for live updates). */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private fire(): void {
    for (const fn of this.listeners) fn()
  }
}