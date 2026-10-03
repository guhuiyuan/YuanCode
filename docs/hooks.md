---
title: Hooks
description: 11 lifecycle events, bash / http hook types, decision semantics.
milestone: M6
audience: contributors, integrators
---

# Hooks

Hooks let you run user-defined scripts at well-defined points in the
agent lifecycle — for auditing, blocking, logging, or notifying external
systems. Configure them in `~/.yuancode/hooks.yaml` and/or
`<project>/.yuancode/hooks.yaml`. Project-level wins on conflict;
event arrays merge.

## Configuration

```yaml
# ~/.yuancode/hooks.yaml
PreToolUse:
  - matcher: 'bash'
    type: bash
    command: ./scripts/audit-bash.sh
    timeoutMs: 5000

PostToolUse:
  - matcher: '^mcp__filesystem__'
    type: http
    url: 'https://hooks.example.com/audit'
    method: POST
    headers:
      Authorization: 'Bearer ${AUDIT_TOKEN}'
```

Each event fires every matching entry. Entries are matched against the
tool name (or `subagentType`, `taskId`, etc — see below) using either
exact string, regex literal `/pattern/`, or prefix regex.

## Events

The harness fires these events at well-defined places:

| Event | Gating? | Payload |
|---|---|---|
| `SessionStart` | no | `{ sessionId, cwd, permissionMode, model }` |
| `SessionEnd` | no | `{ sessionId, durationMs, totalCostUsd, stopReason }` |
| `UserPromptSubmit` | yes | `{ sessionId, cwd, prompt }` |
| `PreToolUse` | yes | `{ toolName, toolInput, sessionId, cwd }` |
| `PostToolUse` | no | `{ toolName, toolInput, toolOutput, toolError, durationMs, sessionId, cwd }` |
| `PreCompact` | yes | `{ sessionId, trigger: 'auto' \| 'manual', tokenCount, threshold }` |
| `PostCompact` | no | `{ sessionId, beforeTokens, afterTokens, strategy }` |
| `PreCheckpoint` | no | `{ sessionId, cwd, files: string[] }` |
| `PostCheckpoint` | no | `{ sessionId, checkpointId, files }` |
| `SubagentStart` | yes | `{ sessionId, subagentType, subagentId, task }` |
| `SubagentEnd` | no | `{ sessionId, subagentType, subagentId, status, result }` |
| `Notification` | no | `{ sessionId, source, message }` |

**Gating events** can deny an action. Non-gating events are informational
only — they fire and log but never block.

## Hook types

### `bash` — local script

```yaml
PreToolUse:
  - matcher: 'bash'
    type: bash
    command: ./scripts/audit-bash.sh
    timeoutMs: 5000
    env:
      EXTRA: 'foo'
```

YuanCode runs the script in a `LightSandbox` (a stripped-down
`LocalSandbox` — no forbidden-path scan since the user explicitly
authorized the script). Stdin receives the payload as JSON; stdout and
stderr are captured.

Environment variables provided to the script:

- `YUAN_TOOL_NAME` — for PreToolUse / PostToolUse
- `YUAN_TOOL_INPUT_JSON` — base64-encoded JSON of the tool input
- `YUAN_SESSION_ID` — current session
- `YUAN_EVENT` — the event name (`PreToolUse` etc)

### `http` — webhook

```yaml
PostToolUse:
  - matcher: '^bash$'
    type: http
    url: 'https://hooks.example.com/audit'
    method: POST
    headers:
      Authorization: 'Bearer ${AUDIT_TOKEN}'
    timeoutMs: 3000
```

The payload is POSTed as JSON. Response body and status are captured.
2xx → allow; non-2xx → deny.

## Decision semantics

A gating event returns either allow or deny:

- **bash hook** — exit code 0 → allow; non-zero → deny (stderr is the
  reason, capped at 500 chars)
- **bash hook with structured output** — exit 0 + stdout containing
  `{"decision":"approve"}` → pre-approve an `ask` decision (the
  PermissionGate promotes the ask to allow without UI)
- **bash hook with structured deny** — exit 0 + stdout containing
  `{"decision":"deny","reason":"…"}` → explicit deny
- **http hook** — 2xx → allow; 3xx/4xx/5xx → deny

**Fail-closed:** any uncaught exception in a hook is treated as a deny.
This means a buggy hook never accidentally lets a dangerous tool through.

## Cycle detection

A `HookCycleDetector` (depth limit 5) prevents a hook from recursively
triggering itself. If a bash hook calls a tool that fires `PreToolUse`
and that hook tries to invoke the same hook script, the depth counter
increments and the inner call is short-circuited.

## Matcher syntax

Three forms, evaluated in order:

1. Exact string: `matcher: 'bash'` → only fires for `tool.name === 'bash'`
2. Regex literal (between `/`): `matcher: '/^mcp__/'` → compiled to RegExp
3. Anything else → also compiled as a RegExp (e.g. `matcher: 'mcp__.*'`)

Bad regex → error at config-load time.

## Examples

### Block writes to `/etc`

```yaml
PreToolUse:
  - matcher: 'edit|write'
    type: bash
    command: |
      if echo "$YUAN_TOOL_INPUT_JSON" | grep -q '/etc/'; then
        echo '{"decision":"deny","reason":"writes to /etc blocked"}' >&2
        exit 1
      fi
      exit 0
```

### Notify on long-running tool

```yaml
PostToolUse:
  - matcher: '.*'
    type: http
    url: 'https://ntfy.sh/my-yuancode'
    method: POST
    timeoutMs: 2000
    headers:
      Title: 'yuancode tool finished'
```

The ntfy body is the PostToolUse payload.

## Limits

- Per-hook timeout: configurable via `timeoutMs` (default 60s for bash, 30s for http)
- Output cap: 1 MiB per stream
- Cycle depth: 5
- All hooks for an event run **concurrently** — no ordering guarantees