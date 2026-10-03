/**
 * UUID v7 (time-ordered) generator. Wraps the `uuid` package.
 *
 * UUID v7 is preferred over v4 for IDs that are written to append-only event
 * logs because sorting by ID gives chronological order, which dramatically
 * simplifies replay / fork / search.
 */
import { v7 as uuidv7, v4 as uuidv4 } from 'uuid'

export function newId(): string {
  return uuidv7()
}

export function randomId(): string {
  return uuidv4()
}

/** Short id (first 8 chars of v7). Useful for human-facing logs. */
export function shortId(): string {
  return uuidv7().slice(0, 8)
}
