/**
 * SessionStore — on-disk persistence for a single session.
 *
 * Layout (under `<project>/.yuancode/sessions/<sid>/`):
 *
 *   events.jsonl                    append-only event log
 *   state.json                      current TodoManager snapshot + meta
 *   checkpoints/<uuid>/manifest.json { id, path, mode, createdAt, label }
 *   checkpoints/<uuid>/<basename>   original file bytes (or SENTINEL_CREATED)
 *
 * The store is intentionally SQLite-free: JSONL + JSON for the M4 milestone.
 * If we later need atomic cross-session queries we can swap in SQLite without
 * touching call sites — this class implements the same `appendEvent` /
 * `loadEvents` / `readCheckpoint` / `writeCheckpoint` surface.
 *
 * Concurrency: writes are atomic via temp-file + rename. Reads are optimistic.
 * The in-memory CheckpointManager keeps a parallel fast-path index; the disk
 * store is the source of truth for /rewind and for session resume (M5).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  unlinkSync,
  statSync,
  appendFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

// --------------------------------------------------------------------------
// Event types (the append-only log)
// --------------------------------------------------------------------------

export type SessionEvent =
  | { ts: number; kind: 'session_start'; sessionId: string; cwd: string; model: string }
  | { ts: number; kind: 'session_end'; sessionId: string; stopReason: string; steps: number }
  | { ts: number; kind: 'user_prompt'; sessionId: string; text: string }
  | { ts: number; kind: 'assistant_message'; sessionId: string; preview: string }
  | { ts: number; kind: 'tool_use'; sessionId: string; tool: string; inputPreview: string }
  | { ts: number; kind: 'tool_result'; sessionId: string; tool: string; bytes: number; isError: boolean }
  | { ts: number; kind: 'checkpoint'; sessionId: string; id: string; path: string; label: string }
  | { ts: number; kind: 'rewind'; sessionId: string; checkpointId: string; scope: 'code' | 'conv' | 'both' }
  | { ts: number; kind: 'compact'; sessionId: string; trigger: 'auto' | 'manual'; tokensBefore: number; tokensAfter: number }
  // M5 — Subagent / TaskManager / BackgroundTaskPool lifecycle.
  | { ts: number; kind: 'subagent_start'; sessionId: string; subagentId: string; type: string; depth: number }
  | { ts: number; kind: 'subagent_end'; sessionId: string; subagentId: string; steps: number; stopReason: string }
  | { ts: number; kind: 'task_created'; sessionId: string; id: string; title: string }
  | { ts: number; kind: 'task_updated'; sessionId: string; id: string; status: string }
  | { ts: number; kind: 'task_deleted'; sessionId: string; id: string }
  | { ts: number; kind: 'background_started'; sessionId: string; id: string; tool: string }
  | { ts: number; kind: 'background_completed'; sessionId: string; id: string; status: 'done' | 'error' | 'cancelled' }

export type SessionEventKind = SessionEvent['kind']

// --------------------------------------------------------------------------
// Checkpoint on-disk shape
// --------------------------------------------------------------------------

export interface CheckpointDisk {
  /** Same id as the in-memory CheckpointSnapshot. */
  id: string
  /** Absolute path of the snapshotted file. */
  path: string
  /** Original file mode (octal). 0 when the file did not exist. */
  mode: number
  /** When the snapshot was taken. */
  createdAt: number
  /** Label (usually the tool name). */
  label: string
  /** Set when the original file did not exist; restore means "delete the file". */
  sentinelCreated?: true
}

const SENTINEL_CREATED_MARKER = '__YUANCODE_CHECKPOINT_SENTINEL_CREATED__'

// --------------------------------------------------------------------------
// Session state JSON
// --------------------------------------------------------------------------

export interface SessionState {
  sessionId: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  /** Free-form key/value bag — currently unused but reserved for resume metadata. */
  meta: Record<string, unknown>
}

const DEFAULT_STATE = (sid: string, cwd: string, model: string): SessionState => ({
  sessionId: sid,
  cwd,
  model,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  meta: {},
})

// --------------------------------------------------------------------------
// SessionStore
// --------------------------------------------------------------------------

export interface SessionStoreOptions {
  /** Project root — the store lives at `<root>/.yuancode/sessions/<sid>/`. */
  projectRoot: string
  sessionId: string
}

export class SessionStore {
  readonly rootDir: string
  private readonly eventsPath: string
  private readonly statePath: string
  private readonly checkpointsDir: string
  private state: SessionState | null = null

  constructor(opts: SessionStoreOptions) {
    this.rootDir = join(opts.projectRoot, '.yuancode', 'sessions', opts.sessionId)
    this.eventsPath = join(this.rootDir, 'events.jsonl')
    this.statePath = join(this.rootDir, 'state.json')
    this.checkpointsDir = join(this.rootDir, 'checkpoints')
  }

  /** Ensure the directory tree exists. Idempotent. */
  ensure(): void {
    mkdirSync(this.rootDir, { recursive: true })
    mkdirSync(this.checkpointsDir, { recursive: true })
  }

  // ------------------------------------------------------------------ events

  /**
   * Append an event to the JSONL log. Each call writes one line, flushed to
   * disk via fsync-ish atomic rename. Safe to call concurrently from one
   * process — Node's single-threaded event loop guarantees ordering.
   */
  appendEvent(ev: SessionEvent): void {
    this.ensure()
    const line = JSON.stringify(ev) + '\n'
    appendToFile(this.eventsPath, line)
  }

  /** Read the full event log, oldest first. */
  readEvents(): SessionEvent[] {
    if (!existsSync(this.eventsPath)) return []
    const text = readFileSync(this.eventsPath, 'utf8')
    const out: SessionEvent[] = []
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed) as SessionEvent)
      } catch {
        // skip malformed line — never crash the harness over a corrupt log
      }
    }
    return out
  }

  // ------------------------------------------------------------------- state

  /** Get the current state, loading from disk on first access. */
  getState(): SessionState {
    if (this.state) return this.state
    if (existsSync(this.statePath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as SessionState
        this.state = parsed
        return parsed
      } catch {
        // fall through to recreate
      }
    }
    this.state = DEFAULT_STATE('', '', '')
    return this.state
  }

  /** Persist the current state. */
  saveState(next: Partial<SessionState>): SessionState {
    const cur = this.getState()
    const merged: SessionState = { ...cur, ...next, updatedAt: Date.now() }
    this.ensure()
    writeAtomic(this.statePath, JSON.stringify(merged, null, 2))
    this.state = merged
    return merged
  }

  // ------------------------------------------------------------ checkpoints

  /** Persist a checkpoint (file snapshot) to disk. Returns the manifest. */
  writeCheckpoint(input: {
    id?: string
    path: string
    content: Buffer
    mode: number
    label: string
    sentinelCreated?: boolean
  }): CheckpointDisk {
    this.ensure()
    const id = input.id ?? randomUUID()
    const dir = join(this.checkpointsDir, id)
    mkdirSync(dir, { recursive: true })

    const manifest: CheckpointDisk = {
      id,
      path: input.path,
      mode: input.mode,
      createdAt: Date.now(),
      label: input.label,
      sentinelCreated: input.sentinelCreated ? true : undefined,
    }
    writeAtomic(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    // Filename inside the dir: use the basename of the snapshotted path,
    // prefix with 'sentinel-' when the file didn't exist (so restore knows
    // to delete rather than write).
    const base = basenameSafe(input.path)
    const filename = input.sentinelCreated ? `sentinel-${base}` : base
    writeAtomic(join(dir, filename), input.content)

    return manifest
  }

  /** Read a checkpoint manifest + its file bytes from disk. */
  readCheckpoint(id: string): { manifest: CheckpointDisk; content: Buffer } | null {
    const dir = join(this.checkpointsDir, id)
    const manifestPath = join(dir, 'manifest.json')
    if (!existsSync(manifestPath)) return null
    let manifest: CheckpointDisk
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CheckpointDisk
    } catch {
      return null
    }
    const filename = manifest.sentinelCreated
      ? `sentinel-${basenameSafe(manifest.path)}`
      : basenameSafe(manifest.path)
    const contentPath = join(dir, filename)
    if (!existsSync(contentPath)) return null
    return { manifest, content: readFileSync(contentPath) }
  }

  /** List all checkpoints (manifests) newest-first. */
  listCheckpoints(): CheckpointDisk[] {
    if (!existsSync(this.checkpointsDir)) return []
    let ids: string[]
    try {
      ids = readdirSync(this.checkpointsDir).filter((name) => {
        const full = join(this.checkpointsDir, name)
        try {
          return statSync(full).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      return []
    }
    const out: CheckpointDisk[] = []
    for (const id of ids) {
      const cp = this.readCheckpoint(id)
      if (cp) out.push(cp.manifest)
    }
    out.sort((a, b) => b.createdAt - a.createdAt)
    return out
  }

  /** Remove a checkpoint from disk. Returns true if anything was deleted. */
  deleteCheckpoint(id: string): boolean {
    const dir = join(this.checkpointsDir, id)
    if (!existsSync(dir)) return false
    rmRecursive(dir)
    return true
  }

  /** GC: keep the newest `keep` checkpoints per session, delete older ones. */
  gcCheckpoints(keep: number): number {
    const all = this.listCheckpoints()
    if (all.length <= keep) return 0
    const toDelete = all.slice(keep)
    let n = 0
    for (const cp of toDelete) {
      if (this.deleteCheckpoint(cp.id)) n++
    }
    return n
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function appendToFile(path: string, line: string): void {
  // We open with 'a' (append, create if missing). Node's fs.appendFileSync
  // is atomic enough for our purposes — single-threaded writer.
  appendFileSync(path, line, 'utf8')
}

function writeAtomic(path: string, data: string | Buffer): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = `${path}.tmp-${randomUUID()}`
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

function rmRecursive(p: string): void {
  rmSync(p, { recursive: true, force: true })
}

function basenameSafe(p: string): string {
  const b = resolve(p).split(/[\\/]/).pop() ?? 'file'
  // Avoid empty / dotfile-only names that could surprise `rm -rf` style ops.
  return b.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file'
}
