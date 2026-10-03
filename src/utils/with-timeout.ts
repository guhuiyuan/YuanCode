/**
 * Timeout helper — race a promise against both a wall-clock timer and an
 * external AbortSignal. Used by:
 *   - ToolRegistry.execute (per-tool timeout)
 *   - sandbox runners (kill child on timeout)
 *   - loop (real per-step wall-clock timer — M7)
 *
 * Extracted from src/core/tool-registry.ts so any consumer can reuse the
 * same semantics. Both timeout and abort produce Error subclasses:
 *   - TimeoutError → wall-clock timeout
 *   - AbortError   → external signal aborted
 *
 * The external signal is consulted eagerly: if it has already fired when
 * `withTimeout` is called, the returned promise rejects synchronously.
 */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`)
    this.name = 'TimeoutError'
  }
}

export class AbortError extends Error {
  constructor() {
    super('Aborted')
    this.name = 'AbortError'
  }
}

/**
 * Race `promise` against `ms` and `externalSignal`. Whichever rejects first
 * wins; the loser is left dangling (the timer is cleared, the abort listener
 * is removed). Aborts do not cancel `promise` itself — callers are responsible
 * for wiring `externalSignal` into whatever they handed us.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(ms)), ms)
  })
  let abortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    if (externalSignal?.aborted) {
      reject(new AbortError())
      return
    }
    if (externalSignal) {
      abortListener = () => reject(new AbortError())
      externalSignal.addEventListener('abort', abortListener, { once: true })
    }
  })
  try {
    return await Promise.race([promise, timeoutPromise, abortPromise])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener && externalSignal) {
      externalSignal.removeEventListener('abort', abortListener)
    }
  }
}