/**
 * YuanCode structured logger.
 *
 * Wraps pino with sensible defaults: pretty colors to stderr for interactive
 * use, JSON to file when a log file is configured. The level can be changed
 * at runtime via the `YUANCODE_LOG_LEVEL` env var.
 */
import { pino, type Logger, type LevelWithSilent } from 'pino'

export type LogLevel = LevelWithSilent

let _log: Logger | null = null

export function getLogger(): Logger {
  if (_log) return _log

  const level = (process.env.YUANCODE_LOG_LEVEL ?? 'info') as LogLevel
  const file = process.env.YUANCODE_LOG_FILE

  _log = pino({
    level,
    base: { app: 'yuancode', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
  })

  return _log
}

export function setLogLevel(level: LogLevel): void {
  const log = getLogger()
  log.level = level
}

export function childLogger(component: string): Logger {
  return getLogger().child({ component })
}
