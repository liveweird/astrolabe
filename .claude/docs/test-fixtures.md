### Test fixtures and harness internals

The binding one-line rules are in `testing.md`; this file is the reference behind them. v0.1.0 has the harness, the OpenAPI conformance layer, the fork warm-up and the
watchdogs — Flow's domain fixtures (the Jira/GitLab stubs, the synced and derived fixtures, the normalized-layer sweep) were not ported. When a planning increment adds
a shared fixture, its rules (warm in a `@BeforeClass`, read-only vs clone, the guard test) are added here in the same commit.

**Runtime OpenAPI conformance.** Every `/api/` interaction the server test suite produces is
validated against `documentation.yaml` by the `OpenApiConformance` Ktor client plugin
(`server/src/test/kotlin/OpenApiConformance.kt`), installed via the shared test-client defaults —
so `jsonClient()`/`authedClient()` traffic is checked automatically and drift (undeclared
endpoint/method/status, response-schema or content-type mismatch) fails the exercising test with
the validation report. Response side is fully validated; request-side validation is ignored except
unknown-path/method (tests deliberately send malformed payloads and missing tokens). The spec is
fed to the validator relabeled 3.0.3 in memory (swagger-request-validator's 3.1 support is
unreliable); `OpenApiSpecTest` pins that the document stays 3.0-compatible (use `nullable:`, never
`type: [..., "null"]`) plus static invariants (unique operationIds, 401/500 declared, paths under
`/api/v1/`). `-Dopenapi.conformance=warn|off` relaxes enforcement for drift triage only (default
`fail`). A coverage report (exercised vs. declared operation/status pairs) is written to
`server/build/reports/openapi-conformance/coverage.md` after each test run, and it is a GATE: the
sibling `gaps.txt` lists every declared (operation, status) pair the suite never produced — minus
the cross-cutting statuses a shared plugin answers for every route alike and one test pins each
(`400` malformed id/body, `401`, `413`, `415`, `429`) and `500`/`default`, which the public API
offers no honest way to force — and `server/build.gradle.kts` fails the `test` task on a
non-empty file whenever the WHOLE suite ran (a `--tests` filter skips the gate). The gate is
**fork-safe**: each test JVM writes its own `exercised-<pid>-<uuid>.txt` and re-merges every fork's file
under a file lock into the ONE `coverage.md` + `gaps.txt` (`OpenApiCoverageMerge`, pinned by
`OpenApiCoverageMergeTest` — a pair exercised by ANY fork is covered, so the last fork to exit
leaves the complete union), and the `test` task clears the directory first so stale per-fork files
never leak in; a whole-suite run that leaves NO `gaps.txt` fails the gate too. A new operation
therefore lands with a test per declared status, or with its status list trimmed to what the
route can actually answer (`CoverageGapsTest` pins the cross-cutting statuses). `413` is declared on EVERY operation that takes a request body
(`OpenApiSpecTest` pins it) but is never a per-operation test — the one `PayloadValidationTest` case covers the shared
limit. Tests that use
`testApplication`'s default `client` bypass the plugin — prefer `jsonClient()`.

**Schemathesis (optional manual fuzz pass, not in CI).** Property-based fuzzing of the running
stack from the spec: `docker compose up --build` (compose ships dev mode, so `/openapi` is
exposed), grab a token —
`TOKEN=$(curl -s -X POST localhost:8086/api/v1/login -H 'Content-Type: application/json' -d '{"email":"admin@astrolabe.local","password":"changeme"}' | jq -r .token)`
— then
`uvx schemathesis run -c all -H "Authorization: Bearer $TOKEN" --exclude-path /api/v1/logout http://localhost:8086/openapi/documentation.yaml --url http://localhost:8086`.
The `/logout` exclusion is load-bearing: fuzzing it **revokes the bearer token** (everything after
401s). Login fuzzing also trips the per-account lockout for `admin@astrolabe.local` (the spec's
example email) — in-memory, so `docker compose restart app` clears it. Expect residual noise from
stateful invariants the spec cannot express (rate-limit 429s, TRACE probes); a **`Server error`
count above zero is the real signal**. It complements, not replaces, the suite-piggybacked
conformance layer above; fuzz junk lives only in the compose volume (`docker compose down -v`
resets). Needs `uv` (or `pipx`); no Python dependency lives in the repo.
**E2E scenarios (design artifacts).** The Playwright suite in `e2e/` is governed by
`e2e/README.md` (run recipes, the parallel state-ownership rulebook, the coverage map). Every spec
has a **natural-language scenario file** in `e2e/scenarios/` — versioned, deliberately
non-executable design artifacts (actors, owned state, numbered user-level steps, expected
outcomes; `## Scenario:` headings equal the `test()` titles verbatim). `e2e/scenarios/README.md`
holds the format and the **compiler contract** — the house rules any human/agent/tool must
satisfy when turning a scenario into spec code. Same-commit rule: a new or behaviorally changed
test lands with its scenario file and its one-line entry in the e2e README's coverage map;
`cd e2e && npm run check:scenarios` enforces the parity mechanically (both directions, orphan
files included), and `npm run typecheck` covers what Playwright's transpile-only TS handling
never checks. CI also runs `cd e2e && npm run test:setup`; the setup tests cover reuse of a
healthy stack, startup of the unavailable default stack, and the invariant that services and
volumes remain intact. E2E global setup reuses a healthy stack, starts the default stack when
unavailable, and leaves services and volumes intact. (Flow's shared read-only synced fixture, exported to the workers as `E2E_SHARED_*`, is not ported; the planning increments add a deterministic dataset and its own fixture rules here — `e2e/README.md` "Parallel execution".)
**The e2e dependency world (`e2e-dep-*`, `e2e/tests/dependencies.spec.ts`).** Seeded per test through the admin API (the `project-view.spec.ts` helpers, copied): a project OWNER login (the person who owns the program, so both projects) and a team MANAGER login (owning nothing), a team the manager manages, a login-less lead's work stream, one program, and two projects A and B with one milestone each — `a1` (A) scheduled 2027-02-01..05 and `b1` (B) 2027-02-08..12, so `a1 -FS-> b1` with no lag holds (b1 starts the working day after a1 ends) and moving b1 to 2027-01-25..29 is `Violated · 10 working days short`. The second scenario creates the link through `POST /projects/{B}/dependencies` as the admin; the first creates it through the dialog. Teardown deletes the projects first (their milestones and links cascade), then program, stream, team, people, users (`deleteViaApi`, reverse creation order). `accessibility.spec.ts`'s fixture adds a second project `e2e-axe-linked` with one milestone scheduled 2026-03-02..06 and a violated FS link into the fixture project's scheduled milestone (2026-02-09..), so the project-view scan covers the table, the red badge, the ghost row and the arrow, plus the dependency dialog scan.

**The e2e team-view world (`e2e-tv-*`, `e2e/tests/team-view.spec.ts`).** The same seeding as the project view's (the helpers copied): a project OWNER login, a team MANAGER login (owning nothing), a team the manager manages, a login-less lead's work stream and program, one project owned by the owner, and two milestones of the team (`e2e-tv-ms-a-*`, `e2e-tv-ms-b-*`). The capacity scenario creates its one period through the dialog (a WEDNESDAY, 2027-02-03, 8 MD/week, WIP limit 1) and schedules through the UI; the order and read-only scenarios schedule through the API with the TEAM view's plan revision. Teardown deletes the project first (the milestones and the team's order rows go with it), then program, stream, team (its capacity periods go with it), people, users. `accessibility.spec.ts`'s fixture team carries one capacity period (from 2026-02-02, 0.5 MD/week, WIP limit 1): the fixture's two overlapping milestones then make the team page's strip show the overload column AND the dashed WIP chip, the orange and red facts badges and the expanded weekly table in both schemes.

**The auto-proposal's server tests (v0.8).** No shared helper was added: `ScheduleKernelsTest` is pure (hand-built `ScheduleInputs`, no DB, no `TestPlan`), `ScheduleProposalTest` and `TeamScheduleBatchTest` build their worlds from `planWorld(prefix, teams = true)` + `TestPlan.milestone`/`schedule`/`capacityPeriod`/`teamOrder` and keep their request helpers (`propose`, `batch`, `datesOf`, `scheduleRevisionOf`) private; the v0.9 scope check adds `ScheduleScopeTest` (pure: hand-built `TeamScheduleItem`/`PlanMilestoneFact`/`PlanLinkFact`, shuffled inputs, one change per kind) and `TeamScheduleScopeTest` (a world with a foreign milestone and project predecessor, an in-progress and unscheduled team milestones, a `proposal()` + `accept()` pair, then one change after the proposal per case: `TestPlan.capacityPeriod`/`teamOrder`/`dependency`/`schedule`, `TestHolidays.with`, the ranking PUT); the proposal's fixed-date vectors sit in 2027.

**The e2e holiday and chain worlds (`e2e/tests/public-holidays.spec.ts`, `critical-path.spec.ts`).** Holidays are global, so each year belongs to one spec: `public-holidays` writes holidays in **2040 only** (a sweep by date before its first test and in its afterAll; its calendar test seeds a project pair there: `a1` 2040-01-30..02-03 -FS-> `b1` 2040-02-06..10, then a holiday on the Monday 2040-02-06 turns "needs 2040-02-06" into "needs 2040-02-07"), `critical-path` seeds in **2041**, which no spec writes holidays in: three projects X, Y, P under one OWNER login, `x1` (2041-01-07..11) -FS-> `y1` (01-14..18) -FS-> `p1` (01-21..25) in P plus an unlinked `p2` (01-07..11) in P. On P's page `y1` is a ghost row (slack 0), `p1` is 0, `p2` is 10 working days, the Critical chain lists only `x1` (hops 2: a member beyond the ghost rows; never filter by hops) and week 2 is a 5-working-day idle gap (P's, and its team's: P's milestones are on their own team). `accessibility.spec.ts`'s fixture adds a chain project (`c0` 2026-01-26..30 -> `c1` 2026-02-02..06 -> the fixture milestone) so the toggle-on scan has zero-slack links.

**The e2e schedule-proposal world (`e2e-sp-*`, `e2e/tests/schedule-proposal.spec.ts`).** Year **2042** (no spec writes a holiday there). Seeded per test through the admin API (the team-view helpers, copied): a project OWNER login, a team MANAGER login, a team whose FIRST capacity period starts Monday 2042-01-06 (10 MD/week, WIP limit 2; the real clock is the proposal's `asOf`, but nothing can land before the first day with capacity, so the dates do not depend on today), and `a` 4 MD and `b` 6 MD unscheduled, `c` 2 MD at 2042-03-03..04, link `b -FS-> c`. The proposal: `b` 2042-01-06..13 (hoisted ahead of `c`), `a` 01-06..09, `c` 01-14..15 (34 working days earlier); the proposed week of 01-06 loads 9 of 10. `accessibility.spec.ts` seeds a second 2042 pair (`e2e-axe-prop-*`: two moves, one link the proposal would violate, one it resolves) in its own describe (and a second copy of it in the detail-pages block, for the hovered-row scan), so the fixture team's page does not stretch to 2042. The table's hover tint is theme-owned and AA-pinned (`web/src/theme.test.ts`); the axe cases hover a row on purpose, including the row whose Links cell reads "would violate".

**Fork warm-up (every `-Pforks`).** The first class of a JVM pays the container, Flyway and the first
Ktor boot, and when it runs in `testApplication` that is inside the hard 60 s limit. `ForkWarmup.kt` moves it into a
`@BeforeClass` (JUnit 4 does not time it): `ForkWarmup.warm()` migrates the container (`ensureMigrated()`), boots the app
once via `TestApplication { configureApp() }` and throws it away (marker `app-boot`); `ForkWarmup.assertWarm()` is the
one test of each `ForkWarmup<k>Test`. There are two such classes (`ForkWarmup1Test`, `ForkWarmup2Test`, one per
`-Pforks` value 1..2) because Gradle deals one class FILE to one fork and collapses a repeated class name, while
`TestClassNamingTest` allows one concrete `*Test` class per file and forbids an abstract `*Test` base. (Flow had eight, for `-Pforks` up to 8; re-add
`ForkWarmup3Test`.. and raise `MAX_FORKS` together if the suite ever needs more forks.) The `testClassesDirs`
Callable in `server/build.gradle.kts` puts `ForkWarmup1Test`..`ForkWarmup<forks>Test` at positions `0..forks-1` (one file tree each), so Gradle's round-robin
deal (position `p` goes to fork `p % forks`, all up front, no work stealing) gives fork k its own `ForkWarmup<k>Test` as the first class it runs; the surplus
warm-up classes stay out of the run through `exclude(FORK_WARMUP_GLOB)`. The Callable never throws: before `compileTestKotlin` ran, or while the compiled tree is stale
and lacks a needed `ForkWarmup<k>Test.class`, it returns the plain dirs (so `--dry-run` works) and is evaluated again at execution; the test task's `doFirst`, after the
compile, then fails a run whose class is still missing (naming the file; "run clean" if the source exists). Not covered: a `--tests` run drops every
warm-up class (no test in it matches), and a failed-first rerun (`RunPreviousFailedFirst`) may open a fork with another
class; both still open cold, which is fine for a focused run. The **tripwire** (`ForkWarmupLedger`, next to the stall
watchdog in `server/build.gradle.kts`) records each JVM's first class and the result of every `ForkWarmup*Test`; a FULL run
(the OpenAPI gate's condition: no `--tests`) fails unless exactly `ForkWarmup1..forksTest` ran SUCCESSFULLY in `forks`
distinct JVMs, and only warns about a JVM whose first class was not its warm-up. If the previous run's warm-up class failed, Gradle runs failed classes first and can deal two
warm-ups to one fork, so the distinct-JVM check can fire once on that rerun: rerun. It guards the Gradle-internals assumptions (round-robin dealing, in-order forwarding,
class-name dedupe). The throwaway boot runs `Bootstrap` on a fresh database before any test: no test may assume it is the fork's first boot.

**Fork balancing (not ported).** Flow weight-balanced the class order from a measured `server/test-weights.tsv` (`balancedCandidateOrder`: classes sorted by weight, dealt greedily to the
least loaded fork) once `-Pforks=2` paid. Astrolabe's suite is small and runs one fork by default; port the technique when `server-tests` outgrows its budget (`BACKLOG.md`).

**Coverage gates.** Backend Kover enforces line- and branch-coverage floors in
`server/build.gradle.kts` (the `minBound` line/branch floors, wired into `check` via
`koverVerify`). The measurement EXCLUDES classes annotated `@kotlinx.serialization.Serializable`
(`kover.reports.filters`): kotlinx-serialization synthesizes one branch per optional property in a
data class's generated constructor and serializer — noise no test can exercise; behavior never
lives in a wire shape (services, validators and a DTO's companion object stay measured). The
floors sit just below current actuals — the convention is to **re-measure and raise** them as
coverage improves, never to lower them for new code: `check` runs only `koverVerify`, so run
`./gradlew :server:koverXmlReport` for fresh actuals. Every fork's Kover agent writes into the one shared `test.ic` (if CI ever flakes on Kover, fall back to `-Pforks=1`).
Kover costs roughly a tenth of the test wall and stays on everywhere `check` runs — the floors are a gate. There is **no
Gradle property to switch it off**; for a timing run or a tight dev loop over `:server:test` alone, temporarily add
`kover { currentProject { instrumentation { disabledForTestTasks.add("test") } } }` to `server/build.gradle.kts` and never commit
it (no `test.ic` is written, so `koverVerify` would have nothing to check). The v0.1.0 floors are the first measured values and are re-baselined after the release (`BACKLOG.md`). Frontend vitest enforces thresholds in
`web/vite.config.ts` (`test.coverage.thresholds`, same re-measure convention — the current
actuals are noted in a comment beside them); run `cd web && npm run test:coverage`.

**Server test setup and forks.**

Backend tests live flat in `server/src/test/kotlin/` (kotlin.test + `io.ktor.server.testing.testApplication`)
and override the `postgres.*` config keys via `MapApplicationConfig` to point at a Testcontainers
`PostgreSQLContainer("postgres:18.6-alpine@sha256:77f58511…")` (the same digest `docker-compose.yaml` and
`k8s/postgres-deployment.yaml` pin — `PostgresImagePinTest`) started lazily by `PostgresTestSupport` and **shared
across the whole suite within a JVM fork** (one container per fork; test-side direct database access, `sharedDatabaseForTests()`, goes through a small
r2dbc-pool built by production's own `connectPooledDatabase` — an unpooled connect paid ~4 ms of backend
setup per transaction). Running tests requires a working Docker daemon (Docker Desktop,
OrbStack, etc. — with OrbStack and no `/var/run/docker.sock`, export
`DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`). The container runs **all** Flyway
migrations, so the V3 seed admin (`admin@astrolabe.local`) is present — tests scope their assertions
with unique prefixes/filters (`uniqueEmail("marker")`) rather than asserting absolute counts.

**Parallel forks (`-Pforks=N`).** `server/build.gradle.kts` sets `maxParallelForks` from the `forks` Gradle
property (an integer 1..2, anything else fails any build that runs the `test` task; default 1 = one JVM, which is also CI's setting; `forkEvery` is deliberately unset). Each fork is its own
JVM, so it starts its OWN Testcontainers Postgres (`PostgresTestSupport` is a per-JVM `object`) and holds its own
fixture singletons — every "shared suite" rule in this doc
(`withSoloAdmins`, `restoreSeedAccounts`, the seed admin) therefore holds per fork, never across forks; a test must never assume another class ran before it
on the same JVM, or that a class ran at all in this one. Gradle hands whole CLASSES to forks in whatever order it
likes, so **class order is not a contract**: any class may be the first thing a fork runs after the fork's pinned
`ForkWarmup<k>Test` (a `--tests` run or a failed-first rerun has no such pin and opens cold). The container is migrated by `PostgresTestSupport` itself the moment it starts (a `Flyway.migrate()`
in its lazy init, the same call as `infra/db/Flyway.kt`), so a fixture or raw-JDBC helper never needs its own
"has Flyway run yet?" guard (`PostgresTestSupport.ensureMigrated()` is the explicit spelling). The OpenAPI gate above
merges the forks' coverage.

**Stall watchdog (`-PtestStallMinutes=N`).** Why: on 2026-10-17 (CI run 39062260538) a hung test left the `server` job silent until the
25-minute timeout cancelled it, and a cancelled job uploads no `server-reports` artifact, so there was no evidence. `TestStallWatchdog` (top of the `test`
task's section in `server/build.gradle.kts`) is a Test-task listener that tracks, per test JVM (the "Gradle Test Executor N" suite in a descriptor's parent chain),
the time of the last suite/test start or finish. An executor that has started, not finished and been quiet for the threshold gets (1) `jcmd <pid> Thread.print -l`
(the `jcmd` of the test task's `javaLauncher`; the worker pid is found among Gradle's descendants by its command line, which ends in `'Gradle Test Executor N'`)
written to `server/build/reports/hung-tests/Gradle-Test-Executor-N-<yyyyMMdd-HHmmss>.txt` and logged at ERROR with the class/test in flight, then (2) its
JVM is destroyed, so the task fails ("Process 'Gradle Test Executor N' finished with non-zero exit value 137") once the other forks have run their
queues, instead of at the CI job timeout (`jcmd` itself is bounded at 30 s, so a worker too wedged to attach to is still killed). The
directory is cleared at the start of each run; CI uploads `server/build/reports` with the `server-reports` artifact when the job is not cancelled, and the
dump is in the log either way. `-PtestStallMinutes` is an integer 1..60 (default `DEFAULT_TEST_STALL_MINUTES` = 5; the measurement behind it - carried over from Flow, re-measured at v0.1.0 - is in the comment on the constant); every executor also logs `test watchdog: … longest quiet gap N s (in flight: …)` when it finishes, which
is the number to re-measure the default from. The quiet gap is a single test's run time or a class's `@BeforeClass` fixture warm-up, nothing else.
The matching source-side bound: every raw JDBC connection a test opens comes from `PostgresTestSupport.connect()` (pgjdbc `connectTimeout`/`loginTimeout` 30 s,
`socketTimeout` 180 s, `tcpKeepAlive`), never a bare `DriverManager.getConnection`: a call parked in a socket read cannot be cancelled, and the 180 s bound is
above any legitimate statement (a lock wait behind another transaction) and below the watchdog, so one half-dead connection fails ITS test with a stack trace.
**The `TestEnvironment.kt` harness** — use it instead of hand-rolling setup:

- `configureApp(vararg overrides)` (on `TestApplicationBuilder`, so `ForkWarmup.warm()` can use it outside `testApplication`) points the app at the shared container (with CSRF off)
  WITHOUT starting it — tests that assert startup behavior (the fail-closed checks) add their
  overrides and call `startApplication()` themselves; `usePostgresTestcontainer()` is the
  configure-and-start shorthand. It sets `mail.appUrl` to `https://localhost:8086` (the origin the emailed reset link is built
  from, validated at boot in every mode - so `https`, which the production-mode boot tests, reusing this config, also accept); a test
  that wants the blank-origin 503 or a malformed origin overrides it.
  It sets `telemetry.enabled` to `false` (the sampler would write a process row and samples into the shared database from every booted app):
  the telemetry tests (`TelemetrySamplerTest`, `TelemetryStoreTest`) build the sampler directly over `TelemetryFixtures.kt`'s helpers and empty `ops`
  before each test (`wipeTelemetry`; nothing else writes there); a test that wants the real sampler opts in with `"telemetry.enabled" to "true"` plus
  `TelemetryOverridesKey` (a fixed identity, an immediate first tick).
- `ForkWarmup.warm()` / `ForkWarmup.assertWarm()` (`ForkWarmup.kt`): the fork's untimed Postgres + first-boot warm-up, called only by the `ForkWarmup<k>Test` classes; no other test calls it.
- Password-reset fixtures: `newPasswordResetService(ttlMillis, clock)` builds a `PasswordResetService` over the shared database (an
  injected clock for expiry), `issueToken(userId, revision, email)` unwraps its `IssueOutcome` to the emailed token (null when stale
  or capped), and `resetTokenHashes(userId)` lists the stored digests (the table never holds a raw token).
- `jsonClient()` / `authedClient(email, password)` — the standard HTTP clients; both go through
  the shared test-client defaults (JSON + `application/problem+json` negotiation + the
  `OpenApiConformance` plugin), and `authedClient` logs in and attaches the bearer on every
  request.
- `LogCapture(loggerName)` + `hasKeyValue` — a Logback `ListAppender` for asserting the audit
  trail (`ch.nokillswit.audit`); `awaitEvent` polls for asynchronously produced events. Detach in
  a finally.
- `TestUsers.seed(email, password, name, role)` (bcrypt cost 4 for speed; defaults to ADMIN — pass
  `UserRole.USER` for a non-privileged caller) — every seeded user funnels through
  `UserService.create`, so they carry the inverted-default MFA-disabled row and log in
  single-step and `TestUsers.softDelete(id)` (direct table update, bypassing the delete endpoint's
  guards) and `TestUsers.withSoloAdmins(ids) { }` (temporarily parks every other active admin —
  the last-admin-protection pin). `seededClient(prefix, role)` is the one-line seed+login
  fixture.
- `postJson`/`putJson` (the JSON body ceremony) + `HttpClient.login` (the raw login POST),
  `withAuditCapture { }` (attach/detach on the audit logger), `withSeedRestored { }` and
  `assertStartupFails(part) { }` for bootstrap/fail-closed tests — use these instead of re-rolling
  the blocks they replaced.
- **Many failed logins → seeded accounts.** A login for an UNKNOWN email pays a discarded cost-12 bcrypt
  verify (the timing equalizer, ~225 ms locally); a test that needs a dozen failures (rate limit,
  proxy trust) logs in as freshly seeded accounts (`TestUsers.seed`, cost 4) with a wrong password —
  the same 401 path at ~1 ms; soft-delete them afterwards.
- `TestTeams.seed(name)` — a fresh team fixture; `TestPeople.seed(name, userId?, email?)` a person (optionally linked to a login; `softDelete`, `rawRows`); beside them, raw-row readers for what
  the API hides (`TestTeams.rawRows`, `TestUsers.stampPasswordChangedAt`). `PersonMigrationTest` builds a scratch database, migrates it to V9, seeds data and applies V10 (the pattern for any data-rewriting migration; the shared container only migrates an empty database). Shared
  suite state (the seed admin) is never mutated destructively — tests mint UNIQUE rows and remove
  their own.
- **Plan fixtures** (`PlanFixtures.kt`, v0.2.0): `planName(prefix)` (work stream and program names are GLOBALLY unique among active rows, and the plan tables are shared suite state — always a unique name),
  `planCaller(prefix, role, withPerson)` (a seeded user, optionally with a linked ACTIVE person, and its logged-in client), `planWorld(prefix)` (one stream → program → project chain, each owned by its own
  person, plus the callers ADMIN / the three owners / a stranger / a person-less login / a `ROADMAP_EDITOR`: the authorization matrix's cast) and `TestPlan` (`workStream`/`program`/`project` seeding through the
  services, so the plan lock and revision bump apply; `revision()` and `scalar(sql)` over raw JDBC). The plan-lock barrier tests (`PlanStateTest`, `RoadmapRankingTest`) hold `plan_state FOR UPDATE` on a raw session and use
  `awaitLockWait("plan_state")` (`waiters = 2` when two requests race for the lock); `requestHeldAtPlanLock(request) { raw -> … }` + `Connection.exec` are the "change something while the request waits at the lock" scaffold
  of the re-guard tests. **Milestone fixtures** (V14): `planWorld(prefix, teams = true)` adds `PlanTeams` (`w.requireTeams()`: `teamId` managed by `manager`, `otherTeamId` managed by `otherManager` — both `PlanCaller`s, a login with a linked person —
and nobody on the plan chain), `TestPlan.milestone(projectId, teamId, name, estimate)` and `TestPlan.schedule(id, start, end)` (through `MilestoneService`, past the guard, the lock and the bump applying; `schedule` expects the current revision and
answers the revision it left behind), and `TestTeams.seed(name, managerPersonId?)`. `DecimalColumnTest` is the `NUMERIC(8,2)` binding spike. A held-request test for the schedule guard mutates the TEAM (`UPDATE teams SET manager_person_id = NULL`), the MILESTONE
(`UPDATE milestones SET team_id = …`) or the manager's PERSON (`UPDATE people SET user_id = …`) inside `requestHeldAtPlanLock`; the team-row lock wait is `awaitLockWait("FOR SHARE")` with a raw session holding `teams … FOR NO KEY UPDATE`. The ranking is shared state too: `RoadmapRankingTest` starts every test with a wholesale PUT of its own list, so its raw-table assertions are exact.
  **Dependency fixtures** (V15, `PlanFixtures.kt`): `milestoneRef(id)` / `projectRef(id)` (an `EndpointRef`), `HttpClient.postDependency(projectId, predecessor, successor, type, lagDays)` (the SUCCESSOR must be that project or one of its milestones),
  `secondProject(w)` (a project under the world's program owned by a NEW person-linked caller, `SecondProject.owner`: the cross-owner cases — the predecessor's owner is `w.projectOwner`, the successor's `second.owner`) and `TestPlan.dependency(predecessor, successor, type, lag)`
  (through `DependencyService.create` past the guard, the plan lock, cycle check and bump applying; the path project is derived from the successor). The graph is shared state: a test that creates a link soft-deletes or abandons it with its own throwaway world, and
  `DependencyLifecycleTest` soft-deletes its raw constraint-test rows so no stray active link reaches the cycle check of another test.
  **Capacity fixtures** (V16, `PlanFixtures.kt`): `TestPlan.capacityPeriod(teamId, effectiveFrom, mdPerWeek, wipLimit = null)` (an ISO date, ANY weekday; through `TeamCapacityService.create` past the guard — the team row lock and the partial index apply, the plan revision does not move, capacity being team data). The
  held-request cases hold the TEAM row `FOR NO KEY UPDATE` on a raw session (`TeamCapacityLifecycleTest.requestHeldAtTeamLock`, `awaitLockWait("FOR NO KEY UPDATE")`) — the capacity twin of `requestHeldAtPlanLock`.
  **Team-order fixtures** (V17, `PlanFixtures.kt`): `TestPlan.teamOrder(teamId, ids)` (through `TeamOrderService.replaceOrder` past the guard — the plan lock and bump apply; the current plan revision is always a valid `expectedRevision`; answers the revision it left), `HttpClient.putTeamOrder(teamId, expectedRevision, ids)` (the typed `PUT /teams/{id}/milestone-order`),
  and raw reads: `TestPlan.teamOrderRows(teamId)` (position, milestone id), `teamOrderIds(teamId)` and `teamOrderRevision(teamId)` (null = never written). The held-request case uses `requestHeldAtPlanLock` with `UPDATE teams SET manager_person_id = NULL`. Orders are per team and tests mint unique teams (`planWorld(prefix, teams = true)`), so assertions on the raw rows are exact
  without touching shared state — except the ranking, which a test that rewrites it (the "ranking PUT leaves the override" case) replaces wholesale, as `RoadmapRankingTest` does.
  **Holiday fixtures** (V19, `TestHolidays.kt`): the `public_holidays` table is GLOBAL shared state and starts EMPTY (no seed), so a test that needs a holiday on a day adds it for the duration of `TestHolidays.with(date, name) { }` (create through `PublicHolidayService` -> block -> `remove` in a `finally`; each write is a plan write and bumps the plan revision, harmless to a test that reads the revision it needs), `TestHolidays.remove(id)` (a `finally` cleanup that tolerates a row the test already deleted through the API), `dates()` and `clearYear(year)`. The dictionary's own tests own far-off years — `PublicHolidayTest` 2085-2089, `HolidayPresetTest` 2090-2095 — so they can never move a figure another class pins in 2026-2027. The view and schedule tests (C3) add holidays on ordinary 2026/27 dates inside `TestHolidays.with { }` only (classes run sequentially per fork, and the cleanup runs `NonCancellable`, so a cancelled test cannot leak a row).
- `TestSeedState.restoreSeedAccounts()` — bootstrap/production-mode tests rotate the seed admin's
  password in the SHARED container; call this afterwards so later tests (and re-runs) see the
  pristine V3 state. Production-mode boots must also override `"mail.transport" to "disabled"` —
  the dev-default `log` transport is refused in production (`MailTransportTest`) — and
  `"security.encryption.key" to strongEncryptionKey()` — the dev-default data-encryption key is
  burned (`CryptoBootTest`); the checks fire in module order (JWT → mail → crypto → seed
  passwords), so a test asserting a later check must satisfy every earlier one.

**Frontend test internals** (moved from `testing.md`; the binding rules stay there).

**Frontend tests.** Vitest + happy-dom + Testing Library, **co-located** next to the source
(`Foo.test.tsx` beside `Foo.tsx`). `src/test/setup.ts` imports `../i18n` and forces `en`, so text
assertions match the English resources; `src/test/render.tsx` is the shared wrapper and — like
every file-local `MantineProvider` — must pass **`env="test"`** (since Mantine 9.4 the
Popover/Combobox dropdown is `display: none` until Floating UI sees a real bounding box, which
never happens in happy-dom, so Select-option clicks silently fail without it). `src/test/http.ts`
holds the fetch-stubbing helpers. The shared setup also forces the reduced-motion media query and
makes every Mantine test provider honor it: `Transition` invokes its animation hook even with
`env="test"`, so synchronous reduced-motion transitions prevent callbacks from outliving happy-dom
teardown. Other media queries retain their normal behavior; the application theme is unchanged.
`setup.ts` also raises testing-library's `asyncUtilTimeout` to 4 s (and `vite.config.ts` the `testTimeout` to 10 s): the
module registry is cleared per file, so the first test of a shuffled file to touch a lazy chunk pays its cold
import, which exceeds the 1 s `findBy`/`waitFor` default on a contended machine. A lazy read is still always awaited
(`findBy…`/`waitFor`) — a synchronous `getBy…` after the page's own controls appear is the bug, not the timeout. To
reproduce shuffle flakes run several `npx vitest run --sequence.shuffle --sequence.seed=N src/pages src/components`
in parallel (a quiet single run hides them).

**The suite runs with `isolate: false`** (`web/vite.config.ts` — a worker reuses its module registry and
globals across files; re-measure the gain at v0.1.0). Vitest already scopes `vi.mock`
registrations per test file; what carries over is the EVALUATED `src/` modules, so `setup.ts` calls
`vi.resetModules()` before every file (npm packages stay cached) and each file's own mocks apply. Tests must not assume anything an earlier test left
behind — await lazy chunks (`findBy…`/`waitFor`, never a synchronous `getBy…` right after the first
data assertion), reset module-level state in `afterEach`, and unstub globals/timers a test installed. The
proof is `cd web && npx vitest run --sequence.shuffle` (run it a few times after adding a test); a test
that only passes in file order is the bug, not the config.
