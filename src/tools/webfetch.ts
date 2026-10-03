/**
 * Webfetch tool — HTTP GET with SSRF protection.
 *
 * SSRF defenses (all three):
 *   1. URL scheme must be http(s).
 *   2. Hostname cannot resolve to a private/loopback/link-local IP
 *      (we resolve the host first, then check).
 *   3. Redirects are followed manually so we re-validate the next hop.
 *
 * Response is capped to 256 KiB and returned as UTF-8 text. Non-2xx and
 * network errors surface as `tool_result` with isError so the model can
 * adapt (try a different URL, retry, etc.).
 */
import { z } from 'zod'
import { lookup } from 'node:dns/promises'
import type { ToolEntry } from '../core/tool-registry.js'

export const WebfetchInputSchema = z.object({
  url: z.string().url().describe('HTTP or HTTPS URL to fetch.'),
  method: z.enum(['GET', 'HEAD']).optional().describe('HTTP method. Default GET.'),
  maxBytes: z.number().int().positive().max(1_048_576).optional().describe(
    'Max response bytes. Default 256 KiB, max 1 MiB.',
  ),
  timeoutMs: z.number().int().positive().max(60_000).optional().describe(
    'Hard timeout in ms. Default 10 s, max 60 s.',
  ),
})

export type WebfetchInput = z.infer<typeof WebfetchInputSchema>

const DEFAULT_MAX_BYTES = 256 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

export function makeWebfetchTool(): ToolEntry<typeof WebfetchInputSchema> {
  return {
    name: 'webfetch',
    description:
      'Fetch a URL over HTTP(S). SSRF-protected: blocks private/loopback ' +
      'IPs and follows redirects with re-validation. Response capped at ' +
      '256 KiB; pass maxBytes to change.',
    schema: WebfetchInputSchema,
    risk: 'medium',
    parallelSafe: true,
    timeoutMs: 30_000,
    category: 'search',
    handler: async (input, ctx) => {
      const u = new URL(input.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { content: `Refused: scheme ${u.protocol} not allowed`, isError: true }
      }

      // SSRF: resolve hostname, then check each address against private ranges.
      const addresses = await resolveHost(u.hostname)
      for (const a of addresses) {
        if (isPrivateIp(a)) {
          return {
            content: `Refused: ${u.hostname} resolves to private IP ${a}`,
            isError: true,
          }
        }
      }

      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      // Wire to caller's abort so Ctrl-C propagates.
      ctx.abort.hardSignal.addEventListener('abort', () => controller.abort(), { once: true })

      try {
        const res = await fetch(input.url, {
          method: input.method ?? 'GET',
          signal: controller.signal,
          redirect: 'manual',
          headers: {
            'user-agent': 'YuanCode/0.1 (https://github.com/yuancode)',
            accept: '*/*',
          },
        })

        // Manual redirect (max 5 hops) with re-validation
        let hops = 0
        let cur = res
        while ([301, 302, 303, 307, 308].includes(cur.status) && hops < 5) {
          const loc = cur.headers.get('location')
          if (!loc) break
          const next = new URL(loc, cur.url)
          if (next.protocol !== 'http:' && next.protocol !== 'https:') {
            return { content: `Refused redirect to ${next.protocol}`, isError: true }
          }
          const nextAddrs = await resolveHost(next.hostname)
          for (const a of nextAddrs) {
            if (isPrivateIp(a)) {
              return { content: `Refused redirect to private IP ${a}`, isError: true }
            }
          }
          cur = await fetch(next, {
            method: 'GET',
            signal: controller.signal,
            redirect: 'manual',
            headers: { 'user-agent': 'YuanCode/0.1' },
          })
          hops++
        }

        const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
        const reader = cur.body?.getReader()
        let received = 0
        const chunks: Uint8Array[] = []
        if (reader) {
          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) {
              received += value.byteLength
              if (received <= maxBytes) chunks.push(value)
              if (received > maxBytes) break
            }
          }
        }
        const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')

        if (!cur.ok) {
          return {
            content: `HTTP ${cur.status} ${cur.statusText}\n${body.slice(0, 4_000)}`,
            isError: true,
            metadata: { status: cur.status, url: cur.url, bytes: received, truncated: received > maxBytes },
          }
        }

        const truncated = received > maxBytes
        return {
          content:
            `<webfetch url=${shellAttr(cur.url)} status=${cur.status} ` +
            `bytes=${received}${truncated ? ' truncated' : ''}>\n` +
            body +
            `\n</webfetch>`,
          metadata: { status: cur.status, url: cur.url, bytes: received, truncated },
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: `Fetch failed: ${msg}`, isError: true }
      } finally {
        clearTimeout(t)
      }
    },
  }
}

// --------------------------------------------------------------------------
// SSRF helpers
// --------------------------------------------------------------------------

async function resolveHost(host: string): Promise<string[]> {
  // localhost short-circuit
  if (host === 'localhost') return ['127.0.0.1']
  try {
    const addrs = await lookup(host, { all: true })
    return addrs.map((a) => a.address)
  } catch {
    return []
  }
}

function isPrivateIp(ip: string): boolean {
  // IPv4
  if (ip.includes('.')) {
    const parts = ip.split('.').map(Number)
    if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false
    const a = parts[0]!
    const b = parts[1]!
    if (a === 10) return true // 10.0.0.0/8
    if (a === 127) return true // loopback
    if (a === 169 && b === 254) return true // link-local
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
    if (a === 192 && b === 168) return true // 192.168/16
    if (a === 0) return true // 0.0.0.0
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a >= 224) return true // multicast + reserved
    return false
  }
  // IPv6 — check loopback, link-local, unique-local
  if (ip === '::1' || ip === '::') return true
  const lower = ip.toLowerCase()
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — strip and re-check
  if (lower.startsWith('::ffff:')) {
    return isPrivateIp(lower.slice(7))
  }
  return false
}

function shellAttr(s: string): string {
  return `"${s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
}
