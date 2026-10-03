/**
 * Zod schema for the full YuanCode config tree.
 *
 * Three scopes, merged in `loader.ts`:
 *   - defaults     (this file, hard-coded)
 *   - user         (~/.yuancode/config.yaml)
 *   - project      (<cwd>/.yuancode/config.yaml)
 *   - env          (process.env, takes precedence)
 */
import { z } from 'zod'

export const ProviderSchema = z.enum(['minimax', 'anthropic', 'openai', 'custom'])
export type Provider = z.infer<typeof ProviderSchema>

export const PermissionModeSchema = z.enum(['manual', 'acceptEdits', 'auto', 'plan'])
export type PermissionMode = z.infer<typeof PermissionModeSchema>

export const SandboxModeSchema = z.enum(['local', 'bubblewrap', 'docker', 'landlock'])
export type SandboxMode = z.infer<typeof SandboxModeSchema>

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent'])
export type LogLevel = z.infer<typeof LogLevelSchema>

export const ModelConfigSchema = z.object({
  provider: ProviderSchema,
  model: z.string().min(1),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  maxTokens: z.number().int().positive().default(8192),
  cacheControl: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(1.0),
})
export type ModelConfig = z.infer<typeof ModelConfigSchema>

export const LimitsConfigSchema = z.object({
  maxSteps: z.number().int().positive().default(50),
  totalTimeoutMs: z.number().int().positive().default(1_800_000),
  perStepTimeoutMs: z.number().int().positive().default(60_000),
  maxCostUsd: z.number().nonnegative().default(5.0),
  parallelTools: z.number().int().positive().max(32).default(8),
})
export type LimitsConfig = z.infer<typeof LimitsConfigSchema>

export const SandboxConfigSchema = z.object({
  mode: SandboxModeSchema.default('local'),
  image: z.string().default('yuancode/sandbox:latest'),
  extraWritable: z.array(z.string()).default([]),
  /** Docker network mode. Default 'none'. */
  network: z.enum(['none', 'host', 'bridge']).default('none'),
  /** Docker memory limit. Default '512m'. */
  memory: z.string().default('512m'),
  /** Docker CPU limit. Default 1. */
  cpus: z.number().positive().default(1),
})
export type SandboxConfig = z.infer<typeof SandboxConfigSchema>

/**
 * Per-model pricing in USD per 1k tokens. Users can override the built-in
 * default table (see CostGuard.DEFAULT_PRICING) by adding entries under
 * `pricing` in their config.yaml. Prices apply to `loop`, `subagent`, and
 * `background` sources.
 */
export const ModelPricingSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative().optional(),
  cacheWrite: z.number().nonnegative().optional(),
})
export type ModelPricing = z.infer<typeof ModelPricingSchema>

export const PricingTableSchema = z.record(z.string(), ModelPricingSchema)
export type PricingTable = z.infer<typeof PricingTableSchema>

export const McpStdioServerSchema = z.object({
  comment: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
})
export type McpStdioServer = z.infer<typeof McpStdioServerSchema>

export const McpRemoteServerSchema = z.object({
  comment: z.string().optional(),
  url: z.string().url(),
  headers: z.record(z.string()).default({}),
})
export type McpRemoteServer = z.infer<typeof McpRemoteServerSchema>

export const McpServersSchema = z.record(
  z.union([McpStdioServerSchema, McpRemoteServerSchema]),
)
export type McpServers = z.infer<typeof McpServersSchema>

export const YuanConfigSchema = z.object({
  model: ModelConfigSchema,
  permissionMode: PermissionModeSchema,
  limits: LimitsConfigSchema,
  sandbox: SandboxConfigSchema,
  logLevel: LogLevelSchema,
  mcpServers: McpServersSchema.optional(),
  /** Optional pricing overrides (per-model USD per 1k tokens). */
  pricing: PricingTableSchema.optional(),
})
export type YuanConfig = z.infer<typeof YuanConfigSchema>
