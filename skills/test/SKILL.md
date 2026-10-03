---
name: test
description: Generate tests for an existing piece of code. Use when the user asks to add tests, write a failing test, or improve coverage.
when_to_use: "user asks 'add tests', 'write a test', 'increase coverage', or 'this should be tested'"
---

# Test Generation Workflow

Tests prove the code does what it claims. They are also the safety net for every
future refactor. Generate them deliberately, not mechanically.

## Before writing

1. **Read the function** — its signature, docstring, types.
2. **Identify the contract** — what input → what output, what errors.
3. **Identify categories of cases:**
   - Happy path (the documented normal use)
   - Boundary (empty, zero, max, off-by-one)
   - Invalid input (type wrong, format wrong, out of range)
   - Error / rejection path (network down, file missing, permission denied)
   - Async / concurrency (timeout, race, cancellation)

## Test structure

Follow the project's test framework (vitest / jest / mocha). Each test file
should mirror the source layout (`src/foo.ts` ↔ `src/foo.test.ts`).

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { myFunction } from './foo.js'

describe('myFunction', () => {
  // Group related cases; describe nested describe blocks for sub-functions.

  it('returns the value for the canonical happy path', () => {
    expect(myFunction('input')).toEqual({ ok: true })
  })

  it('throws on empty input', () => {
    expect(() => myFunction('')).toThrow(/empty/)
  })

  it.each([
    ['case-A', 'expected-A'],
    ['case-B', 'expected-B'],
  ])('maps %s → %s', (input, expected) => {
    expect(myFunction(input)).toEqual(expected)
  })
})
```

## Rules

- **One assertion focus per test.** Multiple `expect()` calls are fine if they all
  verify the SAME property; split if they verify different properties.
- **Test names read as sentences:** `it('rejects empty string', ...)`.
- **Mock the boundary, not the internals.** Mock `fetch`, not your own helper.
- **Determinism:** never depend on real time, real network, real filesystem
  outside `tmpdir`. Use `vi.useFakeTimers()` when relevant.
- **No `console.log` in tests.** Use `expect` assertions; silence expected logs
  with `vi.spyOn(console, 'log').mockImplementation(() => {})` if necessary.
- **Coverage goal:** every public function has ≥ 1 happy + ≥ 1 error test.

## After writing

1. Run the suite. All new tests should pass against the current implementation.
2. Run `pnpm test --coverage` (or equivalent) and report uncovered lines.
3. If a test is hard to write, that is a signal the function under test is too
   coupled — flag it to the user instead of working around it.
