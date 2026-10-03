/**
 * Hooks engine — public types.
 *
 * The hooks engine lets users install lifecycle callbacks (bash scripts or
 * HTTP webhooks) at well-defined points in the agent's run. Config lives in
 * `<project>/.yuancode/hooks.yaml` or `~/.yuancode/hooks.yaml`; see
 * `templates/hooks.example.yaml` for the canonical file format.
 *
 * Each hook entry supports a `matcher` that filters by tool name (used by
 * `PreToolUse` and `PostToolUse`); other events ignore matchers.
 *
 * `outcome` for a single hook firing is `'allow'` (default for exit 0 / 2xx)
 * or `'deny'` (non-zero exit / non-2xx status / error / timeout). For
 * `PreToolUse` an `'approve'` outcome is recognised when the hook emits
 * `{"decision":"approve"}` on stdout (bash) or in the HTTP body — this lets a
 * hook explicitly promote an `ask` decision to `allow`.
 */

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreCompact'
  | 'PostCompact'
  | 'SubagentStart'
  | 'SubagentEnd'
  | 'Notification'

/**
 * Events where a `deny` outcome actually gates the action.
 * Other events treat `deny` as informational (logged for diagnostics).
 */
export const GATING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'PreToolUse',
  'UserPromptSubmit',
  'PreCompact',
  'SubagentStart',
])

export type HookType = 'bash' | 'http'

export interface BashHookEntry {
  type: 'bash'
  /** Tool-name filter. Used by PreToolUse/PostToolUse; ignored by other events. */
  matcher?: string
  /** Shell command string. Spawned via `sh -c` / `cmd /c`. */
  command: string
  /** Per-run timeout. Default 60 000 ms. */
  timeoutMs?: number
}

export interface HttpHookEntry {
  type: 'http'
  matcher?: string
  /** Webhook URL. Receives the JSON payload via POST. */
  url: string
  /** Per-request timeout. Default 60 000 ms. */
  timeoutMs?: number
}

export type HookEntry = BashHookEntry | HttpHookEntry

export interface HooksConfig {
  hooks: Partial<Record<HookEvent, HookEntry[]>>
}

// ---------- payloads (per-event) ----------

interface HookPayloadBase {
  sessionId: string
  cwd: string
  event: HookEvent
  timestamp: number
}

export interface SessionStartPayload extends HookPayloadBase {
  model: string
  permissionMode: string
}

export interface SessionEndPayload extends HookPayloadBase {
  exitCode: number
  reason: 'complete' | 'abort' | 'error'
}

export interface UserPromptSubmitPayload extends HookPayloadBase {
  prompt: string
}

export interface PreToolUsePayload extends HookPayloadBase {
  toolName: string
  toolInput: unknown
}

export interface PostToolUsePayload extends HookPayloadBase {
  toolName: string
  toolInput: unknown
  toolOutput: unknown
  toolError?: string
  durationMs: number
}

export interface PreCompactPayload extends HookPayloadBase {
  tokenCountBefore: number
  trigger: 'manual' | 'auto'
}

export interface PostCompactPayload extends HookPayloadBase {
  tokenCountBefore: number
  tokenCountAfter: number
}

export interface SubagentStartPayload extends HookPayloadBase {
  subagentType: string
  subagentId: string
  task: string
}

export interface SubagentEndPayload extends HookPayloadBase {
  subagentType: string
  subagentId: string
  status: 'success' | 'error' | 'abort'
  result?: string
}

export interface NotificationPayload extends HookPayloadBase {
  channel: 'background-task'
  taskId: string
  taskStatus: 'completed' | 'failed' | 'timeout' | 'cancelled'
  message: string
}

export type HookPayload =
  | SessionStartPayload
  | SessionEndPayload
  | UserPromptSubmitPayload
  | PreToolUsePayload
  | PostToolUsePayload
  | PreCompactPayload
  | PostCompactPayload
  | SubagentStartPayload
  | SubagentEndPayload
  | NotificationPayload

// ---------- results ----------

export type HookOutcome = 'allow' | 'deny' | 'approve'

export interface HookResult {
  /** Stable identifier for tracing — `bash-<n>-<event>-<idx>` or `http-<n>-<event>-<idx>`. */
  hookId: string
  event: HookEvent
  type: HookType
  matcher: string | null
  outcome: HookOutcome
  reason?: string
  durationMs: number
}

export interface HookDecision {
  /** Whether the overall action is allowed to proceed. */
  allowed: boolean
  /** Combined deny reason (first hook that denied), if any. */
  reason?: string
  /** All hook results — for logging / diagnostics. */
  results: HookResult[]
}
