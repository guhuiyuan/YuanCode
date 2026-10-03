/**
 * Slash commands — pure handlers invoked by the TUI prompt.
 *
 * Each handler returns a `SlashResult` describing what to display and (when
 * relevant) what side-effects the caller should perform. Side-effects are
 * reported as data, not executed here, so the handlers stay trivially
 * testable.
 *
 * Conventions:
 *   /exit            request a graceful exit
 *   /help            print the command list
 *   /compact         trigger manual context compaction
 *   /rewind          open the checkpoint menu (TUI)
 *   /clear           drop the in-memory message history (disk events remain)
 *   /session         print session id + token usage
 *
 * Unknown commands produce an `error` tone result so the TUI can show the
 * failure inline.
 */
import type { CheckpointSnapshot } from '../core/checkpoint-manager.js'

export type SlashResult =
  | { kind: 'exit' }
  | { kind: 'show'; tone: 'info' | 'warn' | 'error'; text: string; multiline?: boolean }
  | { kind: 'compact'; trigger: 'manual' }
  | { kind: 'rewind'; snapshots: CheckpointSnapshot[]; sessionId: string }
  | { kind: 'clear-history' }

export interface SlashContext {
  sessionId: string
  /** Optional — when present, /rewind uses this list. */
  listCheckpoints?: () => CheckpointSnapshot[]
  /** Current token usage for /session. */
  usage?: { input: number; output: number }
  /** Step count for /session. */
  steps?: number
  /** Current messages in flight — used by /clear to compute size. */
  messageCount?: number
}

export function handleSlash(input: string, ctx: SlashContext): SlashResult {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) {
    return { kind: 'show', tone: 'error', text: `not a slash command: ${trimmed}` }
  }
  const [nameRaw, ...rest] = trimmed.slice(1).split(/\s+/)
  const name = (nameRaw ?? '').toLowerCase()
  const args = rest.join(' ').trim()

  switch (name) {
    case 'exit':
    case 'quit':
    case 'q':
      return { kind: 'exit' }

    case 'help':
      return {
        kind: 'show',
        tone: 'info',
        multiline: true,
        text: HELP_TEXT,
      }

    case 'compact':
      return { kind: 'compact', trigger: 'manual' }

    case 'rewind':
      return rewindResult(ctx, args)

    case 'clear':
      return { kind: 'clear-history' }

    case 'session':
      return sessionResult(ctx)

    default:
      return {
        kind: 'show',
        tone: 'error',
        text: `Unknown command: /${name}. Type /help for the list.`,
      }
  }
}

// --------------------------------------------------------------------------
// /rewind
// --------------------------------------------------------------------------

function rewindResult(ctx: SlashContext, args: string): SlashResult {
  const list = ctx.listCheckpoints?.() ?? []
  if (list.length === 0) {
    return {
      kind: 'show',
      tone: 'info',
      text: 'No checkpoints available. Edit/Write/Bash operations will create them automatically.',
    }
  }
  const sub = args.toLowerCase()
  if (sub === 'list' || sub === '') {
    return {
      kind: 'rewind',
      snapshots: list,
      sessionId: ctx.sessionId,
    }
  }
  return {
    kind: 'show',
    tone: 'error',
    text: `Unknown /rewind subcommand: ${args}. Try /rewind (open menu) or /rewind list.`,
  }
}

// --------------------------------------------------------------------------
// /session
// --------------------------------------------------------------------------

function sessionResult(ctx: SlashContext): SlashResult {
  const u = ctx.usage ?? { input: 0, output: 0 }
  const steps = ctx.steps ?? 0
  const msg = ctx.messageCount ?? 0
  const lines = [
    `session: ${ctx.sessionId}`,
    `messages in flight: ${msg}`,
    `steps this turn: ${steps}`,
    `tokens (input/output): ${u.input} / ${u.output}`,
  ]
  return { kind: 'show', tone: 'info', multiline: true, text: lines.join('\n') }
}

// --------------------------------------------------------------------------
// Help text
// --------------------------------------------------------------------------

const HELP_TEXT = `Commands:
  /exit, /quit, /q   exit the session
  /help              show this message
  /compact           force context compaction now
  /rewind            open the checkpoint restore menu
  /rewind list       list available checkpoints
  /clear             drop the in-memory message history
  /session           show session id + token usage`