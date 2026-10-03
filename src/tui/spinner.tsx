/**
 * Spinner — animated indicator shown while the loop is in flight.
 *
 * Uses 4 frames at 80ms each. Stops automatically when unmounted.
 */
import { useEffect, useState } from 'react'
import { Text } from 'ink'
import { theme } from './theme.js'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface SpinnerProps {
  label?: string
  /** Override the spin interval in ms. Default 80. */
  intervalMs?: number
}

export function Spinner({ label, intervalMs = 80 }: SpinnerProps): JSX.Element {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])

  return (
    <Text>
      <Text color="yellow">{FRAMES[frame]}</Text>
      {label ? <Text color="gray"> {label}</Text> : null}
    </Text>
  )
}

export const TinySpinner = ({ label }: { label?: string }): JSX.Element => (
  <Text>
    <Text color="yellow">⠿</Text>
    {label ? <Text color={theme.muted}> {label}</Text> : null}
  </Text>
)
