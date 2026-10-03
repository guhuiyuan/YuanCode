# Contributing to YuanCode

Thanks for your interest in contributing. This guide covers the minimum to get a PR merged cleanly.

## Development Environment

- **Node.js** ≥ 20.10.0 (see `.nvmrc` / `.node-version`)
- **pnpm** ≥ 10.28.2 (`corepack enable pnpm` is the simplest path)
- A POSIX-compatible shell (Git Bash on Windows works)

## First-time setup

```bash
git clone https://github.com/guhuiyuan/yuancode.git
cd yuancode
pnpm install
cp .env.example .env   # then fill in your own YUANCODE_API_KEY
pnpm test              # 538 unit + 33 e2e should all pass
```

## Workflow

1. **Branch off `main`.** Use a descriptive name:
   - `feat/<slug>` for new features
   - `fix/<slug>` for bug fixes
   - `docs/<slug>` for documentation only
   - `refactor/<slug>` for non-functional changes
2. **Keep commits focused.** One logical change per commit.
3. **Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):**
   `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, `perf:`.
4. **Run the full pre-submit checklist locally before pushing:**
   ```bash
   pnpm typecheck    # tsc --noEmit, strict mode
   pnpm test         # vitest run, unit tests
   pnpm test:e2e     # vitest run --config vitest.e2e.config.ts
   ```
5. **Open a Pull Request** against `main`. The CI workflow (`.github/workflows/test.yml`) must be green before review.

## Code Style

- **TypeScript strict mode.** The project compiles with `strict: true`; do not relax it locally.
- **No `any` by default.** If you genuinely need it, narrow with `unknown` first and add a comment.
- **Imports** use the `.js` extension (NodeNext ESM resolution), e.g. `import { x } from './foo.js'`.
- **Public APIs** carry a doc comment. Internal helpers do not need one.
- **File layout** mirrors the 5-layer architecture — see `docs/architecture.md`.

## Tests

- Unit tests live in `tests/unit/` next to the layer they cover.
- E2E tests live in `tests/e2e/` and exercise the CLI / TUI / sandbox end to end.
- A new feature should ship with at least one unit test. A bug fix should ship with a regression test that fails before the fix and passes after.
- Use the `tinybench` / `vitest` patterns already in the repo; do not introduce a new test framework.

## Security

Report vulnerabilities via GitHub Security Advisories
(<https://github.com/guhuiyuan/yuancode/security/advisories/new>) — **not** as public issues.
See `SECURITY.md` for the full disclosure policy.

## License

By contributing, you agree that your contributions are licensed under the MIT License (see `LICENSE`).
