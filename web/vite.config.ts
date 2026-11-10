import { execSync } from 'node:child_process'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

function git(args: string): string {
  try {
    return execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}

// Build stamp shown by src/components/VersionStamp.tsx. Env vars win so the Docker
// build (whose worktree never matches the index — a `git status` dirty check there
// would always be a false positive) and CI can inject exact values; local builds
// fall back to git, marking uncommitted state with "+dirty".
const sha = git('rev-parse --short HEAD')
const commit =
  process.env.GIT_SHA || (sha ? (git('status --porcelain') ? `${sha}+dirty` : sha) : 'unknown')
const commitTime = process.env.GIT_COMMIT_TIME || git('log -1 --format=%cI') || ''

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(commit),
    __APP_COMMIT_TIME__: JSON.stringify(commitTime),
  },
  server: {
    // 5178 — Astrolabe's own port, beside Flow's 5176 and the sibling stacks' 5173–5175.
    port: 5178,
    proxy: {
      '/api': 'http://localhost:8086',
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            // Groups capture their transitive deps too; keeping React (+scheduler) in its own
            // high-priority chunk stops future lazy-loaded feature chunks from swallowing it
            // and importing it eagerly everywhere.
            {
              name: 'react',
              test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test/setup.ts'],
    // No CSS is processed under happy-dom (it lays nothing out; the Mantine `env="test"` rule
    // already bypasses CSS-dependent visibility) — EXCEPT src/index.css, which theme.test.ts reads
    // `?raw` to pin its first-paint hexes to the canvas tokens, and src/print.css, which print.test.tsx
    // reads `?raw` to pin the Mantine class names it targets. Measured in build-times.md (WHY 6).
    css: { include: [/src[\\/](index|print)\.css/] },
    // Worker threads instead of forked processes: a cheaper spawn — measured -6 % wall and -30 % sys
    // time on the CI-shaped 3-worker run (build-times.md, WHY 6).
    pool: 'threads',
    // One worker runs many files with NO per-file fresh worker (each isolated file paid ~275 ms of
    // worker start + the Mantine/i18n setup import). What keeps that safe: `src/test/setup.ts`
    // clears the module registry before every file (so a file's own `vi.mock`s apply), tests await
    // lazy chart chunks instead of assuming a warm registry, and the suite is proven green under
    // `--sequence.shuffle`. A new test that leaks state across files fails there — fix the leak
    // (reset it in `afterEach`), never flip this back.
    isolate: false,
    // No on-disk module cache: vitest 5 caches each transformed module by its own content, but a module that uses
    // `import.meta.glob` (locales/parity.test.ts, i18n.ts) has the glob expanded at transform time, and the cache is NOT
    // invalidated when a file the glob matches is added. A stale entry kept the parity guard blind to a new locale area
    // (locally `test:coverage` ran 690 tests, a plain run 692; a fresh CI checkout always saw 692). Costs ~1 s per run.
    fsModuleCache: false,
    // Headroom over vitest's 5 s default for a contended run: setup.ts raises testing-library's async-util
    // timeout to 4 s (a cold lazy chunk), and a test awaits more than one of those.
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      // json-summary writes coverage/coverage-summary.json: per-file figures a script can read (raising the thresholds below).
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/api/schema.ts',
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        'src/main.tsx',
        'src/vite-env.d.ts',
        '**/*.d.ts',
      ],
      // Floors set just below current measured coverage so they gate regressions without
      // blocking unrelated work. Raise as coverage improves, never lower.
      // (2026-11-05, the 1.0.0 checkup: lines 98.65, statements 97.87, functions 97.62, branches 93.74; 2026-10-31: measured after trimming Flow to Astrolabe's foundation.)
      thresholds: {
        lines: 98,
        statements: 97,
        functions: 97,
        branches: 93,
      },
    },
  },
})
