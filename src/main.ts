#!/usr/bin/env node
/**
 * YuanCode CLI entry. Wires up `commander` and dispatches to sub-commands.
 *
 *   yuancode                Start the interactive TUI
 *   yuancode init           Run the first-time setup wizard
 *   yuancode doctor         Health-check the environment
 *   yuancode resume <id>    Resume a previous session
 *   yuancode --help         Show help
 */
import { Command } from 'commander'
import { loadConfig } from './config/loader.js'
import { getLogger } from './utils/logger.js'
import { loadEnv } from './utils/env.js'
import { runInitWizard } from './cli/init.js'
import { runDoctor } from './cli/doctor.js'
import { runTui } from './cli/run.js'
import { runResume } from './cli/resume.js'

// Load .env first so that the rest of the program sees YUANCODE_* vars.
loadEnv({ preserveExisting: true })

const program = new Command()

program
  .name('yuancode')
  .description('YuanCode — a nano Claude Code-like coding agent harness')
  .version('0.1.0')
  .option('--cwd <path>', 'Override current working directory')
  .option('-v, --verbose', 'Verbose logging (debug level)')
  .option('--log-level <level>', 'Override log level (trace|debug|info|warn|error|silent)')

program
  .command('init')
  .description('Run the first-time setup wizard (writes ~/.yuancode/config.yaml)')
  .option('--non-interactive', 'Skip prompts; write defaults')
  .option('--provider <name>', 'Provider id: minimax|anthropic|openai|custom')
  .option('--api-key <key>', 'API key (prefer --non-interactive in CI)')
  .option('--base-url <url>', 'Provider base URL')
  .option('--model <name>', 'Model name')
  .action(async (opts) => {
    const log = getLogger().child({ cmd: 'init' })
    try {
      await runInitWizard(opts)
    } catch (err) {
      log.error({ err }, 'init wizard failed')
      process.exitCode = 1
    }
  })

program
  .command('doctor')
  .description('Check the YuanCode environment for common issues')
  .action(async () => {
    const log = getLogger().child({ cmd: 'doctor' })
    try {
      const code = await runDoctor()
      process.exitCode = code
    } catch (err) {
      log.error({ err }, 'doctor failed')
      process.exitCode = 1
    }
  })

program
  .command('resume <sessionId>')
  .description('Resume a previously saved session')
  .action(async (sessionId: string) => {
    const log = getLogger().child({ cmd: 'resume' })
    try {
      await runResume(sessionId)
    } catch (err) {
      log.error({ err }, 'resume failed')
      process.exitCode = 1
    }
  })

// Default action: launch TUI.
program.action(async (opts) => {
  const log = getLogger().child({ cmd: 'tui' })
  try {
    if (opts.verbose) process.env.YUANCODE_LOG_LEVEL = 'debug'
    if (opts.logLevel) process.env.YUANCODE_LOG_LEVEL = opts.logLevel
    if (opts.cwd) process.chdir(opts.cwd)

    const config = loadConfig({ cwd: opts.cwd })
    log.info({ config }, 'loaded config')
    await runTui(config)
  } catch (err) {
    log.error({ err }, 'tui failed to start')
    process.exitCode = 1
  }
})

program.parseAsync(process.argv).catch((err) => {
  // Last-resort handler. Should not normally fire because each command
  // already catches its own errors.
  getLogger().error({ err }, 'unhandled CLI error')
  process.exit(1)
})
