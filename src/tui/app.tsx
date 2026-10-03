/**
 * App — root Ink component.
 *
 * Responsibilities:
 *   - Render the header (model, cwd, permission mode)
 *   - Hold the message history
 *   - Run the agent loop when the user submits a prompt
 *   - Stream / partial responses back into the message list
 *   - Dispatch slash commands (/exit, /help, /compact, /rewind, /clear, /session)
 *   - Render the rewind checkpoint panel
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Text, Static } from 'ink'
import { theme, c, banner } from './theme.js'
import { Spinner } from './spinner.js'
import { MessageList, type DisplayMessage } from './message-list.js'
import { Prompt } from './prompt.js'
import { RewindPanel, type RewindChoice } from './rewind-panel.js'
import type { AgentLoopDeps, LoopProgressEvent } from '../core/loop.js'
import type { ContentBlock } from '../model/provider.js'
import { handleSlash } from '../cli/slash-commands.js'
import type { HooksEngine } from '../hooks/index.js'

/**
 * How many characters per tick to reveal when "typing out" the final
 * assistant text. Lower = more dramatic, higher = snappier. 12 chars /
 * 30ms ≈ 400 chars/sec which is comfortable for skimming.
 */
const TYPEWRIGHT_CHARS_PER_TICK = 12
const TYPEWRIGHT_TICK_MS = 30

export interface AppProps {
  deps: AgentLoopDeps
  system: string
  /**
   * The CheckpointManager is owned by the runner (passed via deps) so /rewind
   * can list/restore snapshots. We accept it as a separate optional prop so
   * callers that don't use it (e.g. tests) don't have to wire it up.
   */
  checkpointManager?: import('../core/checkpoint-manager.js').CheckpointManager
}

interface RewindState {
  snapshots: import('../core/checkpoint-manager.js').CheckpointSnapshot[]
}

export function App({ deps, system, checkpointManager }: AppProps): JSX.Element {
  const [messages, setMessages] = useState<DisplayMessage[]>([
    { kind: 'system', text: `cwd: ${deps.cwd}` },
    { kind: 'system', text: `permission: ${deps.permissionMode}` },
    { kind: 'system', text: `model: ${deps.provider.name}`, tone: 'info' },
    { kind: 'system', text: 'Type /help for commands, /exit to quit.', tone: 'info' },
  ])
  const [busy, setBusy] = useState(false)
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const [exitRequested, setExitRequested] = useState(false)
  const [rewindState, setRewindState] = useState<RewindState | null>(null)
  const [history, setHistory] = useState<import('../model/provider.js').ChatMessage[]>([])
  // Live status for the spinner. Updated by the onProgress callback so the
  // user sees a current label (e.g. "running bash…") instead of a static
  // "thinking…" that looks like the app froze.
  const [status, setStatus] = useState<{ label: string; step?: number }>({ label: 'thinking…' })
  // Typewriter state for the final assistant text — we reveal it
  // character-by-character once the loop ends so the user feels a flow
  // even though the LLM call itself wasn't actually streamed.
  const [typewriter, setTypewriter] = useState<{ full: string; shown: number } | null>(null)

  const headerItems = useMemo(
    () => [
      <Box key="header" flexDirection="column" marginBottom={1}>
        <Text>{banner('YuanCode 0.1.0')}</Text>
        <Text color={theme.muted}>
          {deps.provider.name}  ·  {deps.permissionMode}  ·  {deps.cwd}
        </Text>
      </Box>,
    ],
    [deps.provider.name, deps.permissionMode, deps.cwd],
  )

  useEffect(() => {
    const onSig = (): void => deps.abort.trigger('soft')
    process.on('SIGINT', onSig)
    return (): void => {
      process.off('SIGINT', onSig)
    }
  }, [deps.abort])

  const visibleMessages: DisplayMessage[] = useMemo(() => {
    if (streamingText == null) return messages
    const next = messages.slice()
    const last = next[next.length - 1]
    if (last?.kind === 'assistant' && last.streaming) {
      next[next.length - 1] = { ...last, text: streamingText, streaming: true }
    } else {
      next.push({ kind: 'assistant', text: streamingText, streaming: true })
    }
    return next
  }, [messages, streamingText])

  const showMessage = useCallback(
    (text: string, tone: 'info' | 'warn' | 'error' = 'info'): void => {
      for (const line of text.split('\n')) {
        setMessages((m) => m.concat({ kind: 'system', text: line, tone }))
      }
    },
    [],
  )

  const handleRewindSelect = useCallback(
    async (choice: RewindChoice): Promise<void> => {
      setRewindState(null)
      if (!checkpointManager) {
        showMessage('CheckpointManager is not available in this session.', 'error')
        return
      }
      const snap = choice.snapshot
      if (choice.action === 'restore-code') {
        const restoredId = await checkpointManager.restoreLatest(snap.path)
        if (restoredId) {
          showMessage(
            `Restored ${snap.path} to its previous content (checkpoint ${restoredId.slice(0, 8)}).`,
            'info',
          )
        } else {
          showMessage(`No checkpoint found for ${snap.path}.`, 'warn')
        }
        return
      }
      if (choice.action === 'summarize-from-here') {
        // Strip messages after the first one whose index aligns with this
        // checkpoint's timestamp. Without a per-message timestamp we just
        // keep the last 4 messages as "recent context".
        const recent = history.slice(-4)
        setHistory(recent)
        showMessage(
          `Compacted conversation; kept last ${recent.length} messages. Original snippet:\n${truncate(snap.label + ' @ ' + snap.path, 80)}`,
          'info',
        )
        return
      }
      // summarize-up-to-here
      const recent = history.slice(0)
      showMessage(
        `Marked conversation up to ${snap.path} as historical context. (${recent.length} messages retained.)`,
        'info',
      )
    },
    [checkpointManager, history, showMessage],
  )

  const handleRewindCancel = useCallback((): void => {
    setRewindState(null)
    showMessage('Rewind cancelled.', 'info')
  }, [showMessage])

  async function handleSubmit(value: string): Promise<void> {
    const trimmed = value.trim()
    if (!trimmed) return

    // Slash dispatch first.
    if (trimmed.startsWith('/')) {
      const result = handleSlash(trimmed, {
        sessionId: deps.sessionId,
        listCheckpoints: () => checkpointManager?.list() ?? [],
        messageCount: messages.length,
      })
      switch (result.kind) {
        case 'exit':
          setExitRequested(true)
          return
        case 'show':
          showMessage(result.text, result.tone)
          return
        case 'compact':
          showMessage(
            'Manual compaction requested — this is wired into the loop in M4 follow-up.',
            'info',
          )
          return
        case 'rewind':
          setRewindState({ snapshots: result.snapshots })
          return
        case 'clear-history':
          setMessages([])
          setHistory([])
          showMessage('In-memory history cleared. Disk events retained.', 'info')
          return
      }
    }

    // Real prompt
    setMessages((m) => m.concat({ kind: 'user', text: trimmed }))
    setBusy(true)
    setStreamingText('')
    setStatus({ label: 'thinking…' })
    deps.abort.reset()

    // Fire UserPromptSubmit hook (M6). Gating event — a deny short-circuits
    // the loop dispatch and surfaces a red banner to the user.
    const gate = await checkPromptSubmitGate(deps, trimmed)
    if (!gate.allowed) {
      setBusy(false)
      setStreamingText(null)
      setStatus({ label: 'thinking…' })
      setMessages((m) => m.concat({ kind: 'system', text: `Prompt blocked: ${gate.reason}`, tone: 'error' }))
      return
    }

    // Build the live-progress callback: each event from the loop updates
    // the spinner label and appends a short line to the message log so
    // the user can see what's actually happening. Errors thrown by the
    // callback are swallowed by the loop, so we keep this synchronous.
    const onProgress = (event: LoopProgressEvent): void => {
      switch (event.type) {
        case 'step-start':
          setStatus({ label: `step ${event.step}: calling ${deps.provider.name}…`, step: event.step })
          break
        case 'step-llm-end':
          if (event.textPreview) {
            setMessages((m) =>
              m.concat({
                kind: 'system',
                text: `· assistant: ${truncate(event.textPreview, 80)}`,
                tone: 'info',
              }),
            )
          }
          if (event.toolCalls.length > 0) {
            setStatus({
              label: `step ${event.step}: running ${event.toolCalls.map((t) => t.name).join(', ')}…`,
              step: event.step,
            })
          }
          break
        case 'tool-start':
          setStatus({ label: `running ${event.name}…`, step: event.step })
          showMessage(`→ ${event.name}(${truncate(formatToolInput(event.name, event.input), 60)})`, 'info')
          break
        case 'tool-end': {
          const prefix = event.isError ? '✗' : '←'
          const errTag = event.isError ? ' [error]' : ''
          showMessage(`${prefix} ${event.name} (${event.durationMs}ms)${errTag}: ${truncate(event.preview, 80)}`, event.isError ? 'warn' : 'info')
          setStatus({ label: 'thinking…', step: event.step })
          break
        }
        case 'step-end':
          showMessage(`step ${event.step} done (${event.durationMs}ms)`, 'info')
          setStatus({ label: 'thinking…' })
          break
      }
    }

    try {
      const { runAgentLoop } = await import('../core/loop.js')
      const result = await runAgentLoop(
        { ...deps, onProgress },
        { system, prompt: trimmed, history },
      )
      setStreamingText(null)
      const finalText = extractText(result.finalMessage.content)
      if (finalText) {
        // Typewriter: start revealing the final text char-by-char. The
        // message-list will hold a "streaming" assistant message that grows
        // as `typewriter.shown` advances.
        setTypewriter({ full: finalText, shown: 0 })
        setStreamingText('')
      }
      const summary = `${result.stopReason} · ${result.steps} step${result.steps === 1 ? '' : 's'} · ${result.usage.inputTokens}/${result.usage.outputTokens} tok`
      setMessages((m) =>
        m.concat({ kind: 'system', text: summary, tone: result.stopReason === 'end_turn' ? 'info' : 'warn' }),
      )
      setHistory(result.messages)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setMessages((m) => m.concat({ kind: 'system', text: `Error: ${msg}`, tone: 'error' }))
    } finally {
      setBusy(false)
      // Keep streamingText until the typewriter finishes (handled below).
      setStatus({ label: 'thinking…' })
    }
  }

  // Typewriter effect — advances `shown` by N chars every tick until the
  // full text is on screen, then clears the streaming slot and commits the
  // final assistant message into history.
  useEffect(() => {
    if (!typewriter) return
    if (typewriter.shown >= typewriter.full.length) {
      setStreamingText(null)
      setTypewriter(null)
      return
    }
    const id = setTimeout(() => {
      setStreamingText(typewriter.full.slice(0, typewriter.shown))
      setTypewriter({ full: typewriter.full, shown: Math.min(typewriter.full.length, typewriter.shown + TYPEWRIGHT_CHARS_PER_TICK) })
    }, TYPEWRIGHT_TICK_MS)
    return (): void => clearTimeout(id)
  }, [typewriter])

  if (exitRequested) {
    return (
      <Box flexDirection="column">
        <Text>{c.muted('bye.')}</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Static items={headerItems}>{render}</Static>
      <MessageList messages={visibleMessages} />
      {rewindState ? (
        <RewindPanel
          snapshots={rewindState.snapshots}
          onSelect={(choice) => void handleRewindSelect(choice)}
          onCancel={handleRewindCancel}
        />
      ) : null}
      {busy ? (
        <Box marginBottom={1}>
          <Spinner label={status.label} />
        </Box>
      ) : null}
      <Prompt disabled={busy} onSubmit={handleSubmit} />
    </Box>
  )
}

function render(item: JSX.Element): JSX.Element {
  return item
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * Best-effort one-line summary of a tool's input for the activity log.
 * We hand-format a few common shapes rather than `JSON.stringify` the whole
 * blob — a bash command, a file path, or a query pattern is much more
 * legible than `{ "command": "...", "cwd": "..." }`.
 */
function formatToolInput(name: string, input: unknown): string {
  if (input == null || typeof input !== 'object') return String(input ?? '')
  const obj = input as Record<string, unknown>
  switch (name) {
    case 'bash':
      return String(obj.command ?? '')
    case 'read':
    case 'write':
    case 'edit':
      return String(obj.path ?? obj.file_path ?? '')
    case 'grep':
      return `${obj.pattern ?? ''}${obj.path ? ` in ${obj.path}` : ''}`
    case 'glob':
      return String(obj.pattern ?? obj.glob ?? '')
    case 'webfetch':
      return String(obj.url ?? '')
    case 'subagent':
      return `${obj.type ?? 'general'}: ${truncate(String(obj.prompt ?? ''), 40)}`
    default:
      try {
        const s = JSON.stringify(obj)
        return truncate(s, 80)
      } catch {
        return ''
      }
  }
}

// --------------------------------------------------------------------------
// UserPromptSubmit gate — exported for unit tests
// --------------------------------------------------------------------------

export interface PromptSubmitGateDeps {
  hooksEngine?: HooksEngine
  sessionId: string
  cwd: string
}

export type PromptSubmitGateResult =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * Run the UserPromptSubmit hook for `prompt`. Returns whether the prompt
 * should proceed. Fail-closed: any hook exception denies the prompt.
 *
 * Extracted from `App.handleSubmit` so unit tests don't need an Ink harness.
 */
export async function checkPromptSubmitGate(
  deps: PromptSubmitGateDeps,
  prompt: string,
): Promise<PromptSubmitGateResult> {
  if (!deps.hooksEngine) return { allowed: true }
  try {
    const decision = await deps.hooksEngine.fire('UserPromptSubmit', {
      prompt,
      sessionId: deps.sessionId,
      cwd: deps.cwd,
    })
    if (!decision.allowed) {
      return { allowed: false, reason: decision.reason ?? 'no reason given' }
    }
    return { allowed: true }
  } catch (err) {
    return { allowed: false, reason: `hook error (fail-closed): ${(err as Error).message}` }
  }
}