/**
 * RewindPanel — interactive checkpoint picker.
 *
 * Layout:
 *
 *   ┌─ Checkpoints ────────────────────────────────────────────────┐
 *   │  ▶  1.  12:34:56  write    src/foo.ts                          │
 *   │     2.  12:33:21  edit     src/bar.ts                          │
 *   │     3.  12:32:04  edit     README.md                           │
 *   └───────────────────────────────────────────────────────────────┘
 *   What to do?  (r) restore code  (s) summarize from here  (Esc) cancel
 *
 * - ↑/↓ to navigate, Enter to select.
 * - After selecting, the user is asked what to do with the picked
 *   checkpoint. We surface the choice via `onSelect`.
 * - Esc cancels and fires `onCancel`.
 *
 * This panel is rendered as a child of the App. The parent owns the
 * checkpoint data and decides what to do with the choice. The panel itself
 * has no I/O side effects.
 */
import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { theme, c } from './theme.js'
import type { CheckpointSnapshot } from '../core/checkpoint-manager.js'

export type RewindAction = 'restore-code' | 'summarize-from-here' | 'summarize-up-to-here'

export interface RewindChoice {
  snapshot: CheckpointSnapshot
  action: RewindAction
}

interface Props {
  snapshots: CheckpointSnapshot[]
  onSelect: (choice: RewindChoice) => void
  onCancel: () => void
}

export function RewindPanel({ snapshots, onSelect, onCancel }: Props): JSX.Element {
  const [cursor, setCursor] = useState(0)
  const [stage, setStage] = useState<'pick' | 'action'>('pick')
  const [actionCursor, setActionCursor] = useState(0)

  useInput(
    (input, key) => {
      if (stage === 'pick') {
        if (key.escape) {
          onCancel()
          return
        }
        if (key.return) {
          setStage('action')
          setActionCursor(0)
          return
        }
        if (key.upArrow) {
          setCursor((c) => (c - 1 + snapshots.length) % Math.max(1, snapshots.length))
          return
        }
        if (key.downArrow) {
          setCursor((c) => (c + 1) % Math.max(1, snapshots.length))
          return
        }
        // Number keys: jump to that index (1-based)
        if (/^[1-9]$/.test(input)) {
          const idx = Number.parseInt(input, 10) - 1
          if (idx < snapshots.length) setCursor(idx)
        }
        return
      }

      // stage === 'action'
      if (key.escape) {
        onCancel()
        return
      }
      if (key.leftArrow) {
        setActionCursor((c) => (c - 1 + 3) % 3)
        return
      }
      if (key.rightArrow) {
        setActionCursor((c) => (c + 1) % 3)
        return
      }
      if (key.return) {
        const snap = snapshots[cursor]!
        const action: RewindAction =
          actionCursor === 0
            ? 'restore-code'
            : actionCursor === 1
              ? 'summarize-from-here'
              : 'summarize-up-to-here'
        onSelect({ snapshot: snap, action })
        return
      }
      // Shortcut keys
      if (input === 'r') {
        onSelect({ snapshot: snapshots[cursor]!, action: 'restore-code' })
        return
      }
      if (input === 's') {
        onSelect({ snapshot: snapshots[cursor]!, action: 'summarize-from-here' })
        return
      }
    },
    { isActive: true },
  )

  if (snapshots.length === 0) {
    return (
      <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={theme.warn} paddingX={1}>
        <Text color={theme.warn}>No checkpoints available.</Text>
      </Box>
    )
  }

  const actions: { label: string; sub: string; key: string }[] = [
    { label: 'Restore code', sub: 'rewrite files to their pre-mutation state', key: 'r' },
    { label: 'Summarize from here', sub: 'replace conversation after this point with a summary', key: 's' },
    { label: 'Summarize up to here', sub: 'replace conversation before this point with a summary', key: 'u' },
  ]

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={theme.brand} paddingX={1}>
      <Box marginBottom={1}>
        <Text color={theme.brand} bold>
          Checkpoints ({snapshots.length})
        </Text>
      </Box>
      <Box flexDirection="column">
        {snapshots.map((s, i) => {
          const selected = i === cursor
          const time = new Date(s.createdAt).toLocaleTimeString()
          const marker = selected ? c.brand('▶ ') : '  '
          const idx = ` ${(i + 1).toString().padStart(2, ' ')}. `
          const path = s.path.length > 40 ? '…' + s.path.slice(-39) : s.path
          return (
            <Box key={s.id}>
              <Text color={selected ? theme.brand : undefined}>{marker}</Text>
              <Text color={selected ? theme.brand : theme.muted}>{idx}</Text>
              <Text color={selected ? theme.brand : theme.dim}>{time}  </Text>
              <Text color={selected ? theme.brand : theme.muted}>{s.label.padEnd(8, ' ')} </Text>
              <Text color={selected ? theme.brand : undefined}>{path}</Text>
              {s.sentinelCreated ? (
                <Text color={theme.warn}>  [new file]</Text>
              ) : null}
            </Box>
          )
        })}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.muted}>
          ↑/↓ to move, number keys jump, Enter to pick, Esc to cancel.
        </Text>
      </Box>

      {stage === 'action' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.brand} bold>
            What to do with this checkpoint?
          </Text>
          <Box marginTop={1}>
            {actions.map((a, i) => {
              const sel = i === actionCursor
              const arrow = sel ? c.brand('▶ ') : '  '
              const label = sel
                ? `${a.label}  (${a.key})`
                : `${a.label}  (${a.key})`
              return (
                <Box key={a.label} flexDirection="column" marginRight={2}>
                  <Text color={sel ? theme.brand : theme.muted}>
                    {arrow}
                    {label}
                  </Text>
                  <Text color={theme.dim}>  {a.sub}</Text>
                </Box>
              )
            })}
          </Box>
          <Box marginTop={1}>
            <Text color={theme.muted}>←/→ to switch, Enter to confirm, r/s shortcuts.</Text>
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}