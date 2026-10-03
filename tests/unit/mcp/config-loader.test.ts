/**
 * MCP config loader — read + merge user + project files, validate.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadMcpServersConfig } from '../../../src/mcp/config-loader.js'

let TMP: string

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'yuancode-mcp-loader-'))
})
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

const USER = (): string => join(TMP, 'user-mcp.json')
const PROJ = (): string => join(TMP, 'project-mcp.json')

describe('loadMcpServersConfig', () => {
  it('returns empty when both files are missing', () => {
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.servers).toEqual({})
    expect(r.sources).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('parses a single stdio server', () => {
    writeFileSync(
      USER(),
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '.'],
            env: {},
          },
        },
      }),
    )
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.servers.filesystem).toMatchObject({ command: 'npx' })
    expect(r.warnings).toEqual([])
  })

  it('parses a single remote server', () => {
    writeFileSync(
      USER(),
      JSON.stringify({
        mcpServers: {
          github: { url: 'https://api.example.com/mcp', headers: { Auth: 'Bearer x' } },
        },
      }),
    )
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.servers.github).toMatchObject({ url: 'https://api.example.com/mcp' })
  })

  it('project wins on collision (project layered last)', () => {
    writeFileSync(
      USER(),
      JSON.stringify({ mcpServers: { x: { command: 'user-cmd' } } }),
    )
    writeFileSync(
      PROJ(),
      JSON.stringify({ mcpServers: { x: { command: 'project-cmd' } } }),
    )
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.servers.x).toMatchObject({ command: 'project-cmd' })
    expect(r.sources.sort()).toEqual([USER(), PROJ()].sort())
  })

  it('merges keys not in collision', () => {
    writeFileSync(
      USER(),
      JSON.stringify({ mcpServers: { a: { command: 'user-a' } } }),
    )
    writeFileSync(
      PROJ(),
      JSON.stringify({ mcpServers: { b: { command: 'proj-b' } } }),
    )
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(Object.keys(r.servers).sort()).toEqual(['a', 'b'])
  })

  it('warns on invalid JSON', () => {
    writeFileSync(USER(), '{ not json')
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.warnings.some((w) => /JSON/i.test(w))).toBe(true)
    expect(r.servers).toEqual({})
  })

  it('warns on schema error', () => {
    writeFileSync(USER(), JSON.stringify({ mcpServers: { x: { url: 'not-a-url' } } }))
    const r = loadMcpServersConfig({ userPath: USER(), projectPath: PROJ() })
    expect(r.warnings.some((w) => /schema/i.test(w))).toBe(true)
  })
})
