/**
 * `yuancode init` — first-time setup wizard.
 *
 * Writes `~/.yuancode/config.yaml`. Non-interactive mode (`--non-interactive`)
 * reads everything from flags / env vars and writes a config file without
 * prompting. The wizard is otherwise a simple series of readline questions.
 */
import { mkdir, writeFile, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { ask, askPassword, choose, confirm } from '../utils/prompt.js'
import { getLogger } from '../utils/logger.js'

const log = getLogger().child({ component: 'init' })

const PROVIDER_PRESETS = [
  {
    id: 'minimax',
    label: 'MiniMax M3 (Anthropic-compatible)',
    defaultBaseUrl: 'https://api.minimaxi.com/anthropic',
    defaultModel: 'MiniMax-M3',
  },
  {
    id: 'anthropic',
    label: 'Anthropic Claude',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-5-20250929',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    defaultBaseUrl: '',
    defaultModel: '',
  },
] as const

export interface InitOptions {
  nonInteractive?: boolean
  provider?: string
  apiKey?: string
  baseUrl?: string
  model?: string
}

interface WizardResult {
  provider: string
  apiKey: string
  baseUrl: string
  model: string
  permissionMode: string
  sandbox: string
}

async function runInteractive(): Promise<WizardResult> {
  process.stdout.write('\nWelcome to YuanCode! Let\'s set up your config.\n\n')

  const providerChoices = PROVIDER_PRESETS.map((p) => p.label)
  const idx = await choose('Which model provider do you want to use?', [
    ...providerChoices,
  ])
  const preset = PROVIDER_PRESETS[idx] ?? PROVIDER_PRESETS[0]
  if (!preset) {
    throw new Error('No provider selected')
  }

  const apiKey = await askPassword('API key (leave empty to use $YUANCODE_API_KEY env)')
  const baseUrl = await ask('Base URL', { default: preset.defaultBaseUrl })
  const model = await ask('Model name', { default: preset.defaultModel })

  const pmIdx = await choose('Default permission mode?', [
    'manual — ask before every action',
    'acceptEdits — auto-pass file edits (recommended)',
    'auto — agent evaluates with background safety checks',
    'plan — read-only, no file writes',
  ])
  const permissionModes = ['manual', 'acceptEdits', 'auto', 'plan'] as const
  const permissionMode = permissionModes[pmIdx] ?? 'acceptEdits'

  const sbIdx = await choose('Sandbox mode for the bash tool?', [
    'local — process isolation (cross-platform, default)',
    'bubblewrap — Linux namespaces (Linux only)',
    'docker — full container (requires Docker)',
    'landlock — Linux kernel FS isolation (Linux 5.13+)',
  ])
  const sandboxModes = ['local', 'bubblewrap', 'docker', 'landlock'] as const
  const sandbox = sandboxModes[sbIdx] ?? 'local'

  return {
    provider: preset.id,
    apiKey,
    baseUrl,
    model,
    permissionMode,
    sandbox,
  }
}

function buildConfigYaml(r: WizardResult): string {
  const cfg = {
    model: {
      provider: r.provider,
      model: r.model,
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      ...(r.apiKey ? { apiKey: r.apiKey } : {}),
      maxTokens: 8192,
      cacheControl: true,
      temperature: 1.0,
    },
    permissionMode: r.permissionMode,
    limits: {
      maxSteps: 50,
      totalTimeoutMs: 1_800_000,
      perStepTimeoutMs: 60_000,
      maxCostUsd: 5.0,
      parallelTools: 8,
    },
    sandbox: {
      mode: r.sandbox,
      image: 'yuancode/sandbox:latest',
      extraWritable: [],
    },
    logLevel: 'info',
  }
  return yamlStringify(cfg, { lineWidth: 100 })
}

function resolveConfigPath(): string {
  return join(homedir(), '.yuancode', 'config.yaml')
}

export async function runInitWizard(opts: InitOptions): Promise<void> {
  const configPath = resolveConfigPath()

  if (existsSync(configPath)) {
    const overwrite = await confirm(`Config already exists at ${configPath}. Overwrite?`, {
      default: false,
    })
    if (!overwrite) {
      log.info('init cancelled by user; existing config preserved')
      return
    }
  }

  let result: WizardResult
  if (opts.nonInteractive) {
    result = {
      provider: opts.provider ?? 'minimax',
      apiKey: opts.apiKey ?? process.env.YUANCODE_API_KEY ?? '',
      baseUrl: opts.baseUrl ?? 'https://api.minimaxi.com/anthropic',
      model: opts.model ?? 'MiniMax-M3',
      permissionMode: 'acceptEdits',
      sandbox: 'local',
    }
  } else if (!process.stdin.isTTY) {
    log.warn('No TTY detected; falling back to non-interactive mode')
    result = {
      provider: opts.provider ?? 'minimax',
      apiKey: opts.apiKey ?? process.env.YUANCODE_API_KEY ?? '',
      baseUrl: opts.baseUrl ?? 'https://api.minimaxi.com/anthropic',
      model: opts.model ?? 'MiniMax-M3',
      permissionMode: 'acceptEdits',
      sandbox: 'local',
    }
  } else {
    result = await runInteractive()
  }

  const yaml = buildConfigYaml(result)
  await mkdir(resolve(configPath, '..'), { recursive: true })
  await writeFile(configPath, yaml, { encoding: 'utf8' })

  // Restrict to user-only on POSIX. Best-effort on Windows (no-op).
  try {
    await chmod(configPath, 0o600)
  } catch {
    /* Windows or filesystem without permission bits */
  }

  process.stdout.write(`\n✔ Config written to ${configPath}\n`)
  process.stdout.write('  Try: yuancode doctor   (verify setup)\n')
  process.stdout.write('  Try: yuancode          (start the TUI)\n\n')
}
