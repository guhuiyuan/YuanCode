---
title: Tools
description: Built-in tools available to the model — schemas, risk levels, timeouts.
milestone: M1-M7
audience: contributors, integrators
---

# Built-in tools

Every tool the model can call lives in `src/tools/`. They're registered
into `ToolRegistry` at boot via `registerDefaultTools()` in
[src/tools/index.ts](../src/tools/index.ts). The model sees the tool
list on every turn and decides which to call.

## Tool catalogue

| Tool | Risk | parallelSafe | Category | Timeout | Default |
|---|---|---|---|---|---|
| `read` | low | ✅ | file | 30s | yes |
| `write` | high | ❌ | file | 30s | yes |
| `edit` | high | ❌ | file | 30s | yes |
| `bash` | high | ❌ | shell | 60s | yes |
| `grep` | low | ✅ | search | 30s | yes |
| `glob` | low | ✅ | search | 15s | yes |
| `ls` | low | ✅ | file | 15s | yes |
| `webfetch` | medium | ✅ | search | 30s | yes |
| `todowrite` | low | ❌ | plan | 10s | yes |
| `skill` | low | ❌ | knowledge | 15s | yes |
| `task_create` | low | ✅ | plan | 10s | yes |
| `task_list` | low | ✅ | plan | 10s | yes |
| `task_get` | low | ✅ | plan | 10s | yes |
| `task_update` | low | ❌ | plan | 10s | yes |
| `subagent` | medium | ❌ | agent | 120s | yes |
| `background_start` | medium | ❌ | agent | 30s | yes |
| `background_check` | low | ✅ | agent | 10s | yes |
| `mcp__<server>__<tool>` | low | ✅ | mcp | 30s | opt-in |

Risk levels:

- `low` — read-only / metadata. Auto-allowed in all permission modes.
- `medium` — starts processes, makes HTTP requests. Auto-allowed in
  `auto` mode, asked otherwise.
- `high` — mutates state (write/edit) or runs arbitrary shell. Auto-
  allowed in `auto`, **asked** in `acceptEdits` (file tools excepted),
  **denied** in `plan`.

## Adding a tool

A tool is a `ToolEntry`:

```ts
import { z } from 'zod'
import type { ToolEntry } from '../core/tool-registry.js'

export const myTool: ToolEntry<typeof schema> = {
  name: 'my_tool',
  description: 'What the model reads. When to use + input shape.',
  schema: z.object({ path: z.string() }),
  handler: async (input, ctx) => {
    // input is already validated. ctx carries cwd, sandbox, abort, ...
    return { content: `read ${input.path}` }
  },
  risk: 'low',
  parallelSafe: true,
  timeoutMs: 30_000,
  category: 'file',
}
```

Register it in [src/tools/index.ts](../src/tools/index.ts):

```ts
registry.register(myTool)
```

The model can call it on the next turn.

## Sandbox-aware tools

`bash` and `write`/`edit` go through the configured `SandboxRunner`.
See [docs/sandbox.md](./sandbox.md) for what each mode restricts.

- `local` — `cwd` + `PathGuard` + env scrubbing
- `bubblewrap` — Linux user namespace, no network
- `docker` — `--network none --memory 512m --cpus 1` container
- `landlock` — kernel-level filesystem sandbox (Linux 5.13+)

If a tool's input touches a forbidden path, the sandbox throws
`SandboxPathError` and the model sees a `tool_result` with `isError: true`.

## MCP tools

External tool servers are dynamically discovered via MCP. Their names are
auto-prefixed: `mcp__<server>__<tool>` (e.g. `mcp__filesystem__read_file`).
Risk defaults to `low` (the MCP server is user-trusted at config time).
See [docs/mcp.md](./mcp.md).

## Timeouts

`timeoutMs` is the per-call wall-clock limit. The harness enforces it
via `withTimeout()` — see
[src/utils/with-timeout.ts](../src/utils/with-timeout.ts). On timeout
the tool returns a `tool_result` with `isError: true` and the model
is expected to retry with a smaller scope.

The session-level `totalTimeoutMs` and step-level `perStepTimeoutMs`
are enforced by the loop, not by individual tools. See
[docs/cost-and-limits.md](./cost-and-limits.md).

## Error model

Tools never throw to the model. Every failure path returns:

```ts
{ content: '<human-readable message>', isError: true }
```

The loop converts that into a normal `tool_result` block so the model
sees the error in conversation context and can adapt. Only network /
auth / provider errors throw out of the loop (where they become
`stopReason: 'provider_error'`).