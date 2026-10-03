---
title: MCP
description: Model Context Protocol integration — stdio + Streamable HTTP, naming, crash handling.
milestone: M6
audience: contributors, integrators
---

# Model Context Protocol (MCP)

MCP lets you attach external tool servers to YuanCode without recompiling.
A filesystem server, a GitHub server, an internal API server — anything
speaking the [MCP protocol](https://modelcontextprotocol.io/) can register
its tools into the agent's `ToolRegistry`.

## Configuration

Two locations, merged at boot (project wins on collision):

- `~/.yuancode/mcp.json` — user-level
- `<cwd>/.yuancode/mcp.json` — project-level

Or the YAML equivalent (`~/.yuancode/mcp.yaml` / `mcp.yml`).

### stdio server

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "env": {
      "DEBUG": "1"
    }
  }
}
```

YuanCode spawns the command, connects the stdio transport, runs the MCP
`initialize` handshake, then lists tools.

### Streamable HTTP server

```json
{
  "github": {
    "url": "https://api.github.com/mcp",
    "headers": {
      "Authorization": "Bearer ${GITHUB_TOKEN}"
    }
  }
}
```

The `Authorization` header supports `${ENV_VAR}` expansion — YuanCode
reads the value from `process.env` at boot. Environment keys are scrubbed
from the child process environment (see [docs/sandbox.md](./sandbox.md))
so passing secrets via `${…}` is safe.

## Naming

Every MCP tool is registered into the `ToolRegistry` under the canonical
name:

```
mcp__<normalized-server>__<server-tool>
```

`<normalized-server>` is the user-provided server name lowercased and
restricted to `[a-z0-9_]+`. The `<server-tool>` part is whatever the
server reported via `tools/list`. The model sees these names verbatim.

So `filesystem` server's `read_file` tool becomes `mcp__filesystem__read_file`.

## Lifecycle

```
McpManager.start(servers)
   ├── for each server (in parallel):
   │     ├── spawn stdio child OR open HTTP session
   │     ├── MCP initialize handshake
   │     ├── tools/list → McpToolSpec[]
   │     └── register each tool into ToolRegistry (category='mcp')
   └── return { warnings: string[] }
```

If a server fails to start, the failure is appended to `warnings` and
the rest of the servers still come up. The harness keeps running with
whatever did connect.

## Crash handling

Each `McpServerConnection` wires `transport.onclose`:

- **stdio child exits unexpectedly** → marked `crashed=true`
- **HTTP session drops** → marked `crashed=true`

`callTool` on a crashed connection returns:

```
{ content: 'mcp server "<name>" is unavailable (crashed or not connected)', isError: true }
```

The model sees a normal `tool_result` with `isError: true` and can adapt.
YuanCode does **not** auto-reconnect — the user is expected to restart
the session or fix the server. This is deliberate: silently reconnecting
on every drop can hide real outages.

## Per-call timeout

Each MCP call has a 30-second default timeout. The connection itself
stays open; only the in-flight call is killed. This is generous for most
filesystem / GitHub operations but caps network-bound servers so a slow
server can't block the loop forever.

## Permissions

MCP tools default to:

- **risk**: `low` (the MCP server was user-authorized at config time)
- **parallelSafe**: `true`
- **category**: `mcp`
- **timeoutMs**: 30_000

In `plan` mode, MCP tools are gated by their category — high-risk tools
are denied. In `auto` mode they're auto-allowed. See
[docs/architecture.md](./architecture.md#layer-4-harness-core) for the
permission matrix.

## Sandbox

MCP tools **do not** run inside the configured sandbox — the MCP server
already has its own process boundary, and the user authorized it at config
time. The harness does NOT route MCP tool calls through `SandboxRunner`.

The connection itself inherits the loop's `hardSignal` so a parent
abort cascades through.

## Tracing

When a `TraceLogger` is wired (see
[docs/cost-and-limits.md](./cost-and-limits.md#trace-output)), each
`callTool` is wrapped in an `mcp.callTool` span with attributes
`{ server, tool }`.

## Example: a filesystem server

```bash
# Install once
npm i -g @modelcontextprotocol/server-filesystem
```

```json
// ~/.yuancode/mcp.json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/projects"]
  }
}
```

After restart, the model sees `mcp__filesystem__read_file`,
`mcp__filesystem__write_file`, `mcp__filesystem__list_directory`, etc.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `mcp server "..." is unavailable` | server crashed mid-session | restart yuancode |
| `mcp: server name collision after normalization` | two servers normalized to same name | rename one |
| `connection timed out` | server takes >30s to respond | bump `mcp.timeoutMs` (M7+) or fix server |
| Tool list empty | server returned no tools | run the server standalone, check `tools/list` |
| Auth errors | `${ENV_VAR}` didn't expand | check `process.env` at boot |