/**
 * MCP client — public surface.
 */
export { McpManager } from './manager.js'
export type { McpManagerOptions, McpStartReport } from './manager.js'
export { McpServerConnection, McpUnavailableError } from './client.js'
export type { McpConnectionDeps } from './client.js'
export { makeMcpTool, jsonSchemaToZod } from './tool-factory.js'
export type { MakeMcpToolOptions, McpToolMeta } from './tool-factory.js'
export {
  McpStdioServerSchema,
  McpRemoteServerSchema,
  McpServerConfigSchema,
  McpServersFileSchema,
} from './types.js'
export type {
  McpStdioServer,
  McpRemoteServer,
  McpServerConfig,
  McpToolSpec,
  McpToolCallResult,
} from './types.js'
export { normalizeServerName, mcpToolName, parseMcpToolName } from './types.js'
export { loadMcpServersConfig } from './config-loader.js'
export type { LoadedMcpConfig, LoadMcpOptions } from './config-loader.js'
