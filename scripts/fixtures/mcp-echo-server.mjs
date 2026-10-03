#!/usr/bin/env node
/**
 * MCP echo server — stdio transport.
 *
 * A minimal Model Context Protocol server that exposes two tools:
 *
 *   - `echo`     echoes its input back as a text content block
 *   - `add`      adds two numbers
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout. Spawned by
 * `scripts/m6-smoke.mjs` to validate the MCP client end-to-end.
 *
 * No external deps — the protocol framing is small enough to write inline.
 */
import { createInterface } from 'node:readline'

// ----- protocol helpers ---------------------------------------------------

const SERVER_INFO = { name: 'echo-server', version: '0.1.0' }
const PROTOCOL_VERSION = '2024-11-05'

const tools = [
  {
    name: 'echo',
    description: 'Echoes input back as a text block',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers and returns the sum',
    inputSchema: {
      type: 'object',
      properties: {
        a: { type: 'number', description: 'first addend' },
        b: { type: 'number', description: 'second addend' },
      },
      required: ['a', 'b'],
    },
  },
]

let nextId = 1

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function replyError(id, code, message) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n',
  )
}

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    reply(msg.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    })
    return
  }
  if (msg.method === 'notifications/initialized') return // no reply
  if (msg.method === 'ping') {
    reply(msg.id, {})
    return
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools })
    return
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args = {} } = msg.params ?? {}
    try {
      if (name === 'echo') {
        const text = String(args.message ?? '')
        reply(msg.id, {
          content: [{ type: 'text', text: `echoed: ${text}` }],
        })
        return
      }
      if (name === 'add') {
        const sum = Number(args.a ?? 0) + Number(args.b ?? 0)
        reply(msg.id, {
          content: [{ type: 'text', text: String(sum) }],
        })
        return
      }
      reply(msg.id, {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true,
      })
    } catch (e) {
      reply(msg.id, {
        content: [{ type: 'text', text: `server error: ${(e instanceof Error ? e.message : String(e))}` }],
        isError: true,
      })
    }
    return
  }
  // Unknown method → JSON-RPC error.
  if (typeof msg.id !== 'undefined') {
    replyError(msg.id, -32601, `method not found: ${msg.method}`)
  }
}

// ----- main loop -----------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
let buffer = ''

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  try {
    await handleMessage(msg)
  } catch (err) {
    if (typeof msg.id !== 'undefined') {
      replyError(msg.id, -32603, err instanceof Error ? err.message : String(err))
    }
  }
})

rl.on('close', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
