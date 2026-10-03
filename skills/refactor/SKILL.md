---
name: refactor
description: Plan and execute a behavior-preserving refactor of a piece of code. Use when the user asks for cleanup, restructuring, extracting helpers, or "make this nicer".
when_to_use: "user asks 'refactor', 'clean up', 'extract', 'reorganize', or 'split this up'"
---

# Refactor Workflow

Refactor = change structure WITHOUT changing behavior. Tests must stay green at
every step. If you cannot prove behavior preservation, you are not refactoring —
you are rewriting.

## Steps

1. **Establish baseline**
   - Run the existing test suite. All green.
   - If no tests, ask the user before proceeding: "There are no tests for X.
     Refactor without tests is risky. Want me to add coverage first?"

2. **Identify the smell**
   - Long function (>50 lines), large class (>300 lines), deep nesting (>3), or
     duplicated code.
   - Cite the exact lines and quote the offending snippet.

3. **Choose a refactoring pattern**
   - Extract Function, Extract Variable, Inline, Rename, Move, Replace
     Conditional with Polymorphism, Introduce Parameter Object, Replace Magic
     Number with Symbolic Constant.
   - State which one and WHY.

4. **Plan the edits**
   - List files + line ranges in order.
   - Identify which existing tests will catch regressions.
   - If new tests are needed, write them FIRST.

5. **Execute incrementally**
   - One small commit-sized chunk at a time.
   - Re-run tests after each chunk.
   - If tests fail: STOP. Diagnose before continuing.

6. **Verify**
   - All tests still green.
   - `git diff --stat` shows the expected files only.
   - Behavior preserved: spot-check by running the affected code path manually.

## Anti-patterns

- Do NOT refactor + add features in the same commit.
- Do NOT rename + restructure simultaneously — rename first, restructure next.
- Do NOT skip the baseline test run "because it's obvious it works".
- Do NOT introduce a new dependency just to avoid a 10-line refactor.
