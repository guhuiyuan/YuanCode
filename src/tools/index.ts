/**
 * Default tool registry — registers every built-in tool in one call.
 *
 * Tools returned:
 *   - bash              (shell, high risk, M1)
 *   - read              (file, low risk)
 *   - write             (file, high risk)
 *   - edit              (file, high risk)
 *   - ls                (file, low risk)
 *   - grep              (search, low risk)
 *   - glob              (search, low risk)
 *   - webfetch          (search, medium risk)
 *   - todowrite         (plan, low risk)
 *   - skill             (knowledge, low risk, M3 — requires `skills` index)
 *   - subagent          (agent, medium risk, M5)
 *   - task_create       (agent, low risk, M5)
 *   - task_list         (agent, low risk, M5)
 *   - task_update       (agent, low risk, M5)
 *   - task_get          (agent, low risk, M5)
 *   - background_start  (agent, medium risk, M5)
 *   - background_check  (agent, low risk, M5)
 *
 * Permission gating and the checkpoint manager are wired in by the loop;
 * this module just registers the tool instances.
 */
import type { ToolRegistry } from '../core/tool-registry.js'
import type { SandboxRunner } from '../core/sandbox/runner.js'
import type { CheckpointManager } from '../core/checkpoint-manager.js'
import type { SkillIndex } from '../extensions/skills.js'
import type { TaskManager } from '../core/task-manager.js'
import type { BackgroundTaskPool } from '../core/background-tasks.js'
import type { AgentLoopDeps } from '../core/loop.js'
import { makeBashTool } from './bash.js'
import { makeReadTool } from './read.js'
import { makeWriteTool } from './write.js'
import { makeEditTool } from './edit.js'
import { makeLsTool } from './ls.js'
import { makeGrepTool } from './grep.js'
import { makeGlobTool } from './glob.js'
import { makeWebfetchTool } from './webfetch.js'
import { makeTodowriteTool, makeTodoStore, type TodoStore } from './todowrite.js'
import { makeSkillTool } from './skill.js'
import { makeSubagentTool } from './subagent.js'
import {
  makeTaskCreateTool,
  makeTaskListTool,
  makeTaskUpdateTool,
  makeTaskGetTool,
} from './task.js'
import { makeBackgroundStartTool, makeBackgroundCheckTool } from './background.js'

export interface RegisterDefaultToolsOptions {
  cwd: string
  sandbox: SandboxRunner
  checkpoints: CheckpointManager
  /** Extra writable roots (passed to file tools). */
  extraWritable?: string[]
  /** Optional skill index — when provided, the `skill` tool is registered. */
  skills?: SkillIndex
  /** Optional task manager — registers the four task_* tools. */
  taskManager?: TaskManager
  /** Optional background pool — registers background_* tools. */
  bgTaskPool?: BackgroundTaskPool
  /**
   * Function that returns the current AgentLoopDeps. Required for the
   * `subagent` tool (it needs to spawn a child loop with the parent's
   * provider/registry/sandbox). The indirection lets the tool read fresh
   * deps (so subagentDepth is correct per call).
   */
  getAgentLoopDeps?: () => AgentLoopDeps
}

export interface RegisteredTools {
  todoStore: TodoStore
  /** Echoed back when provided so the CLI can hand them to the loop / TUI. */
  taskManager?: TaskManager
  bgTaskPool?: BackgroundTaskPool
}

export function registerDefaultTools(
  registry: ToolRegistry,
  opts: RegisterDefaultToolsOptions,
): RegisteredTools {
  // Bash needs a real sandbox with .run().
  if (opts.sandbox.mode !== 'local') {
    throw new Error(
      `registerDefaultTools: only local sandbox is supported in M2 (got ${opts.sandbox.mode})`,
    )
  }
  // The grep tool's sandbox arg is typed as LocalSandbox but only uses .pathGuard
  // indirectly through its handler. Cast is safe because registerDefaultTools
  // rejects non-local above.
  const localSandbox = opts.sandbox as unknown as import('../core/sandbox/local.js').LocalSandbox

  registry.register(makeBashTool(opts.sandbox))
  registry.register(makeReadTool({ cwd: opts.cwd, extraWritable: opts.extraWritable }))
  registry.register(makeWriteTool({
    cwd: opts.cwd,
    extraWritable: opts.extraWritable,
    checkpoints: opts.checkpoints,
  }))
  registry.register(makeEditTool({
    cwd: opts.cwd,
    extraWritable: opts.extraWritable,
    checkpoints: opts.checkpoints,
  }))
  registry.register(makeLsTool({ cwd: opts.cwd, extraWritable: opts.extraWritable }))
  registry.register(makeGrepTool({ cwd: opts.cwd, sandbox: localSandbox }))
  registry.register(makeGlobTool({ cwd: opts.cwd }))
  registry.register(makeWebfetchTool())

  const todoStore = makeTodoStore()
  registry.register(makeTodowriteTool({ store: todoStore }))

  if (opts.skills && opts.skills.entries.length > 0) {
    registry.register(makeSkillTool({ index: opts.skills }))
  }

  // M5 — TaskManager CRUD
  if (opts.taskManager) {
    registry.register(makeTaskCreateTool({ manager: opts.taskManager }))
    registry.register(makeTaskListTool({ manager: opts.taskManager }))
    registry.register(makeTaskUpdateTool({ manager: opts.taskManager }))
    registry.register(makeTaskGetTool({ manager: opts.taskManager }))
  }

  // M5 — Background pool
  if (opts.bgTaskPool) {
    registry.register(makeBackgroundStartTool({ pool: opts.bgTaskPool, registry }))
    registry.register(makeBackgroundCheckTool({ pool: opts.bgTaskPool }))
  }

  // M5 — Subagent. Requires getAgentLoopDeps to bridge from ToolContext
  // (which is per-call) to AgentLoopDeps (which carries provider/registry
  // + the subagentDepth we need to enforce recursion limits).
  if (opts.getAgentLoopDeps) {
    registry.register(makeSubagentTool({ getParentDeps: opts.getAgentLoopDeps }))
  }

  return {
    todoStore,
    taskManager: opts.taskManager,
    bgTaskPool: opts.bgTaskPool,
  }
}