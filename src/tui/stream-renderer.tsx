/**
 * StreamRenderer — renders partial model output as it arrives.
 *
 * M1 uses the non-streaming Provider.chat() path, so this component is
 * unused at runtime for now. It's kept here so M2 can drop in streaming
 * without changing the parent component.
 */
import { useEffect, useState } from 'react'
import { Text } from 'ink'

interface Props {
  /** Subscribe to text deltas. */
  source?: AsyncIterable<string>
  initial?: string
}

export function StreamRenderer({ source, initial = '' }: Props): JSX.Element {
  const [text, setText] = useState(initial)

  useEffect(() => {
    if (!source) return
    let cancelled = false
    void (async () => {
      for await (const delta of source) {
        if (cancelled) return
        setText((cur) => cur + delta)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [source])

  return <Text wrap="wrap">{text}</Text>
}
