#!/usr/bin/env node
// =============================================================================
// YuanCode CLI entry point
// Prefers the compiled `dist/` build; falls back to `tsx` in dev (no-build).
// =============================================================================
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const pkgRoot = resolve(__dirname, '..')

// Inject the YuanCode install / repo root so the harness can fall back to
// the bundled `.env` when the user runs YuanCode from a different cwd
// (e.g. `cd ~/some-project && yuancode`). Setting it here means every
// downstream loader can read it via `process.env.YUANCODE_HOME`.
process.env.YUANCODE_HOME = pkgRoot

// Prefer compiled build, then tsx (dev). Skip when YUANCODE_NO_AUTO_BUILD is set.
function tryRun() {
  const distEntry = join(pkgRoot, 'dist', 'main.js')
  if (existsSync(distEntry) && statSync(distEntry).isFile()) {
    // pathToFileURL: dynamic import() in ESM requires a file:// URL on Windows,
    // otherwise absolute paths like D:\foo get parsed as scheme "d:".
    import(pathToFileURL(distEntry).href)
    return
  }

  // Dev mode: invoke tsx directly via its JS entry. This avoids the
  // .cmd-shim quoting hell on Windows when the project path contains
  // spaces ("D:\prep for work\Projects\…").
  const tsxEntry = join(pkgRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  if (existsSync(tsxEntry)) {
    const srcEntry = join(pkgRoot, 'src', 'main.ts')
    const r = spawnSync(process.execPath, [tsxEntry, srcEntry, ...process.argv.slice(2)], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: process.env,
      windowsHide: true,
    })
    process.exit(r.status ?? 1)
    return
  }

  console.error('[31m✖ YuanCode is not built and tsx is not installed.[0m')
  console.error('  Run `./bin/setup` (or `pnpm install` + `pnpm build`) first.')
  process.exit(1)
}

tryRun()
