#!/usr/bin/env node
/**
 * M6 smoke demo — exercise HooksEngine + McpManager + PermissionGate
 * three-stage pipeline end-to-end without an LLM.
 *
 * Verifies:
 *   1. HooksEngine: load hooks.yaml from disk, fire SessionStart,
 *      PreToolUse bash hooks (allow / deny / veto), PostToolUse.
 *   2. McpManager: spawn scripts/fixtures/mcp-echo-server.mjs as a stdio
 *      MCP server, list tools, call `echo` + `add`.
 *   3. PermissionGate × HooksEngine: hook veto overrides `auto` mode;
 *      hook pre-approve turns a `manual` ask into `allow`.
 *
 * Run with:  node scripts/m6-smoke.mjs
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Hand-rolled ANSI helpers — no chalk dep needed for a smoke.
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
}
const ok = (msg) => console.log(`${c.green}✓${c.reset} ${msg}`)
const fail = (msg) => {
  console.error(`${c.red}✗${c.reset} ${msg}`)
  process.exitCode = 1
}
const info = (msg) => console.log(`${c.dim}  ${msg}${c.reset}`)
const header = (msg) => console.log(`\n${c.bold}${c.yellow}▶ ${msg}${c.reset}`)

// Absolute path to the echo fixture, regardless of cwd.
const ECHO_SERVER = join(__dirname, 'fixtures', 'mcp-echo-server.mjs')

const noopLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  silent() {},
  child() {
    return this
  },
}

// helpers for the bash hooks — write small .mjs files so YAML stays simple.
function writeHookScript(dir, name, body) {
  const p = join(dir, `${name}.mjs`)
  writeFileSync(p, body + '\n')
  return p
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'yuancode-m6-'))
  info(`scratch dir: ${dir}`)

  // Pre-create the helper hook scripts once so they can be referenced
  // from both the YAML file and the inline engines below.
  const vetoScript = writeHookScript(
    dir,
    'hook-veto',
    'process.stderr.write("BLOCKED by hook\\n");process.exit(2)',
  )
  const allowScript = writeHookScript(dir, 'hook-allow', 'process.exit(0)')
  const approveScript = writeHookScript(
    dir,
    'hook-approve',
    "process.stdout.write(JSON.stringify({ decision: 'approve' }))",
  )

  // --------------------------------------------------------------
  // 1. HooksEngine: load hooks.yaml from disk, fire events
  // --------------------------------------------------------------
  header('HooksEngine: load + fire SessionStart / PreToolUse / PostToolUse')

  // Use a hooks.yaml that references the pre-created scripts — keeps
  // YAML clean (no in-line shell escaping required).
  const hooksPath = join(dir, 'hooks.yaml')
  writeFileSync(
    hooksPath,
    `hooks:
  PreToolUse:
    - matcher: bash
      type: bash
      command: node ${vetoScript}
    - matcher: read
      type: bash
      command: node ${allowScript}
  PostToolUse:
    - matcher: read
      type: bash
      command: node ${allowScript}
`,
  )
  info(`wrote ${hooksPath}`)

  const { loadHooksConfig } = await import('../dist/hooks/loader.js')
  const { HooksEngine } = await import('../dist/hooks/engine.js')
  const { TwoLevelAbort } = await import('../dist/core/abort.js')

  const abort = new TwoLevelAbort()
  const loaded = loadHooksConfig({
    userPath: join(dir, 'missing-user.yaml'),
    projectPath: hooksPath,
  })
  if (loaded.warnings.length > 0) {
    fail(`hooks loader had warnings: ${loaded.warnings.join('; ')}`)
  }
  const eventCount = Object.keys(loaded.config.hooks).length
  if (eventCount !== 2) {
    fail(`expected 2 hook events (PreToolUse, PostToolUse), got ${eventCount}`)
  } else {
    ok(`loaded ${eventCount} hook events from disk`)
  }

  const engine = new HooksEngine({
    sessionId: 'smoke-session',
    cwd: dir,
    hardSignal: abort.hardSignal,
    logger: noopLogger,
  })
  engine.load(loaded.config)
  ok('HooksEngine.load() accepted the config')

  // SessionStart (informational — no veto semantics).
  const sessionStart = await engine.fire('SessionStart', {
    model: 'MiniMax-M3',
    permissionMode: 'auto',
    sessionId: 'smoke-session',
    cwd: dir,
  })
  if (!sessionStart.allowed) {
    fail('SessionStart returned deny — should always be allowed')
  } else {
    ok('SessionStart fired (informational allow)')
  }

  // PreToolUse bash: veto (exit 2 → deny with stderr reason)
  const veto = await engine.fire('PreToolUse', {
    toolName: 'bash',
    toolInput: { command: 'rm -rf /' },
    sessionId: 'smoke-session',
    cwd: dir,
  })
  if (veto.allowed) {
    fail('PreToolUse should have denied bash via veto hook')
  } else if (!/BLOCKED by hook/.test(veto.reason ?? '')) {
    fail(`expected veto reason to contain "BLOCKED by hook", got: ${veto.reason}`)
  } else {
    ok(`PreToolUse denied bash via bash hook (reason: ${(veto.reason ?? '').trim()})`)
  }

  // PreToolUse bash: allow (exit 0)
  const allow = await engine.fire('PreToolUse', {
    toolName: 'read',
    toolInput: { path: 'foo.ts' },
    sessionId: 'smoke-session',
    cwd: dir,
  })
  if (!allow.allowed) fail(`PreToolUse should have allowed read, reason=${allow.reason}`)
  else ok('PreToolUse allowed read (exit 0 hook)')

  // PostToolUse: informational — always allow.
  const post = await engine.fire('PostToolUse', {
    toolName: 'read',
    toolInput: { path: 'foo.ts' },
    toolOutput: { content: 'ok', isError: false },
    durationMs: 5,
    sessionId: 'smoke-session',
    cwd: dir,
  })
  if (!post.allowed) fail('PostToolUse should always be allowed')
  else ok('PostToolUse fired and returned allowed=true (informational)')

  // PreToolUse matcher miss: no hook matches → still allowed.
  const miss = await engine.fire('PreToolUse', {
    toolName: 'grep',
    toolInput: { pattern: 'TODO' },
    sessionId: 'smoke-session',
    cwd: dir,
  })
  if (!miss.allowed) fail('PreToolUse with no matching hook should be allowed')
  else ok('PreToolUse with no matching hook allowed (no veto)')

  // --------------------------------------------------------------
  // 2. McpManager: spawn echo server, list + call tools
  // --------------------------------------------------------------
  header('McpManager: stdio connection to fixtures/mcp-echo-server.mjs')

  const { McpManager, makeMcpTool } = await import('../dist/mcp/index.js')

  const mcp = new McpManager()
  const startReport = await mcp.start(
    {
      'echo-server': {
        type: 'stdio',
        command: process.execPath, // node — runs the .mjs
        args: [ECHO_SERVER],
      },
    },
    {
      logger: noopLogger,
      hardSignal: abort.hardSignal,
      onCrash: (name, err) => info(`[crash] ${name}: ${err.message}`),
    },
  )
  if (startReport.warnings.length > 0) {
    fail(`MCP start had warnings: ${startReport.warnings.join('; ')}`)
  }
  if (mcp.size() !== 1) fail(`expected 1 MCP connection, got ${mcp.size()}`)
  else ok(`1 MCP server connected: ${mcp.liveCount()} live, ${mcp.crashedNames().length} crashed`)

  const specs = await mcp.listAllTools()
  if (specs.length !== 2) fail(`expected 2 MCP tools, got ${specs.length}`)
  else {
    ok(
      `listAllTools returned ${specs.length} tools: ${specs.map((s) => `mcp__echo_server__${s.name}`).join(', ')}`,
    )
  }

  const ctx = {
    cwd: dir,
    sandbox: undefined,
    abort,
    sessionId: 'smoke-session',
    permissionMode: 'auto',
    logger: noopLogger,
  }

  // Call `echo` — the tool-factory prepends `[<fullName>]` and appends text.
  const echoSpec = specs.find((s) => s.name === 'echo')
  const echoTool = makeMcpTool({ spec: echoSpec, manager: mcp, logger: noopLogger })
  const echoOut = await echoTool.handler({ message: 'hello' }, ctx)
  if (echoOut.isError) fail(`echo returned isError: ${echoOut.content}`)
  else if (!/echoed: hello/.test(echoOut.content)) {
    fail(`echo content unexpected: ${echoOut.content}`)
  } else {
    ok(`mcp__echo_server__echo → ${JSON.stringify(echoOut.content)}`)
  }

  // Call `add`.
  const addSpec = specs.find((s) => s.name === 'add')
  const addTool = makeMcpTool({ spec: addSpec, manager: mcp, logger: noopLogger })
  const addOut = await addTool.handler({ a: 2, b: 40 }, ctx)
  if (addOut.isError) fail(`add returned isError: ${addOut.content}`)
  else if (!/^42$/.test(addOut.content.split('\n').pop() ?? '')) {
    fail(
      `add expected trailing "42" after banner, got: ${JSON.stringify(addOut.content)}`,
    )
  } else {
    ok(`mcp__echo_server__add(2, 40) → ${JSON.stringify(addOut.content)}`)
  }

  // Normalized-name format check (server name lowercased to [a-z0-9_]+).
  if (echoSpec.serverName !== 'echo_server') {
    fail(`normalized server name expected "echo_server", got "${echoSpec.serverName}"`)
  } else {
    ok(`server name normalized: "${echoSpec.serverName}" (originalServerName="${echoSpec.originalServerName}")`)
  }

  await mcp.dispose()
  ok('McpManager.dispose() closed stdio child')

  // --------------------------------------------------------------
  // 3. PermissionGate × HooksEngine: hook veto + hook pre-approve
  // --------------------------------------------------------------
  header('PermissionGate: hook veto + hook pre-approve')

  const { PermissionGate } = await import('../dist/core/permission-gate.js')

  const fakeTool = {
    name: 'bash',
    description: 'shell',
    risk: 'high',
    category: 'shell',
    parallelSafe: false,
    timeoutMs: 60_000,
  }

  // 3a. mode=auto → normally allow. With a hook vetoing, deny.
  const vetoEngine = new HooksEngine({
    sessionId: 'smoke-session',
    cwd: dir,
    hardSignal: abort.hardSignal,
    logger: noopLogger,
  })
  vetoEngine.load({
    hooks: {
      PreToolUse: [
        {
          matcher: 'bash',
          type: 'bash',
          command: `node ${vetoScript}`,
        },
      ],
    },
  })

  const gate1 = new PermissionGate({
    mode: 'auto',
    hooksEngine: vetoEngine,
    onAsk: async () => 'allow',
  })
  const dec1 = await gate1.decide(fakeTool, { command: 'ls' })
  if (dec1.action !== 'deny') {
    fail(`expected deny from hook veto, got ${dec1.action}`)
  } else if (!/BLOCKED by hook/i.test(dec1.reason ?? '')) {
    fail(`deny reason should mention hook/stderr, got: ${dec1.reason}`)
  } else {
    ok(`mode=auto + hook veto → deny (reason: ${(dec1.reason ?? '').trim()})`)
  }

  // 3b. mode=manual (would ask) + hook pre-approves → allow.
  const approveEngine = new HooksEngine({
    sessionId: 'smoke-session',
    cwd: dir,
    hardSignal: abort.hardSignal,
    logger: noopLogger,
  })
  approveEngine.load({
    hooks: {
      PreToolUse: [
        {
          matcher: 'bash',
          type: 'bash',
          command: `node ${approveScript}`,
        },
      ],
    },
  })

  let askCalled = false
  const gate2 = new PermissionGate({
    mode: 'manual',
    hooksEngine: approveEngine,
    onAsk: async () => {
      askCalled = true
      return 'allow'
    },
  })
  const dec2 = await gate2.decide(fakeTool, { command: 'ls' })
  if (dec2.action !== 'allow') {
    fail(`expected allow from hook pre-approve, got ${dec2.action}`)
  } else if (askCalled) {
    fail('onAsk should NOT have been called when hook pre-approved')
  } else {
    ok('mode=manual + hook approve → allow (onAsk skipped)')
  }

  // 3c. Without hooksEngine, behavior matches M5 (mode=manual high-risk → ask).
  let askCalled3 = false
  const gate3 = new PermissionGate({
    mode: 'manual',
    onAsk: async () => {
      askCalled3 = true
      return 'allow'
    },
  })
  const dec3 = await gate3.decide(fakeTool, { command: 'ls' })
  if (dec3.action !== 'allow' || !askCalled3) {
    fail(`expected ask path → allow, got ${dec3.action} (askCalled=${askCalled3})`)
  } else {
    ok('mode=manual + no hooks → falls back to onAsk (M5 parity)')
  }

  // 3d. Empty hook config + auto mode → still allow (no veto, mode wins).
  const emptyEngine = new HooksEngine({
    sessionId: 'smoke-session',
    cwd: dir,
    hardSignal: abort.hardSignal,
    logger: noopLogger,
  })
  emptyEngine.load({ hooks: {} })
  const gate4 = new PermissionGate({
    mode: 'auto',
    hooksEngine: emptyEngine,
    onAsk: async () => 'allow',
  })
  const dec4 = await gate4.decide(fakeTool, { command: 'ls' })
  if (dec4.action !== 'allow') {
    fail(`empty hook config + auto should allow, got ${dec4.action}`)
  } else {
    ok('empty hook config + auto → allow (mode wins, no veto)')
  }

  // 3e. Hook that crashes (non-existent script) → fail-closed deny.
  const crashEngine = new HooksEngine({
    sessionId: 'smoke-session',
    cwd: dir,
    hardSignal: abort.hardSignal,
    logger: noopLogger,
  })
  crashEngine.load({
    hooks: {
      PreToolUse: [
        {
          matcher: 'bash',
          type: 'bash',
          command: `node ${join(dir, 'does-not-exist.mjs')}`,
          timeoutMs: 2_000,
        },
      ],
    },
  })
  const gate5 = new PermissionGate({
    mode: 'auto',
    hooksEngine: crashEngine,
    onAsk: async () => 'allow',
  })
  const t0 = performance.now()
  const dec5 = await gate5.decide(fakeTool, { command: 'ls' })
  const elapsed = performance.now() - t0
  if (dec5.action !== 'deny') {
    fail(`hook spawn failure + auto should deny (fail-closed), got ${dec5.action}`)
  } else if (elapsed > 10_000) {
    fail(`fail-closed took ${elapsed.toFixed(0)}ms — exceeded 10s budget`)
  } else {
    ok(`hook spawn failure → fail-closed deny (${elapsed.toFixed(0)}ms)`)
  }

  // --------------------------------------------------------------
  // Wrap-up
  // --------------------------------------------------------------
  header('Cleanup')
  if (process.exitCode === 1) {
    fail('one or more checks failed')
  } else {
    ok('all M6 smoke checks passed')
  }

  if (existsSync(hooksPath)) info(`hooks.yaml artifact: ${hooksPath}`)

  rmSync(dir, { recursive: true, force: true })
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})