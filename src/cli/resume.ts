/**
 * `yuancode resume <sessionId>` — resume a previous session.
 *
 * M0 stub. The full SessionStore + replay loop lands in M4 (Checkpoint +
 * Context Compaction). For now we print a friendly message so the CLI
 * surface is complete and stable.
 */
import { getLogger } from '../utils/logger.js'

const log = getLogger().child({ component: 'resume' })

export async function runResume(sessionId: string): Promise<void> {
  log.info({ sessionId }, 'resume requested')
  process.stdout.write(`\nResume of session "${sessionId}" is not yet implemented (lands in M4).\n`)
  process.stdout.write('For now, sessions are kept in `.yuancode/sessions/` once the loop is live.\n\n')
}
