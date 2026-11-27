# CI and static-analysis gates

Owns: the CI jobs and what each gates, the failure alerting, local gates vs CI, the docs shape check, the static-analysis configuration, the full-stack notes (the sibling port table, the two stubs and their carriers, the Kubernetes overlay) and AppCDS. Not here: the commands (`CLAUDE.md` "Commands"), the one-line test rules (`testing.md`), the job time budgets (`build-times.md`), dependency rules (`dependencies.md`, `dependency-reproducibility.md`). Read before changing a CI job, a Dependabot rule or a static-analysis config.

## CI

`.github/workflows/ci.yml` re-runs every gate of `CLAUDE.md` "Commands" on push/PR. Its job ids: `changes`, `server`, `gradle-vulnerability-scan`, `web`, `e2e-static`, `k8s-static`, `images`, and the failure-only `images-alert`.

- `changes`: lets a PR that changes only Markdown skip `server` and `images`.
- `server`: includes the OpenAPI coverage gate, strict Gradle dependency verification (`--dependency-verification strict`) plus a lock/verification-metadata drift check.
- `gradle-vulnerability-scan`: a HIGH/CRITICAL Gradle lockfile vulnerability scan.
- `web`: includes the API-contract gate (`lint:api` + `check:api`).
  - `npm run lint` runs over a restored ESLint result cache (`web/.eslintcache` via `actions/cache`, keyed on the lockfile + `eslint.config.js` + the commit with a prefix restore).
  - The coverage run is shuffled (`npm run test:coverage -- --sequence.shuffle --sequence.seed=<seed>`), the `isolate: false` independence proof; CI writes the seed and the replay command to the job summary (`scripts/gates.sh web` prints a random one).
- `e2e-static`: lint/knip/typecheck/scenario parity/setup, plus these cheap repo checks.
  - The toolchain-pins check.
  - The always-loaded docs budget (`node scripts/check-docs-budget.mjs`: `CLAUDE.md` plus its `@` imports against `BUDGET_BYTES`, `web/CLAUDE.md` against `WEB_CLAUDE_BUDGET_BYTES`); it runs here because the `server` job holding `AlwaysLoadedDocsBudgetTest` is skipped on Markdown-only PRs.
  - The docs shape check (`node scripts/check-docs-shape.mjs`, "Docs shape" below) and its self-test.
  - The sample-plan self-tests: `node --test scripts/sample-plan/generate.test.mjs`, `... load.test.mjs` and `sample-data/jira/generate.test.mjs`, one call per named file (a glob matching nothing exits 0); determinism, counts, acyclicity, the server's limits, the committed `sample-data/plan` equal to a fresh run, the loader's checks against http stubs.
  - `npm audit` (high+) on `e2e/`, the full tree (the `web` job audits `web/` with `--omit=dev`).
- `k8s-static`: kubeconform over `k8s/` and `k8s/local/`; the app deployment pinned to one replica with strategy `Recreate` (the in-memory lockout and MFA state assumes one pod); the front-door ConfigMap pinned (the app Deployment's refs as an explicit list of key names, not a count; the base `k8s/front-door.yaml` stays the production posture and `apply-local.sh`'s render carries exactly one `astrolabe-front-door` ConfigMap).
- `images`: an image build plus a Trivy scan, on `master` pushes and on every pull request that changes more than Markdown (the `changes` job decides, as for `server`).
- `e2e.yml`, the blackbox Playwright suite, runs nightly and on demand, and re-scans its image with the same Trivy gate.
- Dependabot (`.github/dependabot.yml`) checks every workspace, Actions and container manifests weekly (`dependencies.md`, `dependency-reproducibility.md`).
- The job time budgets: `build-times.md` "Budgets".

### Forks, runner facts and time reports

- The `server` job runs two test forks (`TEST_FORKS: "2"`, passed as `-Pforks`; the fork-balance block of its summary reads `server/test-weights.tsv`). Every job opens with a "Runner facts" step (CPU model, logical CPUs, memory), because the same job runs at two speeds. The `web` job ends with a "Vitest time report (job summary)" step (`scripts/timings/vitest-times.mjs`, information only).
- The Gradle step ("Build and test (Gradle)") and the `npm ci` steps ("Install dependencies") are named so `ci-times.mjs --steps` can carry a budget row (`build-times.md` "Astrolabe WHY 3").

## Concurrency

`ci.yml` cancels a superseded run only for `pull_request` events; a push to `master` runs in a group of its own (the run id), because a shared group keeps one pending run and drops the older one, so every master commit (every release commit) is fully verified. `e2e.yml` declares no `concurrency`.

## Failure alerting

Nightly e2e plus alerting was chosen over a PR-time e2e subset, to keep PR CI fast.

- **Where and when.** `e2e.yml` job `alert` runs `if: failure() && github.event_name == 'schedule'` (the nightly only; an on-demand run stays quiet because its author is watching) and `ci.yml` job `images-alert` runs `if: failure() && github.event_name == 'push' && github.ref == 'refs/heads/master'`. Each `needs` the job it watches, so it is skipped on every green or cancelled run. No other job is watched.
- **One reusable piece.** Both call `.github/workflows/ci-alert.yml` (`workflow_call`, input `title`; only the runner's `gh`); the calling job grants `permissions: issues: write` with the built-in `GITHUB_TOKEN`, no secret.
- **Dedupe.** The label `ci-failure` plus an exact title, one issue per workflow: "Nightly e2e is failing" and "master images job is failing". An OPEN issue with both gets a comment (run URL, date, head SHA, trigger); otherwise one is opened. Every context value reaches the script through `env:` (script-injection rule); no commit message, branch name or PR title is used.
- **Closing is manual.** Nothing closes the issue automatically, not even a green run: close it once the cause is understood, and the next red run opens a fresh one. A red `alert` job (e.g. a token problem) is itself a failed run.
- **A green nightly can still hide flaky tests.** `retries` stays 2, so after "Run E2E" `e2e.yml` runs `e2e/scripts/flaky-summary.mjs` over the CI-only JSON report into the step summary: each test that passed only on a retry (file and line, attempts, first error line) and the failed ones; it always exits 0 (informs, never gates).

## Local gates vs CI

`scripts/gates.sh` runs beside the compose stack (`StubPortGuardTest`). Its stages: `server-build` (`cleanTest check :server:installDist :verifySettingsPluginAudit`, then CI's lockfile and verification-metadata `git diff --exit-code`), `web-gates`, and `e2e-static` (the cheap checks of the CI job of that name, the docs budget and shape checks included).

**CI-only scans** are not in the script (its header comment lists them too): `npm audit` on both workspaces and the Gradle lockfile vulnerability scan (they read a live advisory database, so their result changes overnight without a commit), kubeconform in `k8s-static` (a downloaded checksum-pinned binary), and the Trivy / AppCDS image checks (they need a built image).

## Docs shape

`scripts/check-docs-shape.mjs` is a repo-level node check (built-ins only, self-test `scripts/check-docs-shape.test.mjs`) over `CLAUDE.md`, `AGENTS.md`, `web/CLAUDE.md`, `.claude/docs/**/*.md`, `e2e/README.md`, `e2e/scenarios/README.md` and `api-guidelines/*.md`; it runs in `e2e-static` and `scripts/gates.sh e2e`, beside the budget check, because a Markdown-only PR skips the `server` job.

Its limits (constants at the top of the script, each with its reason): a line outside a code fence at most 600 characters; the text between two headings at most 8,000 bytes (`## Rules` with its `###` children too); no release tag in a heading (`product.md` and `release-history.md` excepted); a doc over 30,000 bytes opens with `## Rules` (`product.md` and `web-internals.md` excepted); no `## To place` heading; `CLAUDE.md`'s table names exactly the on-demand docs; an in-doc anchor names a heading.

The last limit is a section reference (`` `doc.md` "Section" ``) that resolves to a heading of the named doc; enforced (`ENFORCE_REFS`), listed by `--refs`. Limit 9 is a byte ceiling per named doc (`--report` shows the headroom). `release-history.md` has none (a release adds its section there and trims nothing), nor have `testing.md` and `list-endpoints.md` (the always-loaded budget bounds them). A doc at its ceiling first loses what is dead or said twice; a ceiling moves only in a commit of its own that states the sizes and the reason.

**`NOT_YET`** in the script lists the docs that do not pass the first five limits yet: a listed file is skipped by them, a listed file that passes fails ("remove it from NOT_YET") and so does an entry naming no file, so the list only shrinks (the main session edits it when it commits a restructure). A restructure proves its doc with `--only <file>`; other modes: `--report`, `--refs [--into <doc>]`.

## Static analysis

`./gradlew detekt` runs over `core` + `server` (no type resolution) and rides `check`: zero findings, **no baseline file**, seconds, no Docker.

- Repo tuning lives in `config/detekt/detekt.yml` over the bundled defaults; every override carries a one-line comment naming the idiom it protects.
- Fix new findings in code first; extend the config only for a genuinely deliberate idiom, and prefer a config override over `@Suppress` (a per-site `@Suppress` needs a one-line justifying comment).

## Frontend static analysis

The SPA's counterpart, same zero-findings/no-baseline policy; every override in `web/eslint.config.js` carries its idiom comment.

- `cd web && npm run lint`: `eslint-plugin-sonarjs` (recommended set), `eslint-plugin-jsx-a11y` (`flatConfigs.recommended`, the static half of the e2e axe sweep; two file-scoped overrides: the roving `role="grid"` container and the entry pages' `autoFocus`) and generous size/complexity backstops (`cognitive-complexity` 40, `complexity` 35); `web/scripts/*.mjs` are linted too (a separate Node block).
- `cd web && npm run knip` is the dead-code gate (test files count as entries; the generated `src/api/schema.ts` is excluded).

## Running the full stack

`CLAUDE.md` carries the one-liners and the ports of this repo; this section holds the rest.

`docker compose up --build` serves `http://localhost:8086`; local dev is `docker compose up postgres mailpit` (Postgres on host port **5437**) + `./gradlew :server:run` (**8086**) + `cd web && npm run dev` (Vite **5178**), one terminal each.

The compose stack is postgres + mailpit + app only, and bundles **Mailpit** (`http://localhost:8029`) and wires the app's password-reset and MFA email to it (`MAIL_TRANSPORT=smtp`).

Ports deliberately differ across the sibling repos so every stack can run side by side (host ports bind to 127.0.0.1 only):

| Repo | App | Postgres | Mailpit UI | Vite |
|---|---|---|---|---|
| Lettuce | 8080 | 5432 | 8025 | 5173 |
| Toadie | 8081 | 5433 | 8026 | 5174 |
| Covenant | 8082 | 5434 | 8027 | 5175 |
| Flow | 8084 | 5435 | 8028 | 5176 |
| Grenadiers | 8085 | 5436 | – | 5177 |
| **Astrolabe** | **8086** | **5437** | **8029** | **5178** |

### The Jira stub

- A WireMock over `sample-data/jira-stub` (`JIRA_STUB_BASE_URL`), host port **8096** (the table above carries only app, Postgres, Mailpit and Vite ports; Flow's own stubs sat on 8094/8095): the Jira sync's development and test double, served in-JVM by `JiraStubServer` and as **one image** on both stacks.
- Compose: the `jira-stub` service (`astrolabe-jira-stub`, `127.0.0.1:8096:8080`, `mem_limit: 384m` against ~125-165 MiB measured, read-only/non-root/`cap_drop: ALL`, **no `depends_on` from `app`**); `app` gets `JIRA_STUB_BASE_URL=http://jira-stub:8080` (development mode).
- Kubernetes (the OrbStack overlay only): `k8s/local/jira-stub.yaml` (Deployment + Service `jira-stub:8080` + the NetworkPolicy pair `allow-jira-stub-from-app` / `allow-app-egress-to-jira-stub`; the base egress rule excludes every private range, so without the egress rule Test connection fails on Kubernetes while passing on compose).
- ConfigMap keys: `JIRA_STUB_BASE_URL` in the overlay `k8s/local/front-door.yaml`, an OPTIONAL key of the base Deployment (unset in production); the other optional key is `JIRA_TEST_RATE_LIMIT_PER_MINUTE`=30 (the e2e `jira-test` bucket). With the Flow stub's two, the app Deployment reads seven ConfigMap keys, asserted by `k8s-static` as an explicit list by name (`expected` in its front-door step).
- `apply-local.sh` builds `astrolabe-jira-stub:<tag>` (unless `ASTROLABE_SKIP_STUB_BUILD=1`, which `k8s-static` sets); `k8s-static` pins one rendered stub image, no stub in the base `k8s/*.yaml`, no stub key in `k8s/front-door.yaml`. Production refuses the URL (`security.md` "Outbound HTTP calls").

### The Flow stub

- A WireMock over `sample-data/flow-stub`, Flow 1.57.0's `/api/v1/integration/{me,teams}` behind one fake service token (`sample-data/flow/README.md`), host port **8097** (also not a table column): the Flow connection's development and test double in the same two carriers (`FlowStubServer` in-JVM, **one image** on both stacks, the same pinned WireMock tag and digest as the Jira stub).
- Compose: the `flow-stub` service (`astrolabe-flow-stub`, `127.0.0.1:8097:8080`, `mem_limit: 256m` against ~115 MiB RSS measured after boot and a walk of every request shape, read-only/non-root/`cap_drop: ALL`, **no `depends_on` from `app`**). `app` gets `FLOW_INSECURE_ORIGINS=http://flow-stub:8080` (the exact origins a Flow connection may name, development mode only; an EMPTY exported value disables the stub, like the Jira key) and `FLOW_TEST_RATE_LIMIT_PER_MINUTE=30` (the e2e `flow-test` bucket).
- Kubernetes (the OrbStack overlay only): `k8s/local/flow-stub.yaml` (Deployment + Service `flow-stub:8080` + the NetworkPolicy pair `allow-flow-stub-from-app` / `allow-app-egress-to-flow-stub`); `k8s/local/flow-egress.yaml` (`allow-app-egress-to-flow`: the app to namespace `flow`, TCP 8084, a REAL Flow on OrbStack whose origin you add to `FLOW_INSECURE_ORIGINS` in the overlay ConfigMap; harmless when absent); the two ConfigMap keys in `k8s/local/front-door.yaml`, OPTIONAL refs of the base Deployment.
- A real Flow from compose: the `docker-compose.real-flow.yaml` override (joins Flow's network `flow_default`, lists `http://flow-app:8084`; development only, not exercised by CI).
- `apply-local.sh` builds `astrolabe-flow-stub:<tag>` beside the Jira one (same unique tag, so each run resets its scenarios); `k8s-static` pins ONE rendered flow-stub image and one `allow-app-egress-to-flow`, none in the base `k8s/*.yaml`, no Flow key in `k8s/front-door.yaml`. `e2e-static` runs `node --test sample-data/flow/generate.test.mjs`.

### Kubernetes (OrbStack)

- The deployment targets the dedicated `astrolabe` namespace; see `k8s/secret.yaml`'s header for the secret-creation command.
- The image is `astrolabe-app`; a single `app-deployment.yaml` (one process, no worker; `replicas: 1` + `Recreate`) beside postgres. A second replica would be safe but pointless: the sync run's claim is a unique index, not the process, so only one starts each run (`sync.md` "The run registry and the claim").
- `k8s/apply-local.sh` applies the OrbStack overlay `k8s/local/front-door.yaml` (development mode, no proxy) instead of the production-posture base `k8s/front-door.yaml` (`security.md` "The front door").

## AppCDS

Class-data sharing for the app image.

- The Docker build dumps `/app/cds/astrolabe.jsa` from the committed `server/cds/classlist.txt` (~100 MB per image). The `images` job runs `scripts/check-cds-archive.sh astrolabe-app` (`-XX:+PrintSharedArchiveAndExit`, no database): it fails when the archive does not fit the runtime (a changed jar, another JDK, `-XX:-UseCompressedOops`/`ObjectAlignmentInBytes` in `applicationDefaultJvmArgs`) or is not wired, because such an image starts silently WITHOUT the archive.
- `scripts/cds-classlist.mjs` regenerates the class list from a real run in its own throwaway compose project (own ports 8590/5941/8534/8600/8601, own volume), exercising the Jira and Flow paths against stubs of its own; in a worktree pass `--image`, `--stub-image` and `--flow-stub-image`. It refuses to overwrite the list from an unhealthy run and waits (up to about 120 s, else non-zero) for a `GET /api/v1/telemetry/current` sample after the workload, or the telemetry classes would drop out of the list.
- Regenerate the list whenever the class set changes materially (`CdsClassListTest` guards drift).
