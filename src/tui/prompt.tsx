/**
 * Prompt — single-line text input with slash-command awareness.
 *
 * Submits on Enter, clears on Esc. Slash commands are intercepted at submit
 * time (the parent component dispatches them).
 */
import { useState } from 'react'
import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { theme } from './theme.js'

interface Props {
  placeholder?: string
  disabled?: boolean
  onSubmit: (value: string) => void
}

export function Prompt({ placeholder, disabled, onSubmit }: Props): JSX.Element {
  const [value, setValue] = useState('')

  return (
    <Box borderStyle="round" borderColor={theme.brandAccent} paddingX={1}>
      <Text color={theme.brand} bold>
        ›
      </Text>
      <Box marginLeft={1} flexGrow={1}>
        {disabled ? (
          <Text color={theme.muted}>busy… (Ctrl-C to abort)</Text>
        ) : (
          <TextInput
            value={value}
            onChange={setValue}
            onSubmit={(v) => {
              if (!v.trim()) return
              onSubmit(v)
              setValue('')
            }}
            placeholder={placeholder ?? 'ask anything, or type /help'}
          />
        )}
      </Box>
    </Box>
  )
}
