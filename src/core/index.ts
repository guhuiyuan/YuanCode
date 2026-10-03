/**
 * Core layer barrel.
 */
export { Phase, StateMachine } from './state-machine.js'
export type { Phase as PhaseType } from './state-machine.js'
export { TwoLevelAbort } from './abort.js'
export type { AbortLevel, AbortEvent } from './abort.js'
export { ToolRegistry, TimeoutError } from './tool-registry.js'
export type {
  ToolEntry,
  ToolContext,
  ToolResult,
  ToolCategory,
  Risk,
} from './tool-registry.js'
export { zodToJsonSchema } from './zod-to-json.js'
export type { JsonSchema } from './zod-to-json.js'
export { runAgentLoop } from './loop.js'
export type { AgentLoopDeps, AgentLoopOptions, AgentLoopResult } from './loop.js'
export { PermissionGate, decideByMode } from './permission-gate.js'
export type {
  PermissionAction,
  PermissionDecision,
  PermissionGateDeps,
  PermissionRule,
} from './permission-gate.js'
export { CheckpointManager } from './checkpoint-manager.js'
export type { CheckpointSnapshot } from './checkpoint-manager.js'
export { createSandbox } from './sandbox/index.js'
export type { SandboxRunner, SandboxRunOptions, SandboxRunResult } from './sandbox/runner.js'
export { LocalSandbox } from './sandbox/local.js'
export { PathGuard, SandboxPathError } from './sandbox/path-guard.js'
export type { PathDecision } from './sandbox/path-guard.js'
