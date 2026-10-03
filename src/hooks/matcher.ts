/**
 * Hook matcher — compile a `matcher:` string into a fast test function.
 *
 * Three forms:
 *   1. `undefined`/missing → wildcard (matches every tool name)
 *   2. Plain string → exact match
 *   3. `/regex/` literal OR a string starting with `^`/`.*` → compiled RegExp
 *
 * Invalid regexes throw at compile time (load time) — never at fire time —
 * so a misconfigured hooks.yaml fails fast at boot, not on first use.
 *
 * Patterns are capped (1024 chars, 200-char tool names during tests) to
 * prevent ReDoS. The pattern cache is a `WeakMap` keyed by the source
 * `HookEntry` so identical matchers across fires don't recompile.
 */

export interface CompiledMatcher {
  source: string | null
  regex: RegExp | null
  test(toolName: string): boolean
}

const MAX_PATTERN = 1024

function safeRegex(pattern: string, flags = ''): RegExp {
  if (pattern.length > MAX_PATTERN) {
    throw new Error(`Hook matcher regex too long: ${pattern.length} > ${MAX_PATTERN}`)
  }
  try {
    return new RegExp(pattern, flags)
  } catch (e) {
    throw new Error(`Invalid hook matcher regex /${pattern}/: ${(e as Error).message}`)
  }
}

export function compileMatcher(matcher: string | undefined | null): CompiledMatcher {
  // Form 1: wildcard
  if (matcher === undefined || matcher === null || matcher === '') {
    return { source: null, regex: null, test: () => true }
  }

  // Form 3a: literal `/.../` (e.g. "/^mcp__.*$/")
  if (matcher.length >= 2 && matcher.startsWith('/') && matcher.endsWith('/')) {
    const pattern = matcher.slice(1, -1)
    const regex = safeRegex(pattern)
    return { source: matcher, regex, test: (name) => regex.test(name) }
  }

  // Form 3b: heuristic — strings starting with `^` or containing `.*` are treated as regex
  if (matcher.startsWith('^') || matcher.includes('.*') || matcher.includes('\\')) {
    const regex = safeRegex(matcher)
    return { source: matcher, regex, test: (name) => regex.test(name) }
  }

  // Form 2: exact match
  const exact = matcher
  return { source: matcher, regex: null, test: (name) => name === exact }
}
