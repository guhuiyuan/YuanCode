/**
 * Bash tool — the only tool that M1 ships with.
 *
 * Routes every command through the configured sandbox runner so:
 *   - cwd is forced to project root
 *   - sensitive env vars are stripped
 *   - commands referencing ~/.ssh, ~/.aws, etc. are refused pre-spawn
 *   - output is capped (default 1 MiB / stream)
 *   - the hard-abort signal can kill the process tree
 *
 * The shell command string is the API surface — kept intentionally simple.
 * More granular tools (read_file, list_dir, …) will live alongside bash in
 * M2 but M1 only needs this one to prove the loop.
 */
import { z } from 'zod'
import type { ToolEntry, ToolContext } from '../core/tool-registry.js'
import type { SandboxRunner } from '../core/sandbox/runner.js'
import { DEFAULT_TIMEOUT_MS } from '../core/sandbox/runner.js'

export const BashInputSchema = z.object({
  command: z.string().min(1).describe(
    'Shell command to execute. Runs in the sandbox with cwd forced to project root. ' +
      'Available on Windows (cmd.exe via git-bash) and POSIX (sh).',
  ),
  timeoutMs: z.number().int().positive().max(600_000).optional().describe(
    `Hard timeout in ms. Default ${DEFAULT_TIMEOUT_MS} (60s). Max 10 min.`,
  ),
  /** Description of intent — surfaced in audit logs and permission prompts. */
  reason: z.string().max(200).optional().describe(
    'One-sentence explanation of why this command is being run. ' +
      'Shown in permission prompts and audit logs.',
  ),
})

export type BashInput = z.infer<typeof BashInputSchema>

export function makeBashTool(sandbox: SandboxRunner): ToolEntry<typeof BashInputSchema> {
  return {
    name: 'bash',
    description:
      'Execute a shell command in the project sandbox. Returns stdout, stderr, ' +
      'and exit code. Use for: running tests, git, build commands, package ' +
      'scripts, or anything that needs a shell. For reading files prefer the ' +
      '`read` tool (M2).',
    schema: BashInputSchema,
    risk: 'high',
    parallelSafe: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    category: 'shell',
    handler: async (input: BashInput, ctx: ToolContext) => {
      const result = await sandbox.run(input.command, {
        timeoutMs: input.timeoutMs,
        signal: ctx.abort.hardSignal,
      })
      return {
        content: formatBashResult(result),
        metadata: {
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
          aborted: result.aborted,
          truncated: result.truncated,
        },
      }
    },
  }
}

/**
 * Format a sandbox result for the model.
 *
 * Strategy: include stdout + stderr + exit code as plain text. If output was
 * truncated, surface that explicitly. If the command timed out or was aborted,
 * surface that too — the model needs to know to try a different approach.
 */
function formatBashResult(r: {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: { stdout: boolean; stderr: boolean }
  durationMs: number
  timedOut: boolean
  aborted: boolean
}): string {
  const parts: string[] = []

  parts.push(`<bash_result command=${shellQuote(r.command)}>`)

  if (r.timedOut) {
    parts.push(`<status>timed out after ${r.durationMs}ms</status>`)
  } else if (r.aborted) {
    parts.push('<status>aborted by user</status>')
  } else {
    parts.push(`<exit_code>${r.exitCode === null ? 'null' : r.exitCode}</exit_code>`)
  }

  parts.push(`<duration_ms>${r.durationMs}</duration_ms>`)

  if (r.stdout) {
    parts.push('<stdout>')
    parts.push(r.stdout)
    if (r.truncated.stdout) parts.push('\n…(stdout truncated)')
    parts.push('</stdout>')
  } else {
    parts.push('<stdout></stdout>')
  }

  if (r.stderr) {
    parts.push('<stderr>')
    parts.push(r.stderr)
    if (r.truncated.stderr) parts.push('\n…(stderr truncated)')
    parts.push('</stderr>')
  } else {
    parts.push('<stderr></stderr>')
  }

  parts.push('</bash_result>')
  return parts.join('\n')
}

function shellQuote(s: string): string {
  // Minimal single-quote escape for the <bash_result command="…"> tag.
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
