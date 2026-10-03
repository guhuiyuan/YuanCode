/**
 * ContextCompactor — three-layer compression for the conversation history.
 *
 * Layers (from cheapest to most expensive):
 *
 *   1. SNIP         per-tool_result truncation
 *                   Any single tool_result with content > SNIP_BYTES is cut
 *                   down to SNIP_BYTES + a "... (N bytes truncated)" marker.
 *                   Always safe, always cheap, always idempotent.
 *
 *   2. MICROCOMPACT old-step coalescing
 *                   Every MICROCOMPACT_EVERY steps, walk back through the
 *                   message list and replace earlier tool_use/tool_result
 *                   pairs with `<previous tool call, result omitted>`
 *                   placeholders. Keeps the conversation shape intact
 *                   (role alternation preserved) so the model still sees a
 *                   well-formed history.
 *
 *   3. COLLAPSE     LLM summarization of the oldest ~half of messages
 *                   Fires when total tokens exceed `collapseThreshold` of
 *                   the model's context window. Calls the provider to
 *                   summarize the older messages into a single "Past
 *                   context:" block. Most expensive; bounded by the
 *                   `maxSummaries` knob (defaults to 1 summary per session
 *                   — we don't keep re-collapsing).
 *
 * The compactor is a pure function over a `ChatMessage[]`. The caller
 * strips the system prompt, compacts the messages, then prepends the system
 * prompt back. This keeps the compactor independent of the provider layer.
 *
 * The manual `/compact` slash command triggers a COLLAPSE explicitly.
 */
import type { ChatMessage, ContentBlock, Provider } from '../model/provider.js'
import { countMessageTokens, countTokens } from '../utils/token-counter.js'
import type { HooksEngine } from '../hooks/index.js'

// --------------------------------------------------------------------------
// Knobs
// --------------------------------------------------------------------------

export interface CompactorOptions {
  /** Token budget. When messages exceed this, COLLAPSE is triggered. */
  contextWindow: number
  /** Fraction of contextWindow above which to auto-collapse. Default 0.8. */
  collapseThreshold?: number
  /** Per-tool_result truncation threshold (bytes). Default 2 KiB. */
  snipBytes?: number
  /** Run microcompact every N steps. Default 5. */
  microcompactEvery?: number
  /** Last K tool messages to keep verbatim after a microcompact. Default 6. */
  microcompactKeepLast?: number
  /**
   * Maximum number of COLLAPSE summaries per compaction pass.
   * Default 1 — we collapse once and stop, not iteratively.
   */
  maxSummaries?: number
}

interface InternalOpts {
  contextWindow: number
  collapseThreshold: number
  snipBytes: number
  microcompactEvery: number
  microcompactKeepLast: number
  maxSummaries: number
}

function finalize(o: CompactorOptions): InternalOpts {
  return {
    contextWindow: o.contextWindow,
    collapseThreshold: o.collapseThreshold ?? 0.8,
    snipBytes: o.snipBytes ?? 2 * 1024,
    microcompactEvery: o.microcompactEvery ?? 5,
    microcompactKeepLast: o.microcompactKeepLast ?? 6,
    maxSummaries: o.maxSummaries ?? 1,
  }
}

// --------------------------------------------------------------------------
// Compactor
// --------------------------------------------------------------------------

export type CompactionTrigger = 'snip' | 'microcompact' | 'collapse' | 'manual'

export interface CompactionResult {
  messages: ChatMessage[]
  /** Tokens after compaction (approximate). */
  tokensAfter: number
  /** Tokens before compaction (approximate). */
  tokensBefore: number
  /** What fired in this pass. */
  fired: CompactionTrigger[]
}

export class ContextCompactor {
  private readonly opts: InternalOpts
  /** Number of times we've called `compact()` — used by the caller to decide
   *  whether to microcompact. */
  private stepsSinceLastMicrocompact = 0
  /** Number of COLLAPSE summaries produced in this session. */
  private collapsesRun = 0

  constructor(opts: CompactorOptions) {
    this.opts = finalize(opts)
  }

  /**
   * Compact the given messages in-place. Returns the (possibly mutated)
   * message list plus before/after token counts.
   *
   * Trigger is one of:
   *   'auto'    — called by the agent loop on every step; we decide what to do
   *   'manual'  — called by `/compact`; we run all layers aggressively
   *
   * Returns a `CompactionResult` describing what changed.
   *
   * Hooks (M6):
   *   - `PreCompact` fires before any compaction work begins. A deny
   *     short-circuits — we return immediately with `fired: []` and
   *     unchanged messages. Fail-closed on exception.
   *   - `PostCompact` fires after the layers complete. Informational only.
   *
   *   TODO(M7/M8): the agent loop does not currently wire a compactor into
   *   `runAgentLoop`. The hook payloads are defined here so that when the
   *   compactor is plugged in (planned for the M7 polish milestone), the
   *   hooks fire automatically. Until then, the `hooksEngine` field is
   *   plumbed but un-triggered by the loop itself.
   */
  async compact(
    messages: ChatMessage[],
    provider: Provider,
    opts: { trigger: 'auto' | 'manual'; hooksEngine?: HooksEngine; sessionId?: string; cwd?: string } = {
      trigger: 'auto',
    },
  ): Promise<CompactionResult> {
    const tokensBefore = countMessageTokens(messages)
    const fired: CompactionTrigger[] = []

    // Hook: PreCompact (gating). Deny → bail before touching messages.
    if (opts.hooksEngine) {
      try {
        const decision = await opts.hooksEngine.fire('PreCompact', {
          trigger: opts.trigger,
          tokenCountBefore: tokensBefore,
          sessionId: opts.sessionId ?? '',
          cwd: opts.cwd ?? '',
        })
        if (!decision.allowed) {
          return { messages, tokensBefore, tokensAfter: tokensBefore, fired }
        }
      } catch {
        // Fail-closed: hook error → bail out without compacting.
        return { messages, tokensBefore, tokensAfter: tokensBefore, fired }
      }
    }

    // Layer 1: snip oversized tool_results. Always safe.
    snipToolResults(messages, this.opts.snipBytes)
    fired.push('snip')

    // Layer 2: microcompact every N steps (auto) or always (manual).
    this.stepsSinceLastMicrocompact++
    const shouldMicro =
      opts.trigger === 'manual' ||
      this.stepsSinceLastMicrocompact >= this.opts.microcompactEvery
    if (shouldMicro && messages.length > this.opts.microcompactKeepLast) {
      microcompact(messages, this.opts.microcompactKeepLast)
      fired.push('microcompact')
      this.stepsSinceLastMicrocompact = 0
    }

    // Layer 3: collapse if over threshold (or forced by /compact).
    const overThreshold = tokensBefore >= this.opts.contextWindow * this.opts.collapseThreshold
    const shouldCollapse =
      (opts.trigger === 'manual' || overThreshold) &&
      this.collapsesRun < this.opts.maxSummaries &&
      messages.length > 6
    if (shouldCollapse) {
      const ok = await collapseOld(messages, provider)
      if (ok) {
        fired.push('collapse')
        this.collapsesRun++
      }
    }

    const tokensAfter = countMessageTokens(messages)

    // Hook: PostCompact (informational). Fire-and-forget.
    if (opts.hooksEngine) {
      void opts.hooksEngine
        .fire('PostCompact', {
          tokenCountBefore: tokensBefore,
          tokenCountAfter: tokensAfter,
          sessionId: opts.sessionId ?? '',
          cwd: opts.cwd ?? '',
        })
        .catch(() => {
          /* swallow — PostCompact is for diagnostics only */
        })
    }

    return { messages, tokensBefore, tokensAfter, fired }
  }
}

// --------------------------------------------------------------------------
// Layer 1 — snip
// --------------------------------------------------------------------------

/**
 * Truncate every tool_result whose content exceeds `maxBytes`. Idempotent —
 * already-truncated messages are recognized by the "(truncated)" marker.
 */
export function snipToolResults(messages: ChatMessage[], maxBytes: number): void {
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue
    for (const b of m.content as ContentBlock[]) {
      if (b.type !== 'tool_result') continue
      const text =
        typeof b.content === 'string'
          ? b.content
          : b.content.map((t) => t.text).join('')
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > maxBytes && !text.includes('… (') && !text.includes('truncated')) {
        const truncated = text.slice(0, maxBytes)
        const marker = `\n\n… (${bytes - maxBytes} bytes truncated; use offset/limit or read again to see more)`
        b.content = truncated + marker
      }
    }
  }
}

// --------------------------------------------------------------------------
// Layer 2 — microcompact
// --------------------------------------------------------------------------

/**
 * Replace every tool_use/result pair whose index is more than `keepLast`
 * steps back with a `<previous tool call, result omitted>` placeholder.
 * Preserves role alternation and message structure.
 */
export function microcompact(messages: ChatMessage[], keepLast: number): void {
  // We work backward from the end, counting "tool steps" (a tool_use +
  // its tool_result). The most recent `keepLast` are preserved; older ones
  // become a single text block.
  let stepsSeen = 0
  let cutIndex = -1 // the index at which we start replacing

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (isToolStepBoundary(m)) {
      stepsSeen++
      if (stepsSeen > keepLast) {
        cutIndex = i
      }
    }
  }

  if (cutIndex <= 0) return

  // Replace messages[0..cutIndex+1] (inclusive of the boundary tool step) with
  // a single user message that says "previous tool calls and results were
  // omitted". We only do this if there is at least one tool step in the cut
  // range; otherwise the head is all text and we leave it.
  const headEnd = cutIndex + 1
  const head = messages.slice(0, headEnd)
  const hasToolStep = head.some(isToolStepBoundary)
  if (!hasToolStep) return

  const summary: ChatMessage = {
    role: 'user',
    content:
      `<previous tool calls and results omitted to save context>\n` +
      `(${head.length} earlier messages compacted; ` +
      `use the read/grep tools if you need to see them again)`,
  }
  messages.splice(0, headEnd, summary)
}

function isToolStepBoundary(m: ChatMessage): boolean {
  if (typeof m.content === 'string') return false
  return m.content.some(
    (b) => (b as ContentBlock).type === 'tool_use' || (b as ContentBlock).type === 'tool_result',
  )
}

// --------------------------------------------------------------------------
// Layer 3 — collapse (LLM summary)
// --------------------------------------------------------------------------

/**
 * Summarize the older half of the conversation into a single "Past context:"
 * block. Returns true if the operation succeeded and the messages were
 * mutated. On failure (provider error), the messages are left unchanged.
 *
 * Implementation: pick the cutoff so the older ~half of text messages is
 * sent to the provider as a single user message asking for a structured
 * summary. The newer half (including all tool messages) is preserved
 * verbatim.
 */
async function collapseOld(messages: ChatMessage[], provider: Provider): Promise<boolean> {
  if (messages.length < 8) return false

  // Find the midpoint: keep the second half verbatim, summarize the first half.
  const midpoint = Math.floor(messages.length / 2)

  // Don't split a tool_use / tool_result pair. Walk back from midpoint until
  // we're at a non-tool-step boundary.
  let cut = midpoint
  while (cut > 0 && isToolStepBoundary(messages[cut]!)) cut--

  if (cut < 2) return false // nothing meaningful to summarize

  const old = messages.slice(0, cut)
  const recent = messages.slice(cut)

  const oldText = serializeMessages(old)
  if (countTokens(oldText) < 200) return false // already short

  const summaryPrompt: ChatMessage[] = [
    {
      role: 'user',
      content:
        `Summarize the following conversation history into a compact, factual ` +
        `narrative. Preserve: (a) user goals, (b) decisions made, (c) tool ` +
        `names + paths touched, (d) errors encountered, (e) TODOs in flight. ` +
        `Drop: greetings, repetitions, raw tool outputs.\n\n` +
        `Output format: a single fenced markdown block. No preamble.\n\n` +
        `---\n${oldText}\n---`,
    },
  ]

  try {
    const res = await provider.chat({ messages: summaryPrompt, maxTokens: 1024 })
    const summaryText = extractText(res.message.content)
    if (!summaryText || summaryText.trim().length === 0) return false

    const summary: ChatMessage = {
      role: 'user',
      content: `<past-context-summary>\n${summaryText.trim()}\n</past-context-summary>`,
    }

    messages.length = 0
    messages.push(summary, ...recent)
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function serializeMessages(msgs: ChatMessage[]): string {
  const parts: string[] = []
  for (const m of msgs) {
    const role = m.role.toUpperCase()
    if (typeof m.content === 'string') {
      parts.push(`${role}: ${m.content}`)
    } else {
      const texts: string[] = []
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'text') texts.push(b.text)
        else if (b.type === 'tool_use') texts.push(`[tool_use ${b.name}]`)
        else if (b.type === 'tool_result') {
          texts.push(
            typeof b.content === 'string'
              ? `[tool_result] ${b.content}`
              : `[tool_result] ${b.content.map((t) => t.text).join('')}`,
          )
        }
      }
      parts.push(`${role}: ${texts.join(' ')}`)
    }
  }
  return parts.join('\n\n')
}

function extractText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content
  return (content as ContentBlock[])
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
