// Smoke demo for M4 modules — no network, no TUI.
import { handleSlash } from '../dist/cli/slash-commands.js'
import { ContextCompactor, snipToolResults } from '../dist/core/context-compactor.js'
import { MemoryCheckpointStorage } from '../dist/core/checkpoint-manager.js'
import { SessionStore } from '../dist/core/session-store.js'
import { countTokens, countMessageTokens } from '../dist/utils/token-counter.js'

console.log('--- /help ---')
const help = handleSlash('/help', { sessionId: 'demo' })
console.log(help.kind === 'show' ? help.text : '(no help)')

console.log('\n--- /compact ---')
console.log(handleSlash('/compact', { sessionId: 'demo' }))

console.log('\n--- /session ---')
const sess = handleSlash('/session', {
  sessionId: 'demo-123',
  usage: { input: 1024, output: 256 },
  steps: 4,
  messageCount: 9,
})
console.log(sess.kind === 'show' ? sess.text : sess)

console.log('\n--- token counter ---')
console.log('countTokens("hello world") =', countTokens('hello world'))
console.log('countMessageTokens([]) =', countMessageTokens([]))

console.log('\n--- snip ---')
const msgs = [
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000), is_error: false },
    ],
  },
]
snipToolResults(msgs, 500)
console.log('after snip (max 500):', msgs[0].content[0].content.length, 'chars')

console.log('\n--- session store ---')
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm4-smoke-'))
const store = new SessionStore({ projectRoot: tmp, sessionId: 'smoke' })
store.ensure()
store.appendEvent({ ts: 1, kind: 'session_start', sessionId: 'smoke', cwd: tmp, model: 'MiniMax-M3' })
store.appendEvent({ ts: 2, kind: 'user_prompt', sessionId: 'smoke', text: 'hello' })
store.appendEvent({ ts: 3, kind: 'assistant_message', sessionId: 'smoke', preview: 'hi back' })
console.log('events:', store.readEvents().map((e) => e.kind).join(', '))
store.writeCheckpoint({
  path: '/tmp/example.ts',
  content: Buffer.from('original content', 'utf8'),
  mode: 0o644,
  label: 'write',
})
const cps = store.listCheckpoints()
console.log('checkpoints:', cps.length, cps.map((c) => c.label).join(', '))
fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n--- memory storage ---')
const mem = new MemoryCheckpointStorage()
await mem.write({
  id: 's1',
  path: '/foo',
  mode: 0o644,
  content: Buffer.from('abc', 'utf8'),
  createdAt: Date.now(),
  label: 'demo',
})
const list = await mem.list()
console.log('memory storage size:', list.length, 'label:', list[0].label)

console.log('\n--- context compactor (snip layer) ---')
const c = new ContextCompactor({ contextWindow: 100000 })
const cMsgs = [
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'y'.repeat(8000), is_error: false },
    ],
  },
]
const result = await c.compact(cMsgs, {
  name: 'mock',
  async chat() {
    return {
      message: { role: 'assistant', content: '' },
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: 'end_turn',
    }
  },
  async *stream() {},
})
console.log('fired:', result.fired, 'before:', result.tokensBefore, 'after:', result.tokensAfter)

console.log('\nM4 smoke demo complete ✓')