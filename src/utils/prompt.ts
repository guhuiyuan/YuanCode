/**
 * Minimal readline-based prompt helpers used by the `init` wizard and
 * `doctor` command. We avoid pulling in `inquirer` to keep the install
 * size small; the wizard only needs a handful of question types.
 */
import { createInterface, type Interface } from 'node:readline'
import { stdin, stdout } from 'node:process'

export interface PromptOptions {
  default?: string
  password?: boolean
  choices?: string[]
}

export interface ConfirmOptions {
  default?: boolean
}

function makeRl(): Interface {
  return createInterface({ input: stdin, output: stdout })
}

/**
 * Free-form text question. Returns the user's trimmed input, or the default
 * when the user just hits enter.
 */
export async function ask(question: string, opts: PromptOptions = {}): Promise<string> {
  const rl = makeRl()
  const suffix = opts.default !== undefined ? ` [${opts.default}]` : ''
  const hint =
    opts.choices && opts.choices.length > 0
      ? ` (${opts.choices.join(' / ')})`
      : ''
  return new Promise<string>((resolveP) => {
    rl.question(`${question}${hint}${suffix}: `, (answer) => {
      rl.close()
      const trimmed = answer.trim()
      resolveP(trimmed === '' ? (opts.default ?? '') : trimmed)
    })
  })
}

/**
 * Password prompt. Echoes `*` for each typed character (not perfect on all
 * terminals but acceptable for a CLI init wizard).
 */
export async function askPassword(question: string): Promise<string> {
  const rl = makeRl()
  process.stdout.write(`${question}: `)
  if (!stdin.isTTY) {
    // Non-interactive fallback — read raw line.
    return new Promise<string>((resolveP) => {
      rl.question('', (answer) => {
        rl.close()
        resolveP(answer.trim())
      })
    })
  }
  return new Promise<string>((resolveP) => {
    let collected = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const onData = (ch: string): void => {
      for (const c of ch) {
        if (c === '\n' || c === '\r' || c === '') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          rl.close()
          resolveP(collected)
          return
        }
        if (c === '') {
          process.stdout.write('\n^C\n')
          process.exit(130)
        }
        if (c === '' || c === '\b') {
          if (collected.length > 0) {
            collected = collected.slice(0, -1)
            process.stdout.write('\b \b')
          }
        } else {
          collected += c
          process.stdout.write('*')
        }
      }
    }
    stdin.on('data', onData)
  })
}

/** Yes/no confirmation. Returns true on y/Y, false on n/N, default on enter. */
export async function confirm(question: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const rl = makeRl()
  const suffix = opts.default === undefined ? ' [y/n]' : opts.default ? ' [Y/n]' : ' [y/N]'
  return new Promise<boolean>((resolveP) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      rl.close()
      const a = answer.trim().toLowerCase()
      if (a === '') {
        resolveP(opts.default ?? false)
        return
      }
      resolveP(a === 'y' || a === 'yes')
    })
  })
}

/**
 * Multiple-choice question. Returns the chosen index.
 */
export async function choose(question: string, choices: string[]): Promise<number> {
  process.stdout.write(`${question}\n`)
  choices.forEach((c, i) => process.stdout.write(`  ${i + 1}. ${c}\n`))
  const ans = await ask('Choose', { default: '1' })
  const idx = parseInt(ans, 10)
  if (Number.isNaN(idx) || idx < 1 || idx > choices.length) {
    return 0
  }
  return idx - 1
}
