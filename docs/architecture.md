---
title: Architecture
description: Five-layer design of YuanCode — Output, Config, Extensions, Harness, Model.
milestone: M0-M7
audience: contributors, integrators
---

# YuanCode Architecture

YuanCode is a **Claude Code-like coding agent harness** built as five thin layers.
Every layer talks only to the layer below it; every cross-cutting concern
(cost, trace, sandbox, limits) is implemented once and surfaced everywhere.

```
┌────────────────────────────────────────────────────────────┐
│  L1 Output           Terminal CLI + Ink TUI               │
├────────────────────────────────────────────────────────────┤
│  L2 Config           user → project → session              │
├────────────────────────────────────────────────────────────┤
│  L3 Extensions       Yuan.md │ Skills │ Subagents │ MCP │ Hooks │
├────────────────────────────────────────────────────────────┤
│  L4 Harness          AgentLoop │ ToolRegistry │ Gate │ Compactor │
│                      Checkpoint │ TraceLogger │ CostGuard │ Sandbox │
├────────────────────────────────────────────────────────────┤
│  L5 Model            Anthropic / OpenAI / MiniMax / custom │
└────────────────────────────────────────────────────────────┘
```

## Layer 1 — Output

`src/cli/*` and `src/tui/*`. The CLI command (default: `yuancode`) wires
together every other layer, instantiates the singletons, and hands them to
the TUI. The TUI is a thin React/Ink component tree — the harness is what
actually drives work, not the UI.

Key files:

- [src/cli/run.ts](../src/cli/run.ts) — boot order, signal handling, shutdown
- [src/tui/app.tsx](../src/tui/app.tsx) — Ink root component, message stream

## Layer 2 — Config

`src/config/*`. Three scopes merged at boot, later scopes override earlier:

1. **defaults** — `src/config/defaults.ts`, friendly clone-and-go values
2. **user** — `~/.yuancode/config.yaml`
3. **project** — `<cwd>/.yuancode/config.yaml`
4. **env** — `process.env` overrides for secrets

Schema-validated via Zod in `src/config/schema.ts`. Unknown keys are
stripped with a warning rather than crashing — friendlier first-run UX.

## Layer 3 — Extensions

The "5 件套" (five-piece set) the user can wire in without touching the
harness:

| Extension | Where it loads | What it adds |
|-----------|----------------|--------------|
| **Yuan.md** | `src/extensions/yuan-md.ts` | Project rules injected into the system prompt on every turn |
| **Skills** | `src/extensions/skills.ts` + `src/tools/skill.ts` | `SKILL.md` recipes loaded on-demand via the `skill` tool |
| **Subagents** | `src/core/subagent.ts` + `src/tools/subagent.ts` | Fresh-context child loops (general / explore / review) |
| **MCP** | `src/mcp/*` | External tool servers via stdio or Streamable HTTP |
| **Hooks** | `src/hooks/*` | 11 lifecycle events that can allow / deny / log |

Each is opt-in: if the corresponding config file is missing, the harness
runs without it.

## Layer 4 — Harness core

The while-loop driving everything. **Eight** modules:

| Module | File | Job |
|---|---|---|
| `AgentLoop` | [src/core/loop.ts](../src/core/loop.ts) | Single-threaded while-true, while-step budget not blown |
| `ToolRegistry` | [src/core/tool-registry.ts](../src/core/tool-registry.ts) | name → schema + handler + risk + timeout |
| `PermissionGate` | [src/core/permission-gate.ts](../src/core/permission-gate.ts) | mode → hooks → user-ask, three-stage pipeline |
| `SessionStore` | [src/core/session-store.ts](../src/core/session-store.ts) | append-only event log + checkpoint refs |
| `ContextCompactor` | [src/core/context-compactor.ts](../src/core/context-compactor.ts) | 3-layer compression (snip / microcompact / collapse) |
| `CheckpointManager` | [src/core/checkpoint-manager.ts](../src/core/checkpoint-manager.ts) | file snapshots before destructive tools |
| `TraceLogger` | [src/core/trace-logger.ts](../src/core/trace-logger.ts) | span/trace observability, JSONL sink |
| `CostGuard` | [src/core/cost-guard.ts](../src/core/cost-guard.ts) | USD accounting with parent/child scopes |
| `BackgroundTaskPool` | [src/core/background-tasks.ts](../src/core/background-tasks.ts) | long-running tool calls, completion notifications |
| `TaskManager` | [src/core/task-manager.ts](../src/core/task-manager.ts) | DAG with cycle detection, on-disk persistence |

The four sandbox implementations (`local` / `bubblewrap` / `docker` /
`landlock`) sit beside these — see [docs/sandbox.md](./sandbox.md).

## Layer 5 — Model

`src/model/*`. Provider-agnostic — the loop sees only `ChatMessage`,
`ContentBlock`, `Usage`. Each adapter translates between the wire format
and the normalised types.

| Adapter | File | Protocol |
|---|---|---|
| `minimax-adapter` | [src/model/minimax-adapter.ts](../src/model/minimax-adapter.ts) | Anthropic-compatible, `MiniMax-M3` default |
| `anthropic-adapter` | [src/model/anthropic-adapter.ts](../src/model/anthropic-adapter.ts) | Native Anthropic Messages API |
| `openai-adapter` | [src/model/openai-adapter.ts](../src/model/openai-adapter.ts) | OpenAI Chat Completions |
| `factory.ts` | [src/model/factory.ts](../src/model/factory.ts) | picks adapter from config |

A custom OpenAI-compatible provider can be added by setting
`model.provider: custom` + `model.baseUrl` + `model.apiKey` — see
[README.md](../README.md#configuration).

## Cross-cutting concerns

These touch every layer:

### Observability (TraceLogger)

Every meaningful unit of work is a span: `loop.run` / `loop.llm` /
`tool.<name>` / `gate.decide` / `mcp.callTool`. Spans are emitted live to
pino logs and (optionally) flushed to a JSONL sink file. See
[docs/cost-and-limits.md](./cost-and-limits.md#trace-output) for the
`YUANCODE_TRACE_FILE` env var.

### Cost accounting (CostGuard)

Real USD pricing — `pricing:` in `config.yaml` overrides the built-in
defaults. The loop calls `costGuard.record(model, usage)` after every LLM
response and breaks when `isOverBudget()` is true. Subagents inherit a
child scope so a runaway child can't burn the parent's budget. See
[docs/cost-and-limits.md](./cost-and-limits.md).

### Limits (M1 — unchanged)

Four numeric ceilings in `limits.*`:

- `maxSteps` — loop iterations (default 50)
- `totalTimeoutMs` — wall-clock for the whole session (default 30 min)
- `perStepTimeoutMs` — used as `maxTokens` per LLM call (default 60k)
- `maxCostUsd` — USD ceiling (default $5; 0 = unlimited)
- `parallelTools` — max concurrent safe tool calls (default 8)

### Hard-abort

`TwoLevelAbort` (see [src/core/abort.ts](../src/core/abort.ts)) provides
soft + hard abort. Hard-abort cascades into every running tool, the
provider's AbortSignal, and background tasks.

### Sandbox (M7)

Four modes — see [docs/sandbox.md](./sandbox.md). The default `local`
mode applies `PathGuard` + env scrubbing on every shell tool call; the
three other modes add OS-level isolation.

## Wiring diagram

```
cli/run.ts boot
   ↓
config/loader.ts ← config/schema.ts
   ↓
provider = factory.create(config.model)
   ↓
sandbox = createSandbox(config.sandbox)
   ↓
registry = new ToolRegistry() + registerDefaultTools({ sandbox, ... })
   ↓
hooks = HooksEngine.load(hooksPaths())
   ↓
mcpManager = McpManager.start(mcpConfig, { trace })
   ↓
gate = new PermissionGate({ mode, rules, hooksEngine })
   ↓
costGuard = new CostGuard({ pricing, maxCostUsd, model })
   ↓
trace = new TraceLogger({ sessionId, sinkPath: YUANCODE_TRACE_FILE })
   ↓
runAgentLoop({ provider, registry, gate, costGuard, trace, hooks, ... })
   ↓
finally: hooks.fire(SessionEnd), mcpManager.dispose(), trace.flush()
```

The harness stays decoupled from any single provider / sandbox / model —
that's the design's payoff.