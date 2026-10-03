---
title: Cost & Limits
description: CostGuard (USD accounting) and the four loop-level limits.
milestone: M7
audience: users, contributors
---

# Cost & Limits

Two complementary mechanisms keep a YuanCode session from running away:

- **CostGuard** — USD accounting. Knows what each LLM call actually costs.
- **Limits** — numeric ceilings. `maxSteps`, `totalTimeoutMs`, `maxCostUsd`,
  `parallelTools`.

They work together: `maxCostUsd` is the configured ceiling; CostGuard is
how the loop checks "are we over yet?".

## CostGuard

[src/core/cost-guard.ts](../src/core/cost-guard.ts) replaces M6's
`1M tokens ≈ $1` heuristic with a real pricing table.

### Built-in defaults

USD per 1 000 tokens. Conservative best-guesses as of mid-2026 — your
bill may differ.

| Model | input | output | cache read | cache write |
|---|---|---|---|---|
| `MiniMax-M3` | $0.10 | $0.30 | (default) | 4× input |
| `claude-opus-4-5` | $15.00 | $75.00 | (default) | 4× input |
| `claude-sonnet-4-5` | $3.00 | $15.00 | (default) | 4× input |
| `claude-haiku-4-5` | $0.80 | $4.00 | (default) | 4× input |
| `gpt-4o` | $2.50 | $10.00 | (default) | 4× input |
| `gpt-4o-mini` | $0.15 | $0.60 | (default) | 4× input |

`cache read` defaults to `input` price (Anthropic charges ~10% of input
for cache hits; we round up to be conservative). `cache write` defaults
to `4 × input` (Anthropic's multiplier).

### Override per model

```yaml
# ~/.yuancode/config.yaml
pricing:
  'MiniMax-M3':
    input: 0.05       # you have a custom discount
    output: 0.20
    cacheRead: 0.005
    cacheWrite: 0.20
```

Unknown models fall back to the loop's `primaryModel` then to a flat
$3.00 / $15.00 default — defensive against typos.

### How the loop uses it

```ts
// In AgentLoop.runAgentLoop — after every provider.chat() call:
if (deps.costGuard && response.model) {
  deps.costGuard.record(response.model, response.usage)
}
```

When `costGuard.isOverBudget()` returns true, the loop breaks with
`stopReason: 'cost_limit'`.

### Grace fraction

A configurable grace (default 5%) lets one in-flight call finish instead
of truncating mid-response:

```
effectiveBudget = maxCostUsd * (1 + graceFraction)
```

So with `maxCostUsd: 5.0` and `graceFraction: 0.05`, the loop will
break somewhere between $5.00 and $5.25 of cumulative spend.

### Subagent scoping

Every subagent derives a `child()` CostGuard — it shares the parent's
records (so the parent's `breakdown()` still sees subagent usage) but
enforces its own (tighter) ceiling:

```ts
parentDeps.costGuard.child({ maxCostUsd: 0.5, source: 'subagent' })
```

This means a runaway subagent can burn at most $0.50 before its own
loop breaks with `stopReason: 'cost_limit'`, regardless of how much the
parent has spent.

### Breakdown

```ts
const breakdown = costGuard.breakdown()
// {
//   totalCostUsd: 0.42,
//   totalInputTokens: 124_000,
//   totalOutputTokens: 38_000,
//   totalCacheReadTokens: 88_000,
//   totalCacheWriteTokens: 12_000,
//   byModel: { 'MiniMax-M3': { costUsd: 0.42, inputTokens: 124_000, outputTokens: 38_000 } },
//   records: [ { id, source: 'loop', model, inputTokens, outputTokens, costUsd, at: <ts> }, ... ]
// }
```

### Pricing is best-effort

YuanCode does not call any pricing API. The values in `DEFAULT_PRICING`
are conservative best-guesses, and the override mechanism is your escape
hatch. Treat `breakdown().totalCostUsd` as an estimate — your actual bill
depends on your provider contract.

## Limits

Four numeric ceilings in `config.yaml → limits.*`:

```yaml
limits:
  maxSteps: 50              # loop iterations
  totalTimeoutMs: 1_800_000 # whole session wall-clock (30 min)
  perStepTimeoutMs: 60_000  # per LLM call (used as maxTokens)
  maxCostUsd: 5.0           # USD ceiling (0 = unlimited)
  parallelTools: 8          # max concurrent safe tool calls
```

### `maxSteps`

Hard ceiling on the number of LLM calls in a single session. The loop
breaks with `stopReason: 'max_steps'` once exceeded. Default 50 — enough
for ~30 minutes of meaningful work.

### `totalTimeoutMs`

Wall-clock for the entire session. The loop checks `Date.now() - runStart`
at the top of each iteration. Default 30 minutes.

### `perStepTimeoutMs`

⚠️ **Misleading name** — this field is passed as `maxTokens` to the
provider, NOT used as a wall-clock timer. The provider then enforces
its own timeout (typically streaming idle timeout). The name is a
holdover from M1; M7 documents but does not rename the field. A real
wall-clock timer would risk truncating slow-but-valid generations.

If you want a per-step wall-clock cap, set it lower in your provider
config (e.g. `ANTHROPIC_TIMEOUT_MS`).

### `maxCostUsd`

USD ceiling. Checked via `CostGuard.isOverBudget()`. `0` = unlimited
(use with care).

### `parallelTools`

Max concurrent `parallelSafe` tool calls in one step. `write`/`edit`/
`bash` are not parallel-safe — they run serially regardless. Default 8.

## Trace output

Beyond cost, M7 ships `TraceLogger` for span-level observability.

```ts
const trace = new TraceLogger({
  sessionId,
  logger: pino(),
  sinkPath: process.env.YUANCODE_TRACE_FILE, // optional JSONL sink
  sampleRate: 1.0,                            // default 1.0
  maxSpans: 1000,                              // FIFO cap
})
```

Set the env var to flush spans to disk:

```bash
YUANCODE_TRACE_FILE=./trace.jsonl yuancode
```

After the session, the file has one JSON object per line:

```json
{"traceId":"…","spanId":"…","name":"loop.run","durationMs":12340,"status":"ok","attributes":{"sessionId":"…"}}
{"traceId":"…","parentSpanId":"…","name":"loop.llm","durationMs":1820,"status":"ok","attributes":{"step":3}}
{"traceId":"…","parentSpanId":"…","name":"tool.bash","durationMs":120,"status":"ok"}
```

Spans covered:

- `loop.run` — the whole session (root)
- `loop.llm` — each `provider.chat()` call
- `tool.<name>` — every tool invocation
- `gate.decide` — every `PermissionGate.decide()` call
- `mcp.callTool` — every MCP tool call

Sampling (`sampleRate`) lets you record a fraction of sessions in
production. `maxSpans` bounds memory — old spans are dropped FIFO.

## Quick reference

| Concern | Where to look | How to override |
|---|---|---|
| Session USD ceiling | `limits.maxCostUsd` | `config.yaml` |
| Per-model pricing | `pricing.<model>` | `config.yaml` |
| Step count | `limits.maxSteps` | `config.yaml` |
| Wall-clock per session | `limits.totalTimeoutMs` | `config.yaml` |
| Tool timeout | `ToolEntry.timeoutMs` (per tool) | `src/tools/*.ts` |
| Trace output | `YUANCODE_TRACE_FILE` env var | shell |
| Sample rate | `TraceLogger.sampleRate` (CLI option) | source / future flag |