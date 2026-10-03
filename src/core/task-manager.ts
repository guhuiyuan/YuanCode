/**
 * TaskManager — in-memory DAG of tasks with on-disk persistence.
 *
 * Storage: `<project>/.yuancode/sessions/<sid>/tasks/<id>.json` — one file
 * per task. `load()` reads every file on startup; mutations go through the
 * in-memory map and atomic-write to disk.
 *
 * Status transitions enforced by the manager (not by callers):
 *
 *   pending → in_progress → completed → deleted
 *   pending → deleted
 *   in_progress → pending (release / un-stick)
 *
 * Anything else (e.g. completed → in_progress) is rejected with a domain
 * error. This keeps the DAG monotone forward from the user's perspective.
 *
 * DAG cycle detection: `create()` runs a DFS over the proposed deps + their
 * transitive closure. A cycle is rejected before any disk write.
 *
 * Dependencies that don't yet exist (forward references) are allowed — the
 * user can describe the whole plan up front, then create leaf tasks, then
 * internal tasks.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
  renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted'

export interface Task {
  id: string
  title: string
  description?: string
  status: TaskStatus
  deps: string[]
  /** 'main' or a subagent id; informational. */
  owner?: string
  /** Free-form result text set when status='completed'. */
  result?: string
  createdAt: number
  updatedAt: number
}

export interface TaskManagerOptions {
  projectRoot: string
  sessionId: string
}

export interface CreateTaskInput {
  title: string
  description?: string
  deps?: string[]
}

export interface UpdateTaskInput {
  status?: TaskStatus
  title?: string
  description?: string
  owner?: string
  result?: string
  /** Patch the dependency list — triggers cycle re-check. */
  deps?: string[]
}

/**
 * Domain errors. The manager throws these so the tool layer can catch and
 * surface them as `ToolResult { isError: true }`. Callers can also
 * instanceof-check to differentiate.
 */
export class TaskError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'not_found'
      | 'cycle'
      | 'unknown_dep'
      | 'invalid_status'
      | 'duplicate',
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

// --------------------------------------------------------------------------

export class TaskManager {
  private readonly tasksDir: string
  private readonly tasks = new Map<string, Task>()
  private readonly listeners = new Set<() => void>()

  constructor(opts: TaskManagerOptions) {
    this.tasksDir = join(
      opts.projectRoot,
      '.yuancode',
      'sessions',
      opts.sessionId,
      'tasks',
    )
  }

  /** Scan the tasks directory and load every persisted task into memory. */
  static async load(opts: TaskManagerOptions): Promise<TaskManager> {
    const m = new TaskManager(opts)
    if (existsSync(m.tasksDir)) {
      let entries: string[]
      try {
        entries = readdirSync(m.tasksDir)
      } catch {
        entries = []
      }
      for (const name of entries) {
        if (!name.endsWith('.json')) continue
        const full = join(m.tasksDir, name)
        try {
          const parsed = JSON.parse(readFileSync(full, 'utf8')) as Task
          m.tasks.set(parsed.id, parsed)
        } catch {
          // Skip corrupt files; the user can recreate them.
        }
      }
    }
    return m
  }

  // ------------------------------------------------------------------ CRUD

  /** Create a new task. Returns the persisted record (with id assigned). */
  async create(input: CreateTaskInput): Promise<Task> {
    const id = randomUUID()
    const now = Date.now()

    // Forward references allowed — but every dep id must exist *before*
    // this task becomes reachable. We accept ids that are not yet in the
    // map; they must be created before any `nextUnblocked` call returns
    // this task. (No-op for forward refs; real check happens during
    // list / nextUnblocked.)
    //
    // Cycle detection: if all of `deps` are in `this.tasks`, run a DFS to
    // confirm adding (id, deps) doesn't form a cycle. Forward refs are
    // skipped — they cannot participate in a cycle by definition (they
    // would have to be created *after* us).

    const deps = (input.deps ?? []).slice()
    if (this.tasks.size > 0) {
      const knownDeps = deps.filter((d) => this.tasks.has(d))
      if (knownDeps.length > 0) {
        const proposed = new Map(this.tasks)
        const newTask: Task = {
          id,
          title: input.title,
          description: input.description,
          status: 'pending',
          deps: knownDeps,
          createdAt: now,
          updatedAt: now,
        }
        proposed.set(id, newTask)
        if (createsCycle(proposed, id)) {
          throw new TaskError(
            `Creating task "${input.title}" would form a cycle in the DAG.`,
            'cycle',
          )
        }
      }
    }

    const task: Task = {
      id,
      title: input.title,
      description: input.description,
      status: 'pending',
      deps,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(id, task)
    await this.persist(task)
    this.fire()
    return task
  }

  /** Patch an existing task. Validates status transitions and re-runs cycle check on deps changes. */
  async update(id: string, patch: UpdateTaskInput): Promise<Task> {
    const cur = this.tasks.get(id)
    if (!cur) throw new TaskError(`Task ${id} not found.`, 'not_found')
    if (patch.status && patch.status !== cur.status) {
      validateStatusTransition(cur.status, patch.status)
    }
    const nextDeps = patch.deps !== undefined ? patch.deps : cur.deps

    // If deps are changing, run cycle detection. The new deps form a cycle
    // iff any transitively-reachable node points back at `id` (including a
    // direct self-loop). Same DFS as create(), applied to the proposed graph.
    if (patch.deps !== undefined) {
      const knownDeps = nextDeps.filter((d) => this.tasks.has(d))
      const proposed = new Map(this.tasks)
      proposed.set(id, { ...cur, deps: knownDeps })
      if (createsCycle(proposed, id)) {
        throw new TaskError(
          `Updating task "${cur.title}" would form a cycle in the DAG.`,
          'cycle',
        )
      }
    }

    const next: Task = {
      ...cur,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.deps !== undefined ? { deps: nextDeps } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      updatedAt: Date.now(),
    }
    this.tasks.set(id, next)
    await this.persist(next)
    this.fire()
    return next
  }

  /** Fetch a task by id (null if missing or deleted). */
  async get(id: string): Promise<Task | null> {
    const t = this.tasks.get(id)
    return t && t.status !== 'deleted' ? t : null
  }

  /** List all non-deleted tasks, optionally filtered by status. */
  async list(filter?: { status?: TaskStatus }): Promise<Task[]> {
    const out: Task[] = []
    for (const t of this.tasks.values()) {
      if (t.status === 'deleted') continue
      if (filter?.status && t.status !== filter.status) continue
      out.push(t)
    }
    out.sort((a, b) => a.createdAt - b.createdAt)
    return out
  }

  /** Soft-delete: marks as deleted, removes from disk. */
  async delete(id: string): Promise<boolean> {
    const cur = this.tasks.get(id)
    if (!cur) return false
    // Drop the disk file; keep the in-memory entry out of `list()` by
    // flipping status to 'deleted'. We keep the in-memory record so
    // a future `create` with the same dep id doesn't accidentally
    // re-attach to a tombstone.
    this.tasks.set(id, { ...cur, status: 'deleted', updatedAt: Date.now() })
    const path = join(this.tasksDir, `${id}.json`)
    if (existsSync(path)) {
      try {
        rmSync(path, { force: true })
      } catch {
        // best effort
      }
    }
    this.fire()
    return true
  }

  // -------------------------------------------------------------- DAG views

  /**
   * Tasks that are pending AND whose deps are all completed (or whose deps
   * were deleted — we don't block progress on a cancelled task).
   */
  async nextUnblocked(): Promise<Task[]> {
    const all = await this.list()
    const statusById = new Map(all.map((t) => [t.id, t.status]))
    const out: Task[] = []
    for (const t of all) {
      if (t.status !== 'pending') continue
      let unblocked = true
      for (const dep of t.deps) {
        const s = statusById.get(dep)
        // Missing or deleted deps are treated as resolved (otherwise a
        // single typo blocks the entire plan).
        if (s !== undefined && s !== 'completed' && s !== 'deleted') {
          unblocked = false
          break
        }
      }
      if (unblocked) out.push(t)
    }
    return out
  }

  // ---------------------------------------------------------------- pub/sub

  /** Subscribe to mutations. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private fire(): void {
    for (const fn of this.listeners) fn()
  }

  // ----------------------------------------------------------- persistence

  private async persist(t: Task): Promise<void> {
    mkdirSync(this.tasksDir, { recursive: true })
    const path = join(this.tasksDir, `${t.id}.json`)
    writeAtomic(path, JSON.stringify(t, null, 2))
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/**
 * Atomic write — temp-file + rename. This is what `SessionStore` does; we
 * duplicate the pattern here because `TaskManager` doesn't import the
 * session store (to avoid a coupling).
 */
function writeAtomic(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, data)
  // renameSync is atomic on POSIX; on Windows it overwrites, which is
  // good enough for our use (no concurrent readers in this session).
  renameSync(tmp, path)
}

function validateStatusTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    pending: ['in_progress', 'deleted'],
    in_progress: ['pending', 'completed', 'deleted'],
    completed: ['deleted'],
    deleted: [],
  }
  if (!allowed[from].includes(to)) {
    throw new TaskError(
      `Illegal status transition: ${from} → ${to}. Allowed from ${from}: ${allowed[from].join(', ') || '(none)'}.`,
      'invalid_status',
    )
  }
}

/**
 * DFS cycle check: starting at `rootId`, can we reach `rootId` again by
 * following `deps`? If yes, adding this node would form a cycle.
 */
function createsCycle(graph: Map<string, Task>, rootId: string): boolean {
  const visited = new Set<string>()
  const stack: string[] = [rootId]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (visited.has(cur)) continue
    visited.add(cur)
    const node = graph.get(cur)
    if (!node) continue
    for (const dep of node.deps) {
      if (dep === rootId) return true
      if (!visited.has(dep)) stack.push(dep)
    }
  }
  return false
}