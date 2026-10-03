/**
 * CheckpointManager — snapshot files before `edit`/`write` so the user can
 * rewind with /rewind later.
 *
 * M4 update: storage is now pluggable via the `CheckpointStorage` interface.
 * Two backends are bundled:
 *
 *   - `MemoryCheckpointStorage`  — fast in-memory buffer (default for tests
 *                                  and short sessions). Lost on process exit.
 *   - `DiskCheckpointStorage`    — persists via `SessionStore`, so the
 *                                  checkpoint survives process restarts and
 *                                  powers /rewind across `--resume`.
 *
 * The two backends expose identical behavior. The manager itself is now a
 * thin façade — it owns the per-session index (a fast-path map for
 * `restoreLatest(path)`) and delegates byte-level storage to the backend.
 *
 * Restore semantics are unchanged: walking the stack in reverse and writing
 * the original bytes back. Files that did not exist before are deleted on
 * restore.
 */
import { readFile, writeFile, mkdir, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SessionStore, CheckpointDisk } from './session-store.js'

export interface CheckpointSnapshot {
  /** Stable id (UUID v4). */
  id: string
  /** Absolute path of the file that was snapshotted. */
  path: string
  /** File mode in octal (e.g. 0o644). Captured at snapshot time. */
  mode: number
  /** Original file contents as Buffer. */
  content: Buffer
  /** Wall-clock timestamp (ms since epoch). */
  createdAt: number
  /** Free-form label — typically the tool name that triggered it. */
  label: string
  /** Set when the original file did not exist (so restore = delete). */
  sentinelCreated?: boolean
}

/** Pluggable storage interface. Two implementations: memory and disk. */
export interface CheckpointStorage {
  /** Persist a snapshot. Returns the manifest with the assigned id. */
  write(snap: CheckpointSnapshot): Promise<void>
  /** Read a snapshot by id; null if missing. */
  read(id: string): Promise<CheckpointSnapshot | null>
  /** List all snapshots (manifests) newest-first. */
  list(): Promise<CheckpointSnapshot[]>
  /** Remove a snapshot. */
  remove(id: string): Promise<boolean>
}

// --------------------------------------------------------------------------
// Memory backend — default for tests and ephemeral sessions.
// --------------------------------------------------------------------------

export class MemoryCheckpointStorage implements CheckpointStorage {
  private readonly byId = new Map<string, CheckpointSnapshot>()

  async write(snap: CheckpointSnapshot): Promise<void> {
    this.byId.set(snap.id, snap)
  }

  async read(id: string): Promise<CheckpointSnapshot | null> {
    return this.byId.get(id) ?? null
  }

  async list(): Promise<CheckpointSnapshot[]> {
    return [...this.byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  async remove(id: string): Promise<boolean> {
    return this.byId.delete(id)
  }

  /** Test helper. */
  clear(): void {
    this.byId.clear()
  }
}

// --------------------------------------------------------------------------
// Disk backend — uses SessionStore. Survives restarts.
// --------------------------------------------------------------------------

export class DiskCheckpointStorage implements CheckpointStorage {
  constructor(private readonly store: SessionStore) {}

  async write(snap: CheckpointSnapshot): Promise<void> {
    this.store.writeCheckpoint({
      id: snap.id,
      path: snap.path,
      content: snap.content,
      mode: snap.mode,
      label: snap.label,
      sentinelCreated: snap.sentinelCreated,
    })
  }

  async read(id: string): Promise<CheckpointSnapshot | null> {
    const cp = this.store.readCheckpoint(id)
    if (!cp) return null
    return toSnapshot(cp.manifest, cp.content)
  }

  async list(): Promise<CheckpointSnapshot[]> {
    return this.store.listCheckpoints().map((m) => toSnapshot(m, Buffer.alloc(0)))
  }

  async remove(id: string): Promise<boolean> {
    return this.store.deleteCheckpoint(id)
  }
}

function toSnapshot(m: CheckpointDisk, content: Buffer): CheckpointSnapshot {
  return {
    id: m.id,
    path: m.path,
    mode: m.mode,
    content,
    createdAt: m.createdAt,
    label: m.label,
    sentinelCreated: m.sentinelCreated,
  }
}

// --------------------------------------------------------------------------
// Manager
// --------------------------------------------------------------------------

export interface CheckpointManagerOptions {
  /** Hard cap on stored snapshots (LRU eviction). Default 100. */
  maxSnapshots?: number
  /** Pluggable storage backend. Default: in-memory. */
  storage?: CheckpointStorage
}

/**
 * The manager is a façade: it owns a per-path index for fast
 * `restoreLatest(path)` lookups and delegates byte storage to the backend.
 */
export class CheckpointManager {
  private readonly all: CheckpointSnapshot[] = []
  private readonly byId = new Map<string, CheckpointSnapshot>()
  private readonly byPath = new Map<string, CheckpointSnapshot[]>()
  private readonly maxSnapshots: number
  private readonly storage: CheckpointStorage

  constructor(opts: CheckpointManagerOptions = {}) {
    this.maxSnapshots = opts.maxSnapshots ?? 100
    this.storage = opts.storage ?? new MemoryCheckpointStorage()
  }

  /** Total snapshots currently retained. */
  size(): number {
    return this.all.length
  }

  /** Snapshot `path` before mutation. Returns the snapshot id.
   *
   *  - If the file does not exist (about-to-be-created), the snapshot is a
   *    marker that means "this path did not exist before".
   *  - If the file exists, its bytes are buffered.
   */
  async snapshot(path: string, label = 'mutation'): Promise<string> {
    let mode = 0o644
    let content: Buffer
    let sentinel = false
    try {
      const st = await stat(path)
      mode = st.mode
      content = await readFile(path)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        content = SENTINEL_CREATED
        mode = 0
        sentinel = true
      } else {
        throw e
      }
    }

    const snap: CheckpointSnapshot = {
      id: randomUUID(),
      path,
      mode,
      content,
      createdAt: Date.now(),
      label,
      sentinelCreated: sentinel,
    }
    this.all.push(snap)
    this.byId.set(snap.id, snap)
    const arr = this.byPath.get(path) ?? []
    arr.push(snap)
    this.byPath.set(path, arr)

    await this.storage.write(snap)
    this.evictIfNeeded()
    return snap.id
  }

  /** Restore the most recent snapshot for `path`. Returns the snapshot id
   *  that was restored, or null if nothing to restore. */
  async restoreLatest(path: string): Promise<string | null> {
    const arr = this.byPath.get(path)
    if (!arr || arr.length === 0) return null
    const snap = arr[arr.length - 1]!
    // Read content from storage (memory has it; disk may have written it out).
    const stored = await this.storage.read(snap.id)
    const contentSnap = stored ?? snap
    await this.applySnapshot(contentSnap)
    // pop from per-path stack and main index
    arr.pop()
    if (arr.length === 0) this.byPath.delete(path)
    const idx = this.all.lastIndexOf(snap)
    if (idx >= 0) this.all.splice(idx, 1)
    this.byId.delete(snap.id)
    await this.storage.remove(snap.id)
    return snap.id
  }

  /** List snapshots newest-first, optionally filtered to `path`. */
  list(path?: string): CheckpointSnapshot[] {
    if (path) {
      return [...(this.byPath.get(path) ?? [])].reverse()
    }
    return [...this.all].reverse()
  }

  /** Pop and return the most recent snapshot without applying it. */
  pop(): CheckpointSnapshot | undefined {
    const snap = this.all.pop()
    if (snap) {
      this.byId.delete(snap.id)
      const arr = this.byPath.get(snap.path)
      if (arr) {
        const i = arr.indexOf(snap)
        if (i >= 0) arr.splice(i, 1)
        if (arr.length === 0) this.byPath.delete(snap.path)
      }
      // fire-and-forget — best effort
      void this.storage.remove(snap.id)
    }
    return snap
  }

  /** Hydrate the in-memory index from the storage backend (used at session start). */
  async hydrate(): Promise<void> {
    const stored = await this.storage.list()
    for (const snap of stored) {
      this.all.push(snap)
      this.byId.set(snap.id, snap)
      const arr = this.byPath.get(snap.path) ?? []
      arr.push(snap)
      this.byPath.set(snap.path, arr)
    }
  }

  // ------------------------------------------------------------------------

  private async applySnapshot(snap: CheckpointSnapshot): Promise<void> {
    if (snap.sentinelCreated || snap.content.equals(SENTINEL_CREATED)) {
      try {
        await stat(snap.path)
        await unlink(snap.path)
      } catch {
        // already gone — nothing to do
      }
      return
    }
    await mkdir(dirname(snap.path), { recursive: true })
    await writeFile(snap.path, snap.content, { mode: snap.mode })
  }

  private evictIfNeeded(): void {
    while (this.all.length > this.maxSnapshots) {
      const dropped = this.all.shift()
      if (!dropped) break
      this.byId.delete(dropped.id)
      const arr = this.byPath.get(dropped.path)
      if (arr) {
        const i = arr.indexOf(dropped)
        if (i >= 0) arr.splice(i, 1)
        if (arr.length === 0) this.byPath.delete(dropped.path)
      }
      void this.storage.remove(dropped.id)
    }
  }
}

/** Sentinel marker for "file did not exist before this checkpoint". */
export const SENTINEL_CREATED = Buffer.from('__YUANCODE_CHECKPOINT_SENTINEL_CREATED__')