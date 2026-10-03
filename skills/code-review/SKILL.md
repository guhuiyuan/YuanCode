---
name: code-review
description: Review a code diff or full file for correctness, security, performance, and style issues. Use when the user asks for a review, audit, or "look this over".
when_to_use: "user asks 'review', 'audit', 'check this code', or 'is this safe'"
---

# Code Review

You are performing a structured code review. Follow this checklist in order and
report each finding with: file path, line range, severity (blocker/major/minor/nit),
one-sentence summary, and a concrete suggested fix.

## Checklist

### 1. Correctness
- Does the code do what the function/class/module name promises?
- Are all branches reachable / no dead code?
- Off-by-one, null/undefined, division by zero, empty array, empty string edge cases?
- Async: missing `await`, race condition, unhandled rejection?
- Types: `any`, `as` casts hiding a real mismatch, generic constraints wrong?

### 2. Security
- User input passed to shell / SQL / eval / template?
- Path traversal: `path.join(userInput)` without resolving + checking root?
- Secrets in source: hard-coded tokens, passwords, private keys?
- Crypto: MD5/SHA1 for passwords, random from `Math.random()` for tokens?
- Deserialization of untrusted JSON with prototype pollution risk?

### 3. Performance
- O(n²) loops where a Set/Map would be O(n)?
- Re-creating large objects inside hot loops?
- Sync I/O on the request path (`fs.readFileSync`, `child_process.execSync`)?
- Unbounded queries (no `.limit()`)?
- Memory leaks: growing Map, never-removed listeners, never-closed streams?

### 4. Style (project-specific)
- Are imports sorted and grouped per project convention?
- Are error messages lowercase + specific, or uppercase + vague?
- Are log lines structured (JSON) or stringified ad-hoc?
- Are tests present for new behavior?

### 5. Test coverage
- New public functions have at least one positive + one negative test?
- Edge cases covered (empty input, max-size input, special chars)?
- Are async tests actually awaiting the assertion (`expect(...).resolves`)?

## Output format

```markdown
## Findings

### [MAJOR] src/foo.ts:42-55 — short summary
**Why:** concrete explanation referencing the code.
**Fix:** minimal patch suggestion.

### [NIT] src/bar.ts:12 — typo in error message
**Why:** trivial.
**Fix:** rename to lowercase + specific.
```

Group findings by severity (blocker → major → minor → nit). If a section is
empty, say "none" instead of skipping it.
