/**
 * Message list — renders the conversation history.
 *
 * One row per logical message (user turn, assistant turn, tool turn, system
 * note). Long assistant text wraps within the terminal width.
 *
 * Streaming: when a partial assistant text is in flight, it is appended to
 * the last assistant message and rendered with a blinking caret.
 */
import { Box, Text } from 'ink'
import { theme, c } from './theme.js'
import type { ReactNode } from 'react'

export type DisplayMessage =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string; streaming?: boolean }
  | { kind: 'tool'; name: string; status: 'running' | 'done' | 'error'; summary?: string; durationMs?: number }
  | { kind: 'system'; text: string; tone?: 'info' | 'warn' | 'error' }

interface Props {
  messages: DisplayMessage[]
}

export function MessageList({ messages }: Props): JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages.map((m, i) => (
        <MessageRow key={i} msg={m} />
      ))}
    </Box>
  )
}

function MessageRow({ msg }: { msg: DisplayMessage }): JSX.Element {
  switch (msg.kind) {
    case 'user':
      return (
        <Box marginTop={1}>
          <Text>{c.userLabel} </Text>
          <Text>{msg.text}</Text>
        </Box>
      )
    case 'assistant':
      return (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text>{c.assistantLabel} </Text>
            <Text>{msg.text}</Text>
            {msg.streaming ? <Text color="gray"> ▍</Text> : null}
          </Box>
        </Box>
      )
    case 'tool':
      return (
        <Box marginLeft={2}>
          <ToolRow msg={msg} />
        </Box>
      )
    case 'system':
      return (
        <Box marginTop={1}>
          <Text>{c.systemLabel} </Text>
          <SystemTone tone={msg.tone}>{msg.text}</SystemTone>
        </Box>
      )
  }
}

function ToolRow({
  msg,
}: {
  msg: Extract<DisplayMessage, { kind: 'tool' }>
}): ReactNode {
  const icon =
    msg.status === 'running' ? c.statusBusy : msg.status === 'error' ? c.statusError : c.statusOk
  const label = msg.status === 'running' ? `running ${msg.name}` : `${msg.name} ${msg.status}`
  return (
    <Box>
      <Text>{icon} </Text>
      <Text color={theme.muted}>{label}</Text>
      {msg.summary ? <Text color={theme.muted}>  {msg.summary}</Text> : null}
      {typeof msg.durationMs === 'number' ? (
        <Text color={theme.dim}>  ({msg.durationMs}ms)</Text>
      ) : null}
    </Box>
  )
}

function SystemTone({
  tone,
  children,
}: {
  tone?: 'info' | 'warn' | 'error'
  children: ReactNode
}): JSX.Element {
  const color = tone === 'warn' ? theme.warn : tone === 'error' ? theme.error : theme.muted
  return <Text color={color}>{children}</Text>
}
