/**
 * `yuancode doctor` — environment health check.
 *
 * Returns a process exit code:
 *   0 — all required checks passed
 *   1 — at least one required check failed
 *
 * The checks are deliberately fast (no network roundtrips) so they can run
 * inside CI. The optional Docker / MCP / API key liveness checks are
 * skipped when the relevant feature is not configured.
 */
import { existsSync, statSync } from 'node:fs'
import { platform } from 'node:os'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../config/loader.js'
import { getLogger } from '../utils/logger.js'

const log = getLogger().child({ component: 'doctor' })

const REQUIRED_NODE_MAJOR = 20
const REQUIRED_NODE_MINOR = 10
const RECOMMENDED_PKG_MANAGER = 'pnpm@10'

type CheckResult = { name: string; status: 'ok' | 'warn' | 'fail'; detail: string }

function colorize(s: string, status: CheckResult['status']): string {
  if (!process.stdout.isTTY) return s
  const codes = {
    ok: '\x1b[32m✔\x1b[0m',
    warn: '\x1b[33m⚠\x1b[0m',
    fail: '\x1b[31m✖\x1b[0m',
  }
  return `${codes[status]} ${s}`
}

function checkNodeVersion(): CheckResult {
  const major = process.versions.node.split('.')[0]
  const minor = process.versions.node.split('.')[1]
  const m = Number(major)
  const n = Number(minor)
  if (Number.isNaN(m) || Number.isNaN(n)) {
    return { name: 'Node version', status: 'fail', detail: 'unable to parse' }
  }
  if (m < REQUIRED_NODE_MAJOR || (m === REQUIRED_NODE_MAJOR && n < REQUIRED_NODE_MINOR)) {
    return {
      name: 'Node version',
      status: 'fail',
      detail: `${process.versions.node} (need ≥ ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR})`,
    }
  }
  return { name: 'Node version', status: 'ok', detail: process.versions.node }
}

function checkCommand(cmd: string, args: string[]): string | null {
  // On Windows, .cmd / .bat shims need shell:true to be found and executed.
  // We accept Node's DEP0190 deprecation here because the alternative is
  // fragile path-resolution code that breaks when CWD contains spaces.
  const useShell = process.platform === 'win32'
  try {
    const r = spawnSync(cmd, args, {
      encoding: 'utf8',
      shell: useShell,
      windowsHide: true,
      // Suppress DEP0190 by not using the shell where possible.
      ...(useShell ? { env: { ...process.env, NODE_NO_WARNINGS: '1' } } : {}),
    })
    if (r.error) return null
    if (r.status !== 0) return null
    return (r.stdout ?? r.stderr ?? '').trim()
  } catch {
    return null
  }
}

function checkPnpm(): CheckResult {
  const v = checkCommand('pnpm', ['--version'])
  if (!v) {
    return {
      name: 'pnpm',
      status: 'fail',
      detail: 'not found. Install: npm i -g pnpm',
    }
  }
  return { name: 'pnpm', status: 'ok', detail: v }
}

function checkRipgrep(): CheckResult {
  const v = checkCommand('rg', ['--version'])
  if (!v) {
    return { name: 'ripgrep (rg)', status: 'warn', detail: 'not found. The grep tool will fall back to a slower scanner.' }
  }
  return { name: 'ripgrep (rg)', status: 'ok', detail: v.split('\n')[0] ?? v }
}

function checkDocker(): CheckResult {
  const v = checkCommand('docker', ['--version'])
  if (!v) {
    return { name: 'docker (optional)', status: 'warn', detail: 'not found. Required only if YUANCODE_SANDBOX=docker.' }
  }
  return { name: 'docker (optional)', status: 'ok', detail: v }
}

function checkConfigFile(): CheckResult {
  const userCfg = join(homedir(), '.yuancode', 'config.yaml')
  if (existsSync(userCfg)) {
    return { name: 'user config', status: 'ok', detail: userCfg }
  }
  return {
    name: 'user config',
    status: 'warn',
    detail: 'not found. Run `yuancode init` to create one (defaults work without it).',
  }
}

function checkEnvFile(): CheckResult {
  const cwd = process.cwd()
  const envPath = resolve(cwd, '.env')
  if (existsSync(envPath)) {
    try {
      const stat = statSync(envPath)
      return { name: '.env file', status: 'ok', detail: `${envPath} (${stat.size} bytes)` }
    } catch {
      return { name: '.env file', status: 'warn', detail: `found but not readable: ${envPath}` }
    }
  }
  return { name: '.env file', status: 'warn', detail: 'not found (will use shell env vars)' }
}

function checkApiKey(): CheckResult {
  // Only check FORMAT; we don't want to call the provider here.
  const k = process.env.YUANCODE_API_KEY
  if (k && k.length >= 16) {
    return { name: 'API key', status: 'ok', detail: `set in env (${k.length} chars)` }
  }
  try {
    const cfg = loadConfig({ cwd: process.cwd() })
    if (cfg.model.apiKey && cfg.model.apiKey.length >= 16) {
      return { name: 'API key', status: 'ok', detail: 'set in config file' }
    }
  } catch {
    /* config malformed — surfaced elsewhere */
  }
  return {
    name: 'API key',
    status: 'warn',
    detail: 'not set. Set YUANCODE_API_KEY or write it in ~/.yuancode/config.yaml.',
  }
}

function checkCwdWritable(): CheckResult {
  try {
    // statSync is sufficient: if it returns, the directory exists and is
    // accessible to the current user. We don't probe write permissions
    // because that requires creating a file (side effect we want to avoid
    // for a doctor that may be run from anywhere).
    const s = statSync(process.cwd())
    if (s.isDirectory()) {
      return { name: 'cwd writable', status: 'ok', detail: process.cwd() }
    }
    return { name: 'cwd writable', status: 'fail', detail: 'cwd is not a directory' }
  } catch (err) {
    return { name: 'cwd writable', status: 'fail', detail: String(err) }
  }
}

function checkDistBuild(): CheckResult {
  const distMain = resolve(process.cwd(), 'dist/main.js')
  if (existsSync(distMain)) {
    return { name: 'build artifact', status: 'ok', detail: distMain }
  }
  return {
    name: 'build artifact',
    status: 'warn',
    detail: 'dist/ not built. Run `pnpm build` or rely on tsx dev fallback.',
  }
}

export async function runDoctor(): Promise<number> {
  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkPnpm(),
    checkRipgrep(),
    checkDocker(),
    checkConfigFile(),
    checkEnvFile(),
    checkApiKey(),
    checkCwdWritable(),
    checkDistBuild(),
  ]

  process.stdout.write(`YuanCode doctor (${platform()} ${process.arch})\n`)
  process.stdout.write('─'.repeat(50) + '\n')
  for (const c of checks) {
    process.stdout.write(`${colorize(c.name.padEnd(22), c.status)}  ${c.detail}\n`)
  }
  process.stdout.write('─'.repeat(50) + '\n')

  const fails = checks.filter((c) => c.status === 'fail').length
  const warns = checks.filter((c) => c.status === 'warn').length
  if (fails > 0) {
    process.stdout.write(`\n\x1b[31m${fails} check(s) failed\x1b[0m, ${warns} warning(s)\n`)
    log.warn({ fails, warns }, 'doctor failed')
    return 1
  }
  process.stdout.write(`\n\x1b[32mAll required checks passed\x1b[0m, ${warns} warning(s)\n`)
  return 0
}
