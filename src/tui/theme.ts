/**
 * TUI theme — colors and helpers used by Ink components and console output.
 *
 * Two parallel sets:
 *   - `theme` / `colors`  raw hex strings for Ink `<Text color={...}>`
 *   - `c`                 chalk-wrapped versions for stdout/stderr strings
 *
 * Ink's colorize() expects strings (not ChalkInstances), so the hex strings
 * are the canonical source. The chalk helpers are only used outside of Ink
 * (banner, status lines, doctor output).
 */
import chalk from 'chalk'

export const colors = {
  brand: '#7c5cff',
  brandAccent: '#5e8bff',
  success: '#4ade80',
  warn: '#fbbf24',
  error: '#f87171',
  muted: '#6b7280',
  dim: '#9ca3af',
  yellow: '#fbbf24',
  gray: '#9ca3af',
  blue: '#5e8bff',
  purple: '#7c5cff',
} as const

/** Alias — components can use either `theme.brand` or `colors.brand`. */
export const theme = colors

/** Chalk-wrapped helpers for non-Ink text (banner, doctor output). */
export const c = {
  brand: chalk.hex(colors.brand),
  brandAccent: chalk.hex(colors.brandAccent),
  success: chalk.hex(colors.success),
  warn: chalk.hex(colors.warn),
  error: chalk.hex(colors.error),
  muted: chalk.gray,
  dim: chalk.dim,
  bold: chalk.bold,
  underline: chalk.underline,

  // pre-rendered semantic labels (use these when you want a pre-styled label)
  userLabel: chalk.hex(colors.brand).bold('»'),
  assistantLabel: chalk.hex(colors.brandAccent).bold('●'),
  toolLabel: chalk.hex(colors.warn).bold('⚡'),
  systemLabel: chalk.hex(colors.muted).bold('·'),

  statusOk: chalk.hex(colors.success)('●'),
  statusBusy: chalk.hex(colors.warn)('●'),
  statusError: chalk.hex(colors.error)('●'),
}

export const banner = (text: string): string => `${c.brand(text)}${chalk.reset('')}`
export const ok = (text: string): string => `${c.success(text)}${chalk.reset('')}`
export const fail = (text: string): string => `${c.error(text)}${chalk.reset('')}`
export const dim = (text: string): string => `${c.dim(text)}${chalk.reset('')}`
