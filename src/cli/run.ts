/**
 * `yuancode` (default) — start the interactive TUI.
 *
 * Boots a full agent session:
 *   1. Load merged config (defaults → user yaml → project yaml → env)
 *   2. Build a Provider (MiniMax default)
 *   3. Build a LocalSandbox + ToolRegistry + StateMachine
 *   4. Wire PermissionGate (4 modes × risk)
 *   5. Load Yuan.md (3 layers) + Skills index → assemble system prompt
 *   6. M6: Load hooks.yaml + mcp.json, build HooksEngine + McpManager
 *   7. M6: Fire SessionStart hook
 *   8. M6: Connect MCP servers, register their tools into the registry
 *   9. Mount the Ink TUI
 *
 * Shutdown (finally):
 *   - Fire SessionEnd (5 s timeout — don't hang forever if a hook stalls)
 *   - Dispose MCP manager (5 s timeout — kill stdio children)
 *   - Dispose background task pool
 *
 * NOTE: the permission prompt UI (TUI panel) is not yet wired. `gate.onAsk`
 * defaults to denying — any tool the matrix says "ask" is denied and the
 * model is told to reformulate. Switch to `permissionMode: auto` to bypass.
 */
import { render } from 'ink'
import { createElement } from 'react'
import { randomUUID } from 'node:crypto'
import type { YuanConfig } from '../config/schema.js'
import { createProvider } from '../model/index.js'
import type { Provider } from '../model/provider.js'
import { createSandbox } from '../core/sandbox/index.js'
import type { SandboxRunner } from '../core/sandbox/runner.js'
import { ToolRegistry } from '../core/tool-registry.js'
import { TwoLevelAbort } from '../core/abort.js'
import { StateMachine } from '../core/state-machine.js'
import { PermissionGate } from '../core/permission-gate.js'
import { CheckpointManager } from '../core/checkpoint-manager.js'
import { TaskManager } from '../core/task-manager.js'
import { BackgroundTaskPool } from '../core/background-tasks.js'
import { registerDefaultTools } from '../tools/index.js'
import { loadYuanMd, loadSkillsIndex, buildSystemPrompt } from '../extensions/index.js'
import { App } from '../tui/app.js'
import { getLogger } from '../utils/logger.js'
import { hooksPaths, mcpPaths } from '../config/defaults.js'
import { HooksEngine, loadHooksConfig } from '../hooks/index.js'
import { McpManager, makeMcpTool, loadMcpServersConfig } from '../mcp/index.js'

const log = getLogger().child({ component: 'cli.run' })

export async function runTui(config: YuanConfig): Promise<void> {
  const cwd = process.cwd()

  // 1. Provider
  let provider: Provider
  try {
    provider = createProvider(config.model)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`\n✗ Failed to initialize provider: ${msg}\n`)
    process.stderr.write(`  Tip: run \`yuancode init\` or set YUANCODE_API_KEY.\n\n`)
    log.error({ err: msg }, 'provider init failed')
    process.exitCode = 1
    return
  }

  // 2. Sandbox
  let sandbox: SandboxRunner
  try {
    sandbox = createSandbox({
      mode: config.sandbox.mode,
      cwd,
      extraWritable: config.sandbox.extraWritable,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`\n✗ Failed to initialize sandbox: ${msg}\n\n`)
    log.error({ err: msg }, 'sandbox init failed')
    process.exitCode = 1
    return
  }

  // 3. Yuan.md (3 layers) + Skills index — used for the system prompt and
  //    to register the `skill` tool.
  const yuan = loadYuanMd(cwd)
  const skills = loadSkillsIndex(cwd)
  log.info(
    {
      yuan: {
        user: yuan.user !== null,
        project: yuan.project !== null,
        local: yuan.local !== null,
      },
      skills: skills.entries.length,
    },
    'extensions loaded',
  )

  // 4. Tool registry (M3: 10 tools — + skill when skills are present; M5: +7; M6: +mcp)
  const registry = new ToolRegistry()
  const checkpoints = new CheckpointManager({ maxSnapshots: 100 })

  // 6. Loop deps are built first (we need the sessionId for TaskManager).
  // The deps-builder lets the subagent tool read the same instance via
  // getAgentLoopDeps so it gets accurate subagentDepth.
  const sessionId = randomUUID()
  const sessionAbort = new TwoLevelAbort()

  // M6: HooksEngine + McpManager. Load configs FIRST (never throws), then
  // wire them through the rest of the boot. The hooks engine is constructed
  // before the loop deps so we can inject it into BackgroundTaskPool and
  // every other consumer that needs to fire lifecycle events.
  const hooksConfig = loadHooksConfig(hooksPaths(cwd))
  const hooksLogger = getLogger().child({ component: 'hooks' })
  const hooksEngine = new HooksEngine({
    sessionId,
    cwd,
    hardSignal: sessionAbort.hardSignal,
    logger: hooksLogger,
  })
  hooksEngine.load(hooksConfig.config)
  if (hooksConfig.warnings.length > 0) {
    log.warn({ warnings: hooksConfig.warnings }, 'hooks.yaml had issues')
  }

  // M5: TaskManager (DAG on disk) + BackgroundTaskPool (fire-and-forget).
  const taskManager = await TaskManager.load({ projectRoot: cwd, sessionId })
  const bgTaskPool = new BackgroundTaskPool({
    abort: sessionAbort,
    maxConcurrent: 4,
    hooksEngine,
  })

  // M6: MCP servers — load config, connect in parallel, register tools.
  const mcpConfig = loadMcpServersConfig(mcpPaths(cwd))
  const mcpLogger = getLogger().child({ component: 'mcp' })
  const mcpManager = new McpManager()
  const mcpStartReport = await mcpManager.start(mcpConfig.servers, {
    logger: mcpLogger,
    hardSignal: sessionAbort.hardSignal,
    onCrash: (serverName, err) => {
      log.warn({ server: serverName, err: err.message }, 'mcp server crashed')
    },
  })
  if (mcpStartReport.warnings.length > 0) {
    log.warn({ warnings: mcpStartReport.warnings }, 'mcp.json had issues')
  }
  if (mcpManager.size() > 0) {
    log.info(
      { live: mcpManager.liveCount(), crashed: mcpManager.crashedNames() },
      'mcp servers started',
    )
  }

  const depsRef: { current: ReturnType<typeof buildDeps> | null } = { current: null }

  function buildDeps() {
    return {
      provider,
      registry,
      abort: sessionAbort,
      state: new StateMachine(),
      limits: config.limits,
      cwd,
      sessionId,
      permissionMode: config.permissionMode,
      logger: getLogger().child({ component: 'loop' }),
      sandbox,
      gate: undefined as PermissionGate | undefined,
      bgTaskPool,
      subagentDepth: 0,
      hooksEngine,
      // onProgress is set by the TUI App component at render time so it
      // can update the spinner label + activity log in real-time. The
      // loop fires events regardless; this stays undefined for non-TUI
      // callers (tests, subagents run via `runSubagent`).
      onProgress: undefined,
    }
  }

  registerDefaultTools(registry, {
    cwd,
    sandbox,
    checkpoints,
    extraWritable: config.sandbox.extraWritable,
    skills,
    taskManager,
    bgTaskPool,
    getAgentLoopDeps: () => {
      const d = depsRef.current
      if (!d) throw new Error('Agent loop has not been initialized yet.')
      return d
    },
  })

  // 5. Permission gate — safe-by-default: deny on ask until the TUI panel lands.
  //    M6: pass hooksEngine so PreToolUse veto / approve kicks in here.
  const gate = new PermissionGate({
    mode: config.permissionMode,
    hooksEngine,
    onAsk: async (tool) => {
      log.warn({ tool: tool.name, risk: tool.risk }, 'permission ask → denying (no TUI panel yet)')
      return 'deny'
    },
  })

  // Wire hooks engine into the tool registry so execute() fires Pre/PostToolUse.
  registry.setHooksEngine(hooksEngine)

  // Register MCP tools (after default tools — names don't collide because
  // MCP names are prefixed `mcp__<server>__`).
  if (mcpManager.size() > 0) {
    const mcpTools = await mcpManager.listAllTools()
    for (const spec of mcpTools) {
      const tool = makeMcpTool({ spec, manager: mcpManager, logger: mcpLogger })
      try {
        registry.register(tool)
      } catch (err) {
        log.warn(
          { server: spec.serverName, tool: spec.name, err: (err as Error).message },
          'mcp tool registration failed',
        )
      }
    }
    log.info({ count: mcpTools.length }, 'mcp tools registered')
  }

  const deps = buildDeps()
  deps.gate = gate
  depsRef.current = deps

  // 7. System prompt — Yuan.md + Skills index layered on top of base identity.
  const system = buildSystemPrompt({ yuan, skills })

  // M6: SessionStart is informational — fire-and-forget so a slow hook
  // doesn't block the TUI from mounting.
  void hooksEngine
    .fire('SessionStart', {
      model: config.model.model,
      permissionMode: config.permissionMode,
      sessionId,
      cwd,
    })
    .catch((err: Error) => log.warn({ err: err.message }, 'SessionStart hook failed'))

  // 8. Render (use createElement so this file can stay .ts without JSX)
  const app = render(createElement(App, { deps, system, checkpointManager: checkpoints }))

  // 9. Clean shutdown on second Ctrl-C (hard abort)
  let signalCount = 0
  const onSig = (): void => {
    signalCount++
    if (signalCount === 1) {
      deps.abort.trigger('soft')
    } else if (signalCount >= 2) {
      deps.abort.trigger('hard')
      app.unmount()
      process.exit(130)
    }
  }
  process.on('SIGINT', onSig)

  try {
    await app.waitUntilExit()
  } finally {
    process.off('SIGINT', onSig)
    log.info({ session: deps.sessionId }, 'tui exited')

    // M6: parallel shutdown — fire SessionEnd, dispose MCP, dispose bg pool.
    // Each gets a 5s timeout so a stuck hook/child can't hang process exit.
    const timeout = (ms: number, p: Promise<unknown>): Promise<unknown> =>
      Promise.race([
        p,
        new Promise((resolve) => setTimeout(() => resolve('timeout'), ms)),
      ])

    await Promise.allSettled([
      timeout(5000, hooksEngine.fire('SessionEnd', {
        exitCode: process.exitCode ?? 0,
        reason: 'complete',
        sessionId,
        cwd,
      })),
      timeout(5000, mcpManager.dispose()),
      timeout(5000, Promise.resolve(bgTaskPool.dispose())),
    ])
  }
}
