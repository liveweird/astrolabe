### CI and static-analysis gate details

Read on demand before changing a CI job, a Dependabot rule or a static-analysis config; the commands a session runs stay in `CLAUDE.md` "Commands" and the binding one-line rules in `.claude/docs/testing.md`.

**CI** (moved from `CLAUDE.md` "Commands").

- CI: `.github/workflows/ci.yml` re-runs every gate above on push/PR (job ids `changes`, `server`, `gradle-vulnerability-scan`, `web`, `e2e-static`, `k8s-static`, `images`, and the failure-only `images-alert`; the `changes` job lets a PR changing only Markdown skip `server` and `images`; `server` — incl. the OpenAPI
  coverage gate, strict Gradle dependency verification (`--dependency-verification strict`) plus a
  lock/verification-metadata drift check, `gradle-vulnerability-scan` (a HIGH/CRITICAL Gradle lockfile vulnerability scan),
  `web` — incl. the API-contract gate (`lint:api` + `check:api`), `npm run lint` over a restored ESLint result cache (`web/.eslintcache` via `actions/cache`, keyed on the lockfile + `eslint.config.js` + the commit with a prefix restore, so a PR re-lints only the files it changed) and the coverage run in shuffled order
  (`npm run test:coverage -- --sequence.shuffle --sequence.seed=<seed>`, which is also the `isolate: false` independence proof; `scripts/gates.sh web` mirrors it with a
  random seed it prints; CI picks the seed itself and writes it, with the replay command, to the job summary before the run, so a shuffle-order failure can be reproduced), `e2e-static` —
  lint/knip/typecheck/scenario parity/setup, the toolchain-pins check, the always-loaded docs budget (`node scripts/check-docs-budget.mjs`: `CLAUDE.md` plus its `@` imports against `BUDGET_BYTES` read from `AlwaysLoadedDocsBudgetTest`; it runs here because the `server` job holding that test is skipped on Markdown-only PRs), the sample-plan self-tests (`node --test scripts/sample-plan/generate.test.mjs`, `... load.test.mjs` and the Jira stub generator's `sample-data/jira/generate.test.mjs`, one call per named file: a glob matching nothing exits 0 and with two named files node skips a missing one: the generator's determinism, counts, Zipf sizes, acyclicity, the server's limits, the committed `sample-data/plan` equal to a fresh run; the loader's development-stack check, reset matching and preflight against http stubs), `npm audit` (high+) on both npm workspaces, `k8s-static` (kubeconform over
  `k8s/` and `k8s/local/`, the app deployment pinned to one replica, and the front-door ConfigMap pinned: the base `k8s/front-door.yaml` stays the production posture, `apply-local.sh`'s render carries exactly one `astrolabe-front-door` ConfigMap, the `k8s/local/` overlay), and `images`, an image build plus a Trivy scan of it, on `master` pushes and on every pull request that changes more than Markdown — the `changes` job decides it, as it does `server`); the blackbox Playwright
  suite (`e2e.yml`) runs nightly and on demand, and re-scans the image it built with the same Trivy gate (its "Build images" step is a plain `docker compose build`, like `images`). Dependabot (`.github/dependabot.yml`) checks every
  workspace, Actions and container manifests weekly; `.claude/docs/dependencies.md` describes
  grouping, compatibility pins and runtime verification, and
  `.claude/docs/dependency-reproducibility.md` describes the Gradle lock/checksum mechanism itself. The job time budgets: `build-times.md` "Budgets".

**Concurrency.** `ci.yml` cancels a superseded run only for `pull_request` events (`cancel-in-progress: ${{ github.event_name == 'pull_request' }}`); a push to
`master` runs in a group of its own (the run id), because inside one shared group GitHub keeps a single pending run and drops the older pending one even without
`cancel-in-progress` — every master commit (so every release commit) is fully verified. `e2e.yml` (nightly/on demand) declares no `concurrency`.

**Failure alerting** (checkup 3, D5-1/D8-5; nightly + alerting was chosen over a PR-time e2e subset, to keep PR CI fast).

- **Where and when.** `e2e.yml` job `alert` runs `if: failure() && github.event_name == 'schedule'` (the nightly only; an on-demand `workflow_dispatch` run stays quiet because its author is watching) and `ci.yml` job `images-alert` runs
  `if: failure() && github.event_name == 'push' && github.ref == 'refs/heads/master'`; each `needs` the job it watches, so it is skipped (not run) on every green or cancelled run and adds nothing to a gate's time. No other job is watched.
- **One reusable piece.** Both call `.github/workflows/ci-alert.yml` (`workflow_call`, input `title`; no third-party action, only the runner's `gh`). The calling job grants `permissions: issues: write` with the built-in `GITHUB_TOKEN`; the workflows' default stays `contents: read` and no secret is involved.
- **Dedupe.** The label `ci-failure` (created with `gh label create --force`) plus an exact title, one issue per workflow: "Nightly e2e is failing" and "master images job is failing". An OPEN issue with that label and title gets a comment (run URL, date, head SHA, trigger); otherwise the issue is opened with the same body. Every context value reaches the script through `env:` (script-injection rule); no commit message, branch name or PR title is used.
- **Closing is manual.** Nothing closes the issue automatically, not even a green run: close it once the cause is understood, and the next red run opens a fresh one. A red `alert` job (e.g. a token problem) is itself a failed run.

**Local gates vs CI (`scripts/gates.sh`).** The script runs `server-build` (`cleanTest check :server:installDist :verifySettingsPluginAudit`, then the same lockfile and verification-metadata `git diff --exit-code` CI's server job runs), `web-gates` and `e2e-static` (lint, knip, typecheck, scenario parity, `npm run test:setup` and
`node scripts/check-toolchain-pins.mjs`, `node scripts/check-docs-budget.mjs` and the sample-plan `node --test` self-tests, the same cheap checks as the CI `e2e-static` job). **CI-only scans**, deliberately not in the script (the header comment of
`gates.sh` lists them too): `npm audit` on both workspaces and the HIGH/CRITICAL Gradle lockfile vulnerability scan (they read a live advisory database and the network, and
their result changes overnight without a commit), kubeconform in `k8s-static` (a downloaded checksum-pinned binary), and the Trivy / AppCDS image checks (need a built image).

**Static analysis and dead-code gates** (moved from `testing.md`).

**Static analysis (detekt).** `./gradlew detekt` runs detekt over `core` + `server` (plain rule
sets, no type resolution) and rides `check`, so `build` fails on any finding — the gate is zero
findings with **no baseline file**. Repo tuning lives in `config/detekt/detekt.yml`, layered on
the bundled defaults; every override there carries a one-line comment naming the deliberate idiom
it protects (wildcard Ktor imports, the flat feature-package layout, declarative `*Routes.kt`
registrars, the validation-throw convention, guard-clause returns). Fix new findings in code
first; extend the config only for a genuinely deliberate idiom, and prefer a config override over
`@Suppress` (a per-site `@Suppress` needs a one-line justifying comment). Runs in seconds, no
Docker — safe to run anytime, unlike the test suite.

**Frontend static analysis (sonarjs + jsx-a11y + knip).** The SPA's counterpart, same
zero-findings/no-baseline policy: `cd web && npm run lint` carries `eslint-plugin-sonarjs`
(recommended set), `eslint-plugin-jsx-a11y` (`flatConfigs.recommended`: the static half of the accessibility rules the e2e axe sweep checks at run time; its two overrides are file-scoped — the roving `role="grid"` container and the single-purpose entry pages' `autoFocus`) plus core size/complexity backstops tuned generously for React's
one-function-per-page architecture (`cognitive-complexity` 40, `complexity` 50 — backstops
against future monsters, not targets); every override in `web/eslint.config.js` carries the idiom
comment. `cd web && npm run knip` is the dead-code gate (unused files/exports/dependencies; test
files count as entries, so a flagged export is unused even by tests) — the generated
`src/api/schema.ts` is excluded (type-checked by `tsc`, not style-linted). `web/scripts/*.mjs` (the build-time Node scripts, e.g. `check-api.mjs`) are linted too —
`js.configs.recommended` + sonarjs with Node globals, a separate block in `web/eslint.config.js`.

**Running the full stack** (moved from `CLAUDE.md`; the ports and the one-liners stay there).

`docker compose up --build` serves everything at `http://localhost:8086` (sign in as
`admin@astrolabe.local` — see the README for where the initial password comes from); local dev is
`docker compose up postgres mailpit` (Postgres on host port **5437**) + `./gradlew :server:run`
(API on **8086**) + `cd web && npm run dev` (Vite on **5178**, proxying `/api` to :8086), each in
its own terminal. The compose stack is postgres + mailpit + app only, and bundles **Mailpit** (`http://localhost:8029`) and wires the
app's password-reset and MFA email to it (`MAIL_TRANSPORT=smtp`). Ports deliberately differ across the sibling repos so every stack can run side by side
(host ports bind to 127.0.0.1 only):

| Repo | App | Postgres | Mailpit UI | Vite |
|---|---|---|---|---|
| Lettuce | 8080 | 5432 | 8025 | 5173 |
| Toadie | 8081 | 5433 | 8026 | 5174 |
| Covenant | 8082 | 5434 | 8027 | 5175 |
| Flow | 8084 | 5435 | 8028 | 5176 |
| Grenadiers | 8085 | 5436 | – | 5177 |
| **Astrolabe** | **8086** | **5437** | **8029** | **5178** |

(The Jira stub — a WireMock over `sample-data/jira-stub`, `JIRA_STUB_BASE_URL` — is the sibling table's port **8096**: the Jira sync's development and test double, served in-JVM by `JiraStubServer` in the server suite and, from a later v1.1.0 step, as the `jira-stub` service on compose and Kubernetes; Flow's stubs sat on 8094/8095. The app boots without it and production refuses its URL, `security.md` "Outbound HTTP calls".) Kubernetes
(OrbStack) deployment targets the dedicated `astrolabe` namespace — see `k8s/secret.yaml`'s header for
the secret-creation command; the image is `astrolabe-app` and the cluster runs a single `app-deployment.yaml` (one process, no worker) beside postgres; `k8s/apply-local.sh` applies the OrbStack overlay `k8s/local/front-door.yaml` (development mode, no proxy) instead of the production-posture base `k8s/front-door.yaml` (`security.md`, "The front door").

**AppCDS (class-data sharing).**

- The Docker build dumps `/app/cds/astrolabe.jsa` from the committed `server/cds/classlist.txt` (a few seconds per image build and ~100 MB per image; the measured figures are re-baselined at v0.1.0); Trivy scans the same image as before.
- The `images` job then runs `scripts/check-cds-archive.sh astrolabe-app` (the image's launcher with `-XX:+PrintSharedArchiveAndExit`, under a second, no database): it fails when the archive does not fit the runtime
  (a changed jar, `-XX:-UseCompressedOops`/`ObjectAlignmentInBytes` added to `applicationDefaultJvmArgs`, another JDK) or is not wired, because such an image starts silently WITHOUT the archive and slower than before.
- `scripts/cds-classlist.mjs` regenerates the class list from a real run in its own throwaway compose project (own ports, own volume); it builds its own image and refuses to overwrite the list from an unhealthy run. Regenerate it whenever the class set changes materially (`CdsClassListTest` guards drift).
