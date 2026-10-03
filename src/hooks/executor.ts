/**
 * Hook executor — turn a single HookEntry + payload into a HookResult.
 *
 * - `executeBashHook`: spawn the command via LightSandbox. Payload is
 *   serialized to stdin (as JSON). `exit 0` + stdout containing a
 *   JSON line `{"decision":"approve"}` → `approve` outcome; `exit 0`
 *   otherwise → `allow`; non-zero / timeout / spawn failure → `deny`.
 * - `executeHttpHook`: POST payload as JSON to the URL. `2xx` → `allow`;
 *   body containing `{"decision":"approve"}` → `approve`; `4xx`/`5xx` /
 *   timeout / network error → `deny`.
 *
 * Both runners fail-closed: any thrown exception becomes `deny`.
 */
import { runLightSandbox } from './light-sandbox.js'
import type {
  BashHookEntry,
  HttpHookEntry,
  HookEvent,
  HookPayload,
  HookResult,
} from './types.js'

const DEFAULT_HOOK_TIMEOUT = 60_000
const REASON_CAP = 500

export interface ExecutorDeps {
  sessionId: string
  cwd: string
  hardSignal: AbortSignal
  /** Monotonic-ish counter for hookId generation. */
  counter: { next: () => number }
}

/**
 * Build the env passed to the bash child. Includes YUAN_* payload vars as
 * documented in `templates/hooks.example.yaml`. Payload is also sent on
 * stdin as a JSON document (preferred; env vars truncate at OS limits).
 */
function bashEnv(payload: HookPayload): Record<string, string> {
  const env: Record<string, string> = {
    YUAN_SESSION_ID: payload.sessionId,
    YUAN_HOOK_EVENT: payload.event,
    YUAN_TIMESTAMP: String(payload.timestamp),
    YUAN_PAYLOAD_JSON: JSON.stringify(payload),
  }
  // Event-specific convenience vars.
  if ('toolName' in payload) {
    env.YUAN_TOOL_NAME = (payload as { toolName: string }).toolName
    env.YUAN_TOOL_INPUT_JSON = JSON.stringify((payload as { toolInput: unknown }).toolInput)
  }
  return env
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return `${s.slice(0, n)}\n... [truncated]`
}

function detectApprove(text: string): boolean {
  // Look for a JSON line containing `"decision":"approve"`. Tolerant of
  // surrounding noise on stdout.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as { decision?: unknown }
      if (parsed && parsed.decision === 'approve') return true
    } catch {
      // not JSON, keep scanning
    }
  }
  return false
}

export async function executeBashHook(
  entry: BashHookEntry,
  payload: HookPayload,
  deps: ExecutorDeps,
  index: number,
): Promise<HookResult> {
  const hookId = `bash-${deps.counter.next()}-${payload.event}-${index}`
  const start = Date.now()
  try {
    const r = await runLightSandbox({
      command: entry.command,
      cwd: deps.cwd,
      env: bashEnv(payload),
      input: JSON.stringify(payload),
      timeoutMs: entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT,
      signal: deps.hardSignal,
    })

    if (r.timedOut) {
      return {
        hookId,
        event: payload.event,
        type: 'bash',
        matcher: entry.matcher ?? null,
        outcome: 'deny',
        reason: `timed out after ${entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT}ms`,
        durationMs: Date.now() - start,
      }
    }
    if (r.aborted) {
      return {
        hookId,
        event: payload.event,
        type: 'bash',
        matcher: entry.matcher ?? null,
        outcome: 'deny',
        reason: 'aborted',
        durationMs: Date.now() - start,
      }
    }

    if (r.exitCode === 0) {
      return {
        hookId,
        event: payload.event,
        type: 'bash',
        matcher: entry.matcher ?? null,
        outcome: detectApprove(r.stdout) ? 'approve' : 'allow',
        durationMs: Date.now() - start,
      }
    }

    return {
      hookId,
      event: payload.event,
      type: 'bash',
      matcher: entry.matcher ?? null,
      outcome: 'deny',
      reason: truncate(r.stderr.trim() || `exit code ${r.exitCode}`, REASON_CAP),
      durationMs: Date.now() - start,
    }
  } catch (e) {
    return {
      hookId,
      event: payload.event,
      type: 'bash',
      matcher: entry.matcher ?? null,
      outcome: 'deny',
      reason: truncate((e as Error).message ?? 'spawn failed', REASON_CAP),
      durationMs: Date.now() - start,
    }
  }
}

export async function executeHttpHook(
  entry: HttpHookEntry,
  payload: HookPayload,
  deps: ExecutorDeps,
  index: number,
): Promise<HookResult> {
  const hookId = `http-${deps.counter.next()}-${payload.event}-${index}`
  const start = Date.now()
  const timeoutMs = entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort('timeout'), timeoutMs)
    const onHard = (): void => ctrl.abort('hard-abort')
    deps.hardSignal.addEventListener('abort', onHard, { once: true })

    let resp: Response
    try {
      resp = await fetch(entry.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
      deps.hardSignal.removeEventListener('abort', onHard)
    }

    const text = await resp.text().catch(() => '')
    if (resp.status >= 200 && resp.status < 300) {
      return {
        hookId,
        event: payload.event,
        type: 'http',
        matcher: entry.matcher ?? null,
        outcome: detectApprove(text) ? 'approve' : 'allow',
        durationMs: Date.now() - start,
      }
    }

    return {
      hookId,
      event: payload.event,
      type: 'http',
      matcher: entry.matcher ?? null,
      outcome: 'deny',
      reason: truncate(`HTTP ${resp.status}: ${text || resp.statusText}`, REASON_CAP),
      durationMs: Date.now() - start,
    }
  } catch (e) {
    return {
      hookId,
      event: payload.event,
      type: 'http',
      matcher: entry.matcher ?? null,
      outcome: 'deny',
      reason: truncate((e as Error).message ?? 'network error', REASON_CAP),
      durationMs: Date.now() - start,
    }
  }
}
