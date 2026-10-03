/**
 * Hooks engine — public surface.
 */
export { HooksEngine } from './engine.js'
export type { HooksEngineDeps, FirePayload } from './engine.js'
export { loadHooksConfig } from './loader.js'
export type { LoadHooksOptions, LoadedHooks } from './loader.js'
export { compileMatcher } from './matcher.js'
export type { CompiledMatcher } from './matcher.js'
export { HookCycleDetector } from './cycle-detector.js'
export { GATING_EVENTS } from './types.js'
export type {
  BashHookEntry,
  HookDecision,
  HookEntry,
  HookEvent,
  HookOutcome,
  HookPayload,
  HookResult,
  HooksConfig,
  HttpHookEntry,
  NotificationPayload,
  PostCompactPayload,
  PostToolUsePayload,
  PreCompactPayload,
  PreToolUsePayload,
  SessionEndPayload,
  SessionStartPayload,
  SubagentEndPayload,
  SubagentStartPayload,
  UserPromptSubmitPayload,
} from './types.js'
// Internal runners are exported for tests only.
export { executeBashHook, executeHttpHook } from './executor.js'
export { runLightSandbox } from './light-sandbox.js'
export type { LightSandboxOptions, LightSandboxResult } from './light-sandbox.js'
