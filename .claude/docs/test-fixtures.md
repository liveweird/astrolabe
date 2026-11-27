# Test fixtures and harness internals

Owns: the server test harness and fixtures, the fork machinery (warm-up, balancing, stall watchdog), the OpenAPI conformance internals, the coverage floors, the frontend test internals and the e2e worlds. Not here: the binding one-line rules (`testing.md`); the Playwright recipes and coverage map (`e2e/README.md`); the scenario format (`e2e/scenarios/README.md`); the stubs' datasets (`sample-data/jira/README.md`, `sample-data/flow/README.md`); the stub ports (`ci.md` "Running the full stack"); build and gate times (`build-times.md`).

## Rules

`testing.md` states the one-line rules of the harness (the harness over hand-rolled setup, `jsonClient()`/`authedClient()` for `/api/`, raw JDBC from `PostgresTestSupport.connect()`, fork warm-up and the stall kill, OpenAPI conformance, the coverage floors, `env="test"` and `isolate: false`, the e2e same-commit rule); they are not repeated here. This doc adds:

- A new shared fixture adds its rules here in the same commit: warm in a `@BeforeClass`, read-only vs clone, the guard test.
- **One container per fork, so every "shared suite" rule holds per fork, never across forks.** A test must never assume another class ran before it on the same JVM, or that a class ran at all: a test that only passes in alphabetical order is the bug.
- **Tests mint UNIQUE rows and remove their own.** Scope assertions by prefix (`uniqueEmail("marker")`, `planName(prefix)`), never assert absolute counts, and never mutate the shared suite state (the seed admin) destructively.
- A production-mode boot overrides `"mail.transport" to "disabled"` (the dev-default `log` transport is refused in production, `MailTransportTest`) and `"security.encryption.key" to strongEncryptionKey()` (the dev-default key is burned, `CryptoBootTest`); the checks fire in module order (JWT, mail, crypto, seed passwords), so a test asserting a later check satisfies every earlier one. It calls `TestSeedState.restoreSeedAccounts()` afterwards.
- **Global tables.** Work stream and program names are globally unique among active rows. Holidays are global and start empty: a test adds one inside `TestHolidays.with { }` only. Baselines count toward the cap of 100: a test that takes one removes it in a `finally`. The ranking and the dependency graph are shared: a test that links or ranks cleans up with its own throwaway world.
  `saved_schedule_proposals` holds the newest 20 and ANY save evicts the oldest: only `SavedProposal*Test` and one `PlanStateTest` case touch it (classes run one after another in a fork), a test that counts or fills it empties it first, and saves are 10 a minute per login (`callerPool`).
- **Stubs.** A test class that touches a stub calls that fixture's `warm()` in a `@BeforeClass` (`StubWarmupGuardTest`). The stubs take a dynamic port, never a fixed one (`StubPortGuardTest`). A test that flips a scenario MUST `resetScenarios()` in a `finally`: the server is shared by every class in the fork.
- A run is awaited through `SyncRunner.await(runId)`, a request parked at a lock through `requestHeldAtPlanLock`/`awaitLockWait(...)`, never by sleeping.
- An observable with no signal (a stub's request journal) is waited on with `awaitUntil(what) { … }` (`TestAwait.kt`, a bounded poll). `TestSleepGuardTest` fails a new `Thread.sleep(`/`delay(` outside its allow-list, which only shrinks.
- Only the `ForkWarmup<k>Test` classes call `ForkWarmup.warm()`; no test may assume it is the fork's first boot.
- **Scale tests** assert a LOOSE tripwire and print `scale-figure`, never `fixture-cost`.
- **E2E.** Global setup starts nothing: it requires a stack named by the four `E2E_*` variables (none assumed; no host URL under `e2e/`).
- **E2E worlds.** Each spec seeds its own `e2e-<area>-*` rows through the admin API, removes them in reverse creation order, asserts a plan-wide number as present and never as a value, and writes holidays only in a far-off year no other spec writes them in (holidays are global). A stub scenario is flipped by one spec or serialised by a Playwright lock.

## The harness

### The suite and its forks

Backend tests live flat in `server/src/test/kotlin/` against a Testcontainers `PostgreSQLContainer("postgres:18.7-alpine@sha256:0115267a…")` (the digest `docker-compose.yaml` and `k8s/postgres-deployment.yaml` pin: `PostgresImagePinTest`), started lazily by `PostgresTestSupport` and shared across the whole suite within a JVM fork. Docker, the seed admin and the unique-prefix rule: `testing.md`.

- `sharedDatabaseForTests()` goes through a small r2dbc-pool built by production's own `connectPooledDatabase`: an unpooled connect paid ~4 ms of backend setup per transaction.
- `PostgresTestSupport` migrates the container the moment it starts (a `Flyway.migrate()` in its lazy init, the same call as `infra/db/Flyway.kt`; `ensureMigrated()` is the explicit spelling).
- Every raw JDBC connection comes from `PostgresTestSupport.connect()` (pgjdbc `connectTimeout`/`loginTimeout` 30 s, `socketTimeout` 180 s, `tcpKeepAlive`): a call parked in a socket read cannot be cancelled, and the 180 s bound is above any legitimate statement (a lock wait behind another transaction) and below the watchdog, so one half-dead connection fails ITS test with a stack trace.
- **Parallel forks (`-Pforks=N`).** `server/build.gradle.kts` sets `maxParallelForks` from the property (1..3; the `testing.md` text has the rest). Each fork is its own JVM with its OWN container and fixture singletons (`withSoloAdmins`, `restoreSeedAccounts`, the seed admin hold per fork). Gradle hands whole CLASSES to forks in whatever order it likes; a `--tests` run or a failed-first rerun has no pinned warm-up and opens cold. The OpenAPI gate merges the forks' coverage ("OpenAPI conformance internals").

### The app, the clients and the audit trail

- `configureApp(vararg overrides)` (on `TestApplicationBuilder`, so `ForkWarmup.warm()` can use it outside `testApplication`) points the app at the shared container (CSRF off) WITHOUT starting it: tests that assert startup behaviour add their overrides and call `startApplication()` themselves; `usePostgresTestcontainer()` is the configure-and-start shorthand.
- It sets `mail.appUrl` to `https://localhost:8086` (validated at boot in every mode, so `https`, which the production-mode boot tests, reusing this config, also accept); a test that wants the blank-origin 503 or a malformed origin overrides it.
- It sets `postgres.statementTimeoutSeconds` to `60` (the shipped limit is 15 s; a stalled CI runner must not turn a deliberate lock wait into a failure; the tests of the limit itself override it to 1, and `sharedDatabaseForTests()` and a test's own pool keep no limit).
- It sets `telemetry.enabled` to `false` (the sampler would write a process row and samples into the shared database from every booted app). The telemetry tests (`TelemetrySamplerTest`, `TelemetryStoreTest`) build the sampler directly over `TelemetryFixtures.kt`'s helpers and empty `ops` before each test (`wipeTelemetry`); a test that wants the real sampler opts in with `"telemetry.enabled" to "true"` plus `TelemetryOverridesKey` (a fixed identity, an immediate first tick).
- It sets `sync.scheduler.enabled` to `false` (a live scheduler would start SCHEDULED runs for every tested connection other tests left in the shared database). `SyncSchedulerTest` builds `SyncScheduler` over the real `SyncRunService`, a fake `Connector` and an injected clock and drives `tick()` by hand; `JiraRunTest` builds one over the real observer narrowed to its own connection; `SyncBootTest` is the one class that boots an app with the scheduler on. Tests that boot the real engine with `-P:` arguments pass `-P:sync.scheduler.enabled=false` beside `-P:telemetry.enabled=false`.
- Password-reset fixtures: `newPasswordResetService(ttlMillis, clock)` builds a `PasswordResetService` over the shared database (an injected clock for expiry), `issueToken(userId, revision, email)` unwraps its `IssueOutcome` to the emailed token (null when stale or capped), and `resetTokenHashes(userId)` lists the stored digests (the table never holds a raw token).
- `jsonClient()` / `authedClient(email, password)` go through the shared test-client defaults (JSON + `application/problem+json` negotiation + the `OpenApiConformance` plugin); `LogCapture(loggerName)` + `hasKeyValue` is a Logback `ListAppender` for the audit trail (`ch.nokillswit.audit`), `awaitEvent` polls for asynchronous events; `postJson`/`putJson`, `HttpClient.login`, `withAuditCapture { }`, `withSeedRestored { }` and `assertStartupFails(part) { }` serve bootstrap/fail-closed tests.

### Users, teams, people and the seed state

- `TestUsers.seed(email, password, name, role)` (bcrypt cost 4; ADMIN by default). Every seeded user funnels through `UserService.create`, so they carry the inverted-default MFA-disabled row and log in single-step.
- `TestUsers.softDelete(id)` is a direct table update, bypassing the delete endpoint's guards; `TestUsers.withSoloAdmins(ids) { }` temporarily parks every other active admin (the last-admin-protection pin); `seededClient(prefix, role)` is the one-line seed+login fixture.
- **Many failed logins → seeded accounts.** A login for an UNKNOWN email pays a discarded cost-12 bcrypt verify (the timing equalizer, ~225 ms locally); a test that needs a dozen failures (rate limit, proxy trust) logs in as freshly seeded accounts (cost 4) with a wrong password (~1 ms), soft-deleted afterwards.
- `TestTeams.seed(name)` is a fresh team fixture; `TestPeople.seed(name, userId?, email?)` a person (optionally linked to a login; `softDelete`, `rawRows`); beside them sit raw-row readers for what the API hides (`TestTeams.rawRows`, `TestUsers.stampPasswordChangedAt`).
- `PersonMigrationTest` builds a scratch database, migrates it to V9, seeds data and applies V10: the pattern for any data-rewriting migration (the shared container only migrates an empty database).
- `TestSeedState.restoreSeedAccounts()` restores the pristine V3 seed after the bootstrap/production-mode tests that rotate the admin's password in the SHARED container (the production-mode overrides: Rules).

### Plan and milestone fixtures

- `planName(prefix)`: work stream and program names are GLOBALLY unique among active rows, and the plan tables are shared suite state, so always a unique name.
- `planCaller(prefix, role, withPerson)` is a seeded user, optionally with a linked ACTIVE person, and its logged-in client.
- `planWorld(prefix)` is one stream → program → project chain, each owned by its own person, plus the callers ADMIN / the three owners / a stranger / a person-less login / a `ROADMAP_EDITOR`: the authorization matrix's cast.
- `TestPlan` seeds `workStream`/`program`/`project` through the services, so the plan lock and revision bump apply; `revision()` and `scalar(sql)` read over raw JDBC.
- The plan-lock barrier tests (`PlanStateTest`, `RoadmapRankingTest`) hold `plan_state FOR UPDATE` on a raw session and use `awaitLockWait("plan_state")` (`waiters = 2` when two requests race for the lock).
- `requestHeldAtPlanLock(request) { raw -> … }` + `Connection.exec` are the "change something while the request waits at the lock" scaffold of the re-guard tests.
- **Milestones.** `planWorld(prefix, teams = true)` adds `PlanTeams` (`w.requireTeams()`: `teamId` managed by `manager`, `otherTeamId` managed by `otherManager`, both `PlanCaller`s, a login with a linked person, and nobody on the plan chain).
- `TestPlan.milestone(projectId, teamId, name, estimate)` and `TestPlan.schedule(id, start, end)` go through `MilestoneService`, past the guard, the lock and the bump applying; `schedule` expects the current revision and answers the revision it left behind. `TestPlan.pin(id, pinned)` pins a milestone; `TestTeams.seed(name, managerPersonId?)` seeds a team with a manager. `DecimalColumnTest` is the `NUMERIC(8,2)` binding spike.
- A held-request test for the schedule guard mutates the TEAM (`UPDATE teams SET manager_person_id = NULL`), the MILESTONE (`UPDATE milestones SET team_id = …`) or the manager's PERSON (`UPDATE people SET user_id = …`) inside `requestHeldAtPlanLock`; the team-row lock wait is `awaitLockWait("FOR SHARE")` with a raw session holding `teams … FOR NO KEY UPDATE`.
- The ranking is shared state too: `RoadmapRankingTest` starts every test with a wholesale PUT of its own list, so its raw-table assertions are exact.

### Dependency, capacity and team-order fixtures

- **Dependencies.** `milestoneRef(id)` / `projectRef(id)` (an `EndpointRef`), `HttpClient.postDependency(projectId, predecessor, successor, type, lagDays)` (the SUCCESSOR must be that project or one of its milestones), `secondProject(w)` and `TestPlan.dependency(predecessor, successor, type, lag)`.
- `secondProject(w)` is a project under the world's program owned by a NEW person-linked caller, `SecondProject.owner`: the cross-owner cases (the predecessor's owner is `w.projectOwner`, the successor's `second.owner`). `TestPlan.dependency` goes through `DependencyService.create` past the guard, the plan lock, cycle check and bump applying; the path project is derived from the successor.
- The graph is shared state: a test that creates a link soft-deletes or abandons it with its own throwaway world, and `DependencyLifecycleTest` soft-deletes its raw constraint-test rows so no stray active link reaches the cycle check of another test.
- **Capacity.** `TestPlan.capacityPeriod(teamId, effectiveFrom, mdPerWeek, wipLimit = null)` (an ISO date, ANY weekday; through `TeamCapacityService.create` past the guard: the team row lock and the partial index apply, the plan revision does not move, capacity being team data).
- The held-request capacity cases hold the TEAM row `FOR NO KEY UPDATE` on a raw session (`TeamCapacityLifecycleTest.requestHeldAtTeamLock`, `awaitLockWait("FOR NO KEY UPDATE")`): the capacity twin of `requestHeldAtPlanLock`.
- **Team order.** `TestPlan.teamOrder(teamId, ids)` goes through `TeamOrderService.replaceOrder` past the guard (the plan lock and bump apply; the current plan revision is always a valid `expectedRevision`; it answers the revision it left); `HttpClient.putTeamOrder(teamId, expectedRevision, ids)` is the typed `PUT /teams/{id}/milestone-order`.
- Raw reads: `TestPlan.teamOrderRows(teamId)` (position, milestone id), `teamOrderIds(teamId)` and `teamOrderRevision(teamId)` (null = never written). The held-request case uses `requestHeldAtPlanLock` with `UPDATE teams SET manager_person_id = NULL`.
- Orders are per team and tests mint unique teams, so raw-row assertions are exact; only the ranking is shared, and a test that rewrites it replaces it wholesale, as `RoadmapRankingTest` does.

### Holiday and baseline fixtures

Files: `TestHolidays.kt`, `PlanFixtures.kt`, `BaselineOverlaySupport.kt`.

- **Holidays.** The `public_holidays` table is GLOBAL shared state and starts EMPTY (no seed), so a test that needs a holiday on a day adds it for the duration of `TestHolidays.with(date, name) { }`: create through `PublicHolidayService`, run the block, `remove` in a `finally`. Each write is a plan write and bumps the plan revision, harmless to a test that reads the revision it needs.
- `TestHolidays.remove(id)` is a `finally` cleanup that tolerates a row the test already deleted through the API; `dates()` and `clearYear(year)` read and sweep.
- The dictionary's own tests own far-off years (`PublicHolidayTest` 2085-2089, `HolidayPresetTest` 2090-2095), so they can never move a figure another class pins in 2026-2027. The view and schedule tests add holidays on ordinary 2026/27 dates inside `TestHolidays.with { }` only (classes run sequentially per fork, and the cleanup runs `NonCancellable`, so a cancelled test cannot leak a row).
- **Baselines.** `baselines` is GLOBAL shared state and counts toward the cap of 100, so a test that takes one removes it in a `finally`: `TestPlan.baseline(name = planName("bl"), byUserId = seed admin)` goes through `BaselineService.create` past the guard (the plan lock, the cap, the copy and the bump apply; it answers the id), and `TestPlan.deleteBaseline(id)` is a soft delete past the guard that tolerates a baseline the test already deleted through the API.
- `BaselineTest` seeds the cap with header-only rows by raw SQL (the cap counts active headers; 100 copies of the whole plan would only slow it) and soft-deletes them in its `finally`. The frozen-row assertions read the tables over raw JDBC (`BaselineCopyTest`), and the held-grant cases use `requestHeldAtPlanLock` with `DELETE FROM user_permissions`.
- **Overlay helpers** (`BaselineOverlaySupport.kt`): `HttpClient.rawJson(path)`, `JsonElement.withoutBaseline()`, `assertOverlayIsAdditive(path, id)` (the plain document has no `baseline` key anywhere and the `?baseline=` document minus its `baseline` keys equals the plain one; run it with no write in between) and `assertBaselineParameterRejected(path)` (the 400 matrix: malformed, negative, decimal, overflowing, repeated, unknown and soft-deleted with the `unknown-baseline` type; it takes and deletes one baseline).
- The movement figures are asserted on a 2027 world (2027-02-01 is a Monday) with a holiday through `TestHolidays.with`.

### Scale tests

Files: `LoadKernelsScaleTest`, `ScheduleKernelsScaleTest`, `TeamScheduleBatchHoldTimeTest`, `JiraImportScaleTest`, `CrossTeamProposalSizeTest`, `BaselineScaleTest`, `SavedProposalReadScaleTest`, `HomeViewSizeTest`, `ScaleFigures.kt`, `ScaleReads.kt` (the two callers, shape-checked and bare, and the timed reads).

- Ordinary tests at the planning model's caps: `weeklyLoad` 520 weeks x 300 items, a cascading 300-milestone proposal, a 1,000-item batch accept, and `JiraImportScaleTest`'s 1,120- and 2,000-node imports over a scripted Jira site (rows hard-deleted in a `NonCancellable` `finally`).
- Each prints `scale-figure<TAB><name><TAB><ms>` lines into the suite's system-out (NOT `fixture-cost`, which `local-times.mjs` subtracts from the suite's time) and asserts a LOOSE tripwire on the median, at least 5x (measured 14x-160x) the dev-machine figure, so a slower runner never flakes it.
- The batch test seeds its 1,000 milestones in one `INSERT ... SELECT` through `sharedDatabaseForTests()` on a throwaway chain and removes them (hard `DELETE`) and the chain (the API's soft deletes) in a `NonCancellable` `finally`; its one plan write is the batch itself. The figures: `timeline.md` "Measured figures".
- `CrossTeamProposalSizeTest` is the same kind with a hard byte gate: `CrossTeamSampleFixture` seeds a SYNTHETIC plan of the sample's density (15 teams, 1,000 milestones, 300 links, fixed random seed) over raw `PostgresTestSupport.connect()` JDBC in ONE transaction (multi-row INSERTs, no plan lock, no revision bump; every name starts with the test's unique prefix) and `remove(prefix)` hard-deletes it in a `NonCancellable` `finally`. The run over all 15 teams is asserted at <= 600,000 bytes uncompressed and a loose 10 s tripwire.
- `BaselineScaleTest` (six baselines of the sample, then the comparison after every row moved; the gate is on the sample's own rows, since `projects[]` is the union of every project of the database; its frozen rows stay, the triggers refuse their delete) and `SavedProposalReadScaleTest` (one 15-team run saved all ticked and half ticked; it empties the GLOBAL saved table before and after, which the `SavedProposal*Test` classes and one `PlanStateTest` case write) reuse that fixture too.
- `HomeViewSizeTest` reuses that fixture (the owner linked to a login and made the manager of all 15 teams, the worst case of `GET /views/home`): <= 40,000 bytes, a loose 500 ms tripwire per caller (the person-less login included), and the view's statement count pinned through `CountingConnectionFactory` (a connection factory recording every statement, so a service that opens its own transaction is counted whole; `StatementCounter` sees one transaction only). The figures: `planning-model.md` "The view documents".

### The auto-proposal's server tests

- No shared helper: `ScheduleKernelsTest` is pure (hand-built `ScheduleInputs`, no DB, no `TestPlan`); `ScheduleProposalTest` and `TeamScheduleBatchTest` build their worlds from `planWorld(prefix, teams = true)` + `TestPlan.milestone`/`schedule`/`capacityPeriod`/`teamOrder` and keep their request helpers (`propose`, `batch`, `datesOf`, `scheduleRevisionOf`) private.
- The scope check adds `ScheduleScopeTest` (pure: hand-built `TeamScheduleItem`/`PlanMilestoneFact`/`PlanLinkFact`, shuffled inputs, one change per kind) and `TeamScheduleScopeTest` (a world with a foreign milestone and project predecessor, an in-progress and unscheduled team milestones, a `proposal()` + `accept()` pair, then one change after the proposal per case: `TestPlan.capacityPeriod`/`teamOrder`/`dependency`/`schedule`, `TestHolidays.with`, the ranking PUT).
- The proposal's fixed-date vectors sit in 2027.

## Fork warm-up

The first class of a JVM pays the container, Flyway and the first Ktor boot, and in `testApplication` that is inside the hard 60 s limit. `ForkWarmup.kt` moves it into a `@BeforeClass` (JUnit 4 does not time it): `ForkWarmup.warm()` migrates the container, boots the app once via `TestApplication { configureApp() }` and throws it away (marker `app-boot`); `ForkWarmup.assertWarm()` is the one test of each `ForkWarmup<k>Test`.

- There are three such classes (`ForkWarmup1Test`..`ForkWarmup3Test`, one per `-Pforks` value 1..3, `MAX_FORKS`) because Gradle deals one class FILE to one fork and collapses a repeated class name, while `TestClassNamingTest` allows one concrete `*Test` class per file and forbids an abstract `*Test` base. To support more forks, add `ForkWarmup4Test`.. and raise `MAX_FORKS` together.
- The `testClassesDirs` Callable in `server/build.gradle.kts` puts `ForkWarmup1Test`..`ForkWarmup<forks>Test` at positions `0..forks-1` (one file tree each), so Gradle's round-robin deal (position `p` goes to fork `p % forks`, all up front, no work stealing) gives fork k its own `ForkWarmup<k>Test` as the first class it runs. The surplus warm-up classes stay out through `exclude(FORK_WARMUP_GLOB)` (one fork) or the catch-all `exclude(TEST_CLASS_GLOB)` behind the balanced order.
- The Callable never throws: before `compileTestKotlin` ran, or while the compiled tree is stale and lacks a needed `ForkWarmup<k>Test.class`, it returns the plain dirs (so `--dry-run` works) and is evaluated again at execution; the test task's `doFirst`, after the compile, then fails a run whose class is still missing (naming the file; "run clean" if the source exists).
- Not covered: a `--tests` run drops every warm-up class, and a failed-first rerun (`RunPreviousFailedFirst`) may open a fork with another class; both open cold, which is fine for a focused run.
- The **tripwire** (`ForkWarmupLedger`, next to the stall watchdog in `server/build.gradle.kts`) records each JVM's first class and the result of every `ForkWarmup*Test`. A FULL run (no `--tests`) fails unless exactly `ForkWarmup1..forksTest` ran SUCCESSFULLY in `forks` distinct JVMs, and only warns about a JVM whose first class was not its warm-up.
- If the previous run's warm-up failed, Gradle runs failed classes first and can deal two warm-ups to one fork, so the distinct-JVM check can fire once on that rerun: rerun. The ledger guards the Gradle-internals assumptions (round-robin dealing, in-order forwarding, class-name dedupe).

## Fork balancing

Gradle deals candidate classes to the forks ROUND-ROBIN in visit order, so an alphabetical visit lets one fork draw the heavy classes and run alone at the end.

- With `-Pforks>1` the `testClassesDirs` Callable asks `balancedCandidateOrder` for the whole order: the candidates (the `**/*Test.class` files minus the warm-ups) sorted by weight, descending, are dealt greedily (LPT) to the least loaded fork that still has a free slot (capped at its round-robin share), and each fork's queue is laid out at the positions `p % forks == fork`, after the warm-up head. Ties break by name, so the order is the same on every machine.
- The weights are `server/test-weights.tsv` (`<fully.qualified.ClassName><TAB><seconds>`, committed, generated): `node scripts/timings/local-times.mjs test-weights` at the repo root, reading `server/build/test-results/test` of ONE full green run (fewer than 100 suites or a failed suite refuses without `--force`; the time is the suite's minus its `fixture-cost` seconds).
- **A class missing from the file weighs the average; a file that is missing or unparseable warns once ("test fork balancing skipped") and keeps the alphabetical order; a stale file only skews the balance**: the set of classes that run never depends on it, and it is not a task input, so refreshing it never reruns the tests. `-Pforks=1` ignores the file.
- The check is `local-times.mjs slow-tests --forks N --weights server/test-weights.tsv` (the "fork balance" block, warning past `forkBalance` in `budgets.json`); refresh the file when that warns and at every milestone check (`build-times.md`).
- **The classes of a fork run in this order, so a test that only passes in alphabetical order is the bug**: the balanced order exposed `BaselineCopyTest` comparing every active milestone with the copy, which skips the ones whose project another class had soft-deleted (the live query is now restricted to the plan's active projects).

## Stall watchdog

A hung test must not leave the `server` job silent until its timeout cancels it (a cancelled job uploads no `server-reports` artifact, so there would be no evidence). `TestStallWatchdog` (top of the `test` task's section) is a Test-task listener that tracks, per test JVM (the "Gradle Test Executor N" suite in a descriptor's parent chain), the time of the last suite/test start or finish.

- An executor that has started, not finished and been quiet for the threshold gets (1) `jcmd <pid> Thread.print -l` (the `javaLauncher`'s `jcmd`; the worker pid is found among Gradle's descendants by its command line) written to `server/build/reports/hung-tests/Gradle-Test-Executor-N-<yyyyMMdd-HHmmss>.txt` and logged at ERROR with the class/test in flight, then (2) its JVM is destroyed. `jcmd` itself is bounded at 30 s, so a worker too wedged to attach to is still killed.
- The task then fails ("Process 'Gradle Test Executor N' finished with non-zero exit value 137") once the other forks have run their queues, instead of at the CI job timeout. The directory is cleared at the start of each run; CI uploads `server/build/reports` as `server-reports` when the job is not cancelled.
- `-PtestStallMinutes` is an integer 1..60 (default `DEFAULT_TEST_STALL_MINUTES` = 5; the measurement is in the comment on the constant). Every executor logs `test watchdog: … longest quiet gap N s (in flight: …)` when it finishes: the number to re-measure the default from. The quiet gap is a single test's run time or a class's `@BeforeClass` fixture warm-up, nothing else.

## The stub fixtures

Files: `StubServer.kt`, `JiraStubFixture.kt`, `FlowStubFixture.kt`, `StubWarmupGuardTest`, `StubPortGuardTest`.

`StubServer.kt` is an `open class StubServer(stubDirectory)`; `JiraStubServer` and `FlowStubServer` are its two singleton `object`s. Each starts ONE in-JVM WireMock per fork.

- The port is dynamic, never a fixed one, so the gate runs beside the compose stack's own `jira-stub` on 8096 and `flow-stub` on 8097 (`StubPortGuardTest` pins it).
- A request journal capped at 50 entries keeps the shared singleton from retaining every served body; `resetRequests()` + `countRequests(pattern)` let a test assert what was or was not called.
- A test class that touches `JiraStubServer.` or `JiraStubFixture.` (or the Flow pair) calls `warm()` in a `@BeforeClass`, so the first start never lands inside `testApplication`'s 60 s. `StubWarmupGuardTest` (both stubs, one rule each) fails a `*Test.kt` that reads a stub without its `warm()` within four lines of a `@BeforeClass`, and a helper file (not `*Test.kt`) that reads it at all (the stubs' own fixture files excepted).
- A test flips a scenario with `setScenarioState(name, state)` (and MUST `resetScenarios()` in a `finally`); one-off failures come from `addOverride`/`removeOverride`.
- Flow's `SyncedStubFixture`/`DerivedStubFixture` (a SYNC into Postgres once per fork) have no counterpart ("Not yet ported"). Start-up cost of both stubs: `build-times.md`.

### The Jira stub fixture

Files: `JiraStubServer`, `JiraStubFixture`, `JiraStubFixtureTest`; the dataset `sample-data/jira-stub` (`sample-data/jira/README.md` has the request shapes it matches and the planted deviations; `expected.json` the figures a test compares with).

- It serves the SAME `mappings/` + `__files/` the compose and Kubernetes `jira-stub` image serves.
- `JiraStubFixture.warm()` starts the server, makes one unauthenticated and one authenticated request and prints `fixture-cost<TAB>jira-stub<TAB>ms`, which `local-times.mjs` subtracts from the suite that paid it; the first start (about 2,470 mappings, 2,260 bodies) is what it keeps out of the 60 s.
- The day-2 scenario is `JiraStubServer.setScenarioState("jira-day2", "day2")`.
- The stub answers every `fields` shape that names `summary` and `issuetype` and returns every field regardless, and its request journal is off, so the wire is verified elsewhere ("The Jira run's tests").

### The Jira run's tests

- `JiraRunTest` is the route and the background runner against the stub: full read, incremental, `jira-day2` and back, `expected.json`'s `inScopeDelta`, the node sweep. `JiraRunFailureTest` uses a WireMock `addOverride` 503/400/410 on a page cursor, `sample-fulltypes-eip-started-p<n>`; a scenario-bound override for "once". Both follow the flip-and-reset rule and add `@AfterClass resetScenarios()`.
- `JiraRunSupport.kt`'s `MockJiraRun` drives the REAL `JiraObserver`, services and `HttpJiraClient`/`SourceHttp` over a Ktor `MockEngine` (no WireMock, no journal; `requestHistory` is the wire). `JiraRunWireTest` uses it for the `fields` string of every read, the "no request at all" claims, the binding-level and mid-run-race cases.
- `JiraRunCensusTest` is the census's MockEngine class (the child level's typed read and fields, an incremental story, the page ceiling, the prunes, the due id sweep, a milestone mapped to level 0, a disable mid-census); `JiraRunTest` keeps the one stub-backed case (the `COV` roll-up figures from `expected.json`).
- A run is called directly (`observer.run(claimed)` + `runs.finish`) or awaited through `SyncRunner.await(runId)` (`SyncRunnerKey`), never by sleeping.

### The Jira stub's contract test

`JiraStubFixtureTest` replays the contract over plain HTTP against `expected.json`: auth forms and the refused token, the reference endpoints, full/sweep/probe/incremental paging, issue by id and key, day 2; plus the isolated projects, each the world of one feature:

- `COV` (the child level: the fourth type set `s` answers a typed read and a sweep per scope; dated **2046**, anchor Monday 2046-03-05; the coverage e2e's world, nothing else touches it) folds to `expected.json` `cov.rollups`; the untyped `full/any` shape also lists the stories, so `totals.issues` counts the plan levels and `totals.stories` the rest;
- `IMF` (the import filter's world: fifteen listed issues and one hidden parent that answers `404`; `expected.json` `imf.byFilter`) and the windowed browse's family, which answers the typed read's own pages because the stub evaluates no filter, so a test asserts the REQUESTED `jql` and the by-id reads;
- `IMC` (fourteen issues in 2045) and the children family: four fixed `parent in (...)` sets answered at priority 1 with the four filter-clause variants, any other set the `401`, the rejected token still refused on a children query, `expected.json` `imc.byRoot` the rows a rooted browse must produce;
- the `wiremock` version of `gradle/libs.versions.toml` against the stub image's `FROM wiremock/wiremock:<tag>@sha256:...`.

The generator's own checks are Node: `node --test sample-data/jira/generate.test.mjs` (determinism, the committed `sample-data/jira-stub` + `expected.json` equal to a fresh run, hierarchy, planted counts, the `COV` figures, the match regexes), run by `scripts/gates.sh` (which also generates twice and `diff`s) and CI's `e2e-static`.

### The Flow stub fixture

Files: `FlowStubServer`, `FlowStubFixture`, `FlowStubFixtureTest`; the dataset `sample-data/flow-stub` (`sample-data/flow/README.md` has the dataset, the credential and the scenarios).

The twin of the Jira one: Flow 1.57.0's service-token surface, `GET /api/v1/integration/me` and `/teams`.

- **The contract lives in ONE file, `sample-data/flow/contract.mjs`** (paths, token grammar, the uniform 401, every field name). The generator writes `sample-data/flow/expected.json` from it, and `FlowStubServer` reads the token, the authorization header and the paths from THAT file (`FlowStubServer.expected`/`.token`/`.authorization`/`.mePath`/`.teamsPath`), so no Kotlin constant can drift.
- A class that reads it calls `FlowStubFixture.warm()` in a `@BeforeClass` (one `me` and one `teams` call; marker `fixture-cost<TAB>flow-stub<TAB>ms`).
- Its scenarios are `flow-day2` (state `day2`: Billing vanishes, Platform's and the e2e team's future capacities change) and `flow-outage` (state `down`: both endpoints 500 for any WELL-FORMED bearer, the uniform 401 only for a missing or malformed header). A test that flips one MUST `resetScenarios()` in a `finally`: `FlowRunTest` and `CapacityDeviationViewTest` (which flips `flow-day2` after an import and reads the view; its `@AfterTest` and `@AfterClass` reset too).
- `FlowStubFixtureTest` replays the contract over plain HTTP: the token forms (the uniform 401 for no header, another scheme, a wrong or other-app token, a bare token, any non-GET method or other path under the namespace), both documents against `expected.json` (keys, counts, vocabularies, the planted cases, the E2E Flow Team's exact rows), `sprintsSince` (well-formed, absent, malformed = 400, a bad credential first = 401), both scenarios, the 50-entry journal, and that the Flow image pins the SAME WireMock tag and digest as the Jira image and the test dependency.
- **Drift rule.** The stub's documents are produced only by `contract.mjs`, the server decodes only through `flow/FlowDocument.kt` (`FlowClientTest` replays the stub's documents into it), so a Flow that ships another field or path is a two-file edit (`contract.mjs`, `FlowDocument.kt`), a regenerate, and these two tests proving them aligned.
- The generator's own checks are Node: `node --test sample-data/flow/generate.test.mjs` (determinism, committed == fresh, the contract's field names in order, the planted cases, the Monday-09:00-to-Friday-17:00 Europe/Warsaw cadence checked against `Intl` with DST, day 2), run by `scripts/gates.sh` (which also generates twice and `diff`s) and CI's `e2e-static`.

## Fixture tripwires

`FixtureTripwire<S>` is the re-verification machinery for a fixture's SHARED connection: the fixture arms it with the baseline snapshot it captures when its own init completes, and every later `connectionId()` call re-snapshots the connection and compares it, so a consumer that mutates the shared connection fails the NEXT test that asks for it, whatever class order the fork runs in (a tripwire test that merely compares once proves nothing when it happens to run first).

- `arm(snapshot)` sets the baseline; `verify(connectionId, force, snapshotOf)` runs the check. The first call after arming skips it; `force` skips the per-class gate (the explicit tripwire tests); `snapshotOf` is called only when a check runs.
- `perCallerClass` trades precision for cost: an expensive snapshot re-checks only when the calling TEST CLASS changes (the top-level `*Test` class on the stack, `callerTestClass()`; an unidentifiable caller always re-checks), a cheap one on every call.
- The failing test is the one AFTER the mutator, so the message names the previous caller and says to clone the connection instead. After a failure the baseline is re-captured, so one mutation fails ONE test, never every later consumer in the fork.
- `FixtureTripwireTest` pins the class itself with a fake fixture (nothing else exercises its failure and gating paths). No fixture arms it yet: Flow's synced and derived fixtures are not ported ("Not yet ported").
- The harness's other tripwires guard one assumption each: `ForkWarmupLedger` ("Fork warm-up"), `StubWarmupGuardTest`/`StubPortGuardTest` ("The stub fixtures"), `PostgresImagePinTest`, `TestClassNamingTest` and the scale tests' loose bounds ("Scale tests").

## OpenAPI conformance internals

Files: `server/src/test/kotlin/OpenApiConformance.kt`, `OpenApiCoverageMerge`, `OpenApiSpecTest`, `CoverageGapsTest`. The rule (every `/api/` interaction validated, the `jsonClient()` requirement, the `warn|off` triage switch, a test per declared status): `testing.md` "Gates, frontend tests and conformance".

- Drift (undeclared endpoint/method/status, response-schema or content-type mismatch) fails the exercising test with the validation report. The response side is fully validated; request-side validation is ignored except unknown-path/method (tests deliberately send malformed payloads and missing tokens).
- The validator reads the published OpenAPI 3.0.3 document directly. `OpenApiSpecTest` pins its dialect (`nullable:`, never `type: [..., "null"]`) plus static invariants (unique operationIds, 401/500 declared, paths under `/api/v1/`).
- A coverage report (exercised vs. declared operation/status pairs) is written to `server/build/reports/openapi-conformance/coverage.md` after each test run, and it is a GATE: the sibling `gaps.txt` lists every declared (operation, status) pair the suite never produced. `server/build.gradle.kts` fails the `test` task on a non-empty `gaps.txt` whenever the WHOLE suite ran (a `--tests` filter skips the gate), and on a missing one.
- The cross-cutting statuses are excluded: the ones a shared plugin answers for every route alike and one test pins each (`400` malformed id/body, `401`, `413`, `415`, `429`), and `500`/`default`, which the public API offers no honest way to force (`CoverageGapsTest` pins them). `413` is declared on EVERY operation that takes a request body (`OpenApiSpecTest` pins it) but is never a per-operation test: the one `PayloadValidationTest` case covers the shared limit.
- The gate is **fork-safe**: each test JVM writes its own `exercised-<pid>-<uuid>.txt` and re-merges every fork's file under a file lock into the ONE `coverage.md` + `gaps.txt` (`OpenApiCoverageMerge`, pinned by `OpenApiCoverageMergeTest`). A pair exercised by ANY fork is covered, and the `test` task clears the directory first so stale per-fork files never leak in.

## Coverage gates

The rule and the floors' convention: `testing.md` "Gates, frontend tests and conformance" (Kover `minBound` floors wired into `check` via `koverVerify`; vitest thresholds in `web/vite.config.ts`).

- The measurement EXCLUDES whole classes annotated `@kotlinx.serialization.Serializable` (`kover.reports.filters`): Kover cannot filter only kotlinx-serialization's generated members, whose optional-property masks add synthetic branches no application test can meaningfully exercise.
  `SerializableDtoBehaviorTest` therefore refuses handwritten functions, computed properties and initializers in those coverage-hidden DTO bodies; behavior moves to measured top-level extensions. The sole exception is a secret-masking `toString` that must override the generated rendering, pinned independently by `SecretToStringTest`.
- `check` runs only `koverVerify`, so run `./gradlew :server:koverXmlReport` for fresh actuals. Every fork's Kover agent writes into the one shared `test.ic` (if CI ever flakes on Kover, fall back to `-Pforks=1`).
- Kover stays on everywhere `check` runs: the floors are a gate. There is **no Gradle property to switch it off**; for a timing run or a tight dev loop over `:server:test` alone, temporarily add `kover { currentProject { instrumentation { disabledForTestTasks.add("test") } } }` to `server/build.gradle.kts` and never commit it (no `test.ic` is written, so `koverVerify` would have nothing to check). Kover costs roughly a tenth of the test wall.

## Frontend test internals

The rules (`env="test"`, `isolate: false`, the shuffle proof): `testing.md` "Gates, frontend tests and conformance". The mechanics behind them:

- `src/test/setup.ts` imports `../i18n` and forces `en`; `src/test/render.tsx` is the shared wrapper and `src/test/http.ts` holds the fetch-stubbing helpers. `env="test"` is needed because, since Mantine 9.4, the Popover/Combobox dropdown is `display: none` until Floating UI sees a real bounding box, which never happens in happy-dom.
- The shared setup also forces the reduced-motion media query and makes every Mantine test provider honour it: `Transition` invokes its animation hook even with `env="test"`, so synchronous reduced-motion transitions prevent callbacks from outliving happy-dom teardown. Other media queries retain their normal behaviour; the application theme is unchanged.
- `setup.ts` raises testing-library's `asyncUtilTimeout` to 4 s (and `vite.config.ts` the `testTimeout` to 10 s): the module registry is cleared per file, so the first test of a shuffled file to touch a lazy chunk pays its cold import, which exceeds the 1 s `findBy`/`waitFor` default on a contended machine.
- `isolate: false` means a worker reuses its module registry and globals across files; Vitest scopes `vi.mock` registrations per file, so what carries over is the EVALUATED `src/` modules, hence `setup.ts` calls `vi.resetModules()` before every file (npm packages stay cached). A synchronous `getBy…` after the page's own controls appear is the bug, not the timeout.
- To reproduce shuffle flakes run several `npx vitest run --sequence.shuffle --sequence.seed=N src/pages src/components` in parallel (a quiet single run hides them).

## E2E scenarios

Files: `e2e/README.md` (run recipes, the parallel state-ownership rulebook, the coverage map), `e2e/scenarios/`, `e2e/scenarios/README.md` (the format and the compiler contract), `e2e/target.ts`. The same-commit rule and `check:scenarios`/`typecheck`: `testing.md` "Gates, frontend tests and conformance".

- CI also runs `cd e2e && npm run test:setup`: the refusal when the stack was not named (the four `E2E_*` variables of `e2e/target.ts`, none assumed), the readiness check, and the source pins (no host URL under `e2e/`; no docker command in global setup). Global setup starts nothing and leaves services and volumes intact.
- Flow's shared read-only synced fixture (exported to the workers as `E2E_SHARED_*`) is not ported ("Not yet ported").

## The e2e worlds

Each world is seeded through the admin API of the named stack and removed by its own spec. The steps, dates and expected figures of each live in its scenario file (`e2e/scenarios/<spec>.md`); only the collision, lock and ownership rules are kept here. Holidays are global, so only one spec writes holidays in a far-off year (2040: `public-holidays`); the worlds below date their rows in 2041 to 2048, where nothing else writes a holiday, and a year may hold more than one world.

### The e2e dependency world

Files: `e2e/tests/dependencies.spec.ts`; prefix `e2e-dep-*`.

- Seeded per test (the `project-view.spec.ts` helpers, copied): a project OWNER login (the person who owns the program, so both projects), a team MANAGER login (owning nothing), a team the manager manages, a login-less lead's work stream, one program, two projects A and B with one milestone each (February 2027, no holiday). The second scenario creates the link through `POST /projects/{B}/dependencies` as the admin; the first through the dialog.
- Teardown deletes the projects first (their milestones and links cascade), then program, stream, team, people, users (`deleteViaApi`, reverse creation order).
- `accessibility.spec.ts`'s fixture adds a second project `e2e-axe-linked` with a violated FS link into the fixture project's scheduled milestone, so the project-view scan covers the table, the red badge, the ghost row and the arrow, plus the dependency dialog scan.

### The e2e Home world

Files: `e2e/tests/home.spec.ts`; prefix `e2e-home-*`.

- March 2027 (no holiday, no far-off year: the two flags it pins are drift in CALENDAR days). Seeded once in a beforeAll and removed in the afterAll (milestones first, then the project): an OWNER login whose person is linked (`people.user_id`) and owns the work stream, program and project (with a target window) and manages the team, a second login linked to no person, and two milestones of the team, one scheduled past the window (a warning and an info) and one unscheduled.
- "Yours" is the owner's own, so its rows and counts are asserted exactly (found by name); the plan and roadmap cards are shared by four workers, so a number with its word is asserted present, never a value. No stub, no ranking write, no lock.
- A third test on the same world asserts the owner's "not scheduled" links and the "own yourself" roadmap link by exact counts (each list is narrowed by the owner's own ids).
- A second person without a login (`e2e-home-other-*`) owns a second, milestone-less project (`e2e-home-other-project-*`) in the owner's program: "Your projects" then has two rows (found by name, never by position), and a fourth test turns "Only what I own myself" on and off (the `astrolabe.viewSettings.home.mine.ownOnly` key lives in the test's own browser context).

### The e2e Teams-load and roadmap worlds

Files: `e2e/tests/team-load.spec.ts` (prefix `e2e-load-*`), `e2e/tests/roadmap.spec.ts`, `e2e/tests/roadmap-overview.spec.ts`. Seeded per test and removed in the afterEach (the project first).

- `team-load.spec.ts` (April 2027): one team with 1 man-day a week and one 10 man-day milestone, so its one week is overloaded whatever a holiday does. The first test opens the old `/team-load?warning=overloaded` (it redirects; at most 200 teams) and the plan-wide team counts are asserted present, never as values. The second test reads the same world's row in the "Weeks with a warning" table and the team page; both open `?past=true`, because the page lists the weeks from the server's current week on and a fixed April 2027 week would vanish by default once it is behind the run.
- A third test seeds a second, run-dated world of the same shape (capacity from the Monday four weeks before the run's UTC week; overloaded weeks three weeks before and after): the later week is listed by default, "Include past weeks" brings back the earlier one.
- `roadmap.spec.ts` seeds a program with a flagged project and a plain one (a second test checks Home's unranked figure and `?severity=WARNING`); `roadmap-overview.spec.ts` uses `seedPlan` with a stored pick of the other program.

### The e2e dependency-list world

Files: `e2e/tests/dependency-list.spec.ts` (June 2027); prefix `e2e-deplist-*`.

- Per test, removed in the afterEach (the projects first): one person, ONE team, a work stream, a program, two projects, four milestones and three links (one violated by weeks, matched by a pattern, never a number). The page is opened narrowed to the project or team, and Home's violated figure is asserted present, never as a value.
- A later test seeds the same world with two throwaway USER logins (`e2e-deplist-owner-*`, whose person, `people.userId`, owns the work stream, so every successor's project, and `e2e-deplist-nobody-*`, linked to no person), removed in the afterEach after the person. The 1.27 test adds one link there, beside a foreign person, work stream, program and project (`e2e-deplist-foreign-*`) the owner does not manage.

### The e2e view-revalidation world

Files: `e2e/tests/view-revalidation.spec.ts`; team prefix `e2e-reval-team-*`.

It seeds ONE team (no manager, no milestone), renames it through the API and reads its page from the sidebar (the SPA keeps the view's tag in memory only, so it never reloads). Its last step waits, up to ten reads, for a `304`, because another worker's plan write puts a `200` between two reads.

### The e2e team-view world

Files: `e2e/tests/team-view.spec.ts`; prefix `e2e-tv-*`.

- The same seeding as the project view's (the helpers copied): a project OWNER login, a team MANAGER login (owning nothing), a team the manager manages, a login-less lead's work stream and program, one project owned by the owner, and two milestones of the team (`e2e-tv-ms-a-*`, `e2e-tv-ms-b-*`; February 2027).
- The capacity scenario creates its one period through the dialog (a WEDNESDAY, 2027-02-03) and schedules through the UI; the order and read-only scenarios schedule through the API with the TEAM view's plan revision.
- Teardown deletes the project first (the milestones and the team's order rows go with it), then program, stream, team (its capacity periods go with it), people, users.
- `accessibility.spec.ts`'s fixture team carries one capacity period (0.5 MD/week, WIP limit 1), so its two overlapping milestones make the team page show the overload column, the dashed WIP chip and the orange and red badges in both schemes.

### The e2e holiday and chain worlds

Files: `e2e/tests/public-holidays.spec.ts`, `e2e/tests/critical-path.spec.ts`.

- `public-holidays` writes holidays in **2040 only** (a sweep by date before its first test and in its afterAll). Its calendar test seeds a project pair there and adds a holiday on the Monday 2040-02-06, which turns "needs 2040-02-06" into "needs 2040-02-07".
- `critical-path` seeds in **2041**, which no spec writes holidays in: three projects X, Y, P under one OWNER login, a chain `x1` -FS-> `y1` -FS-> `p1` in P plus an unlinked `p2` in P. On P's page `y1` is a ghost row (slack 0); the Critical chain lists only `x1` (hops 2: a member beyond the ghost rows; never filter by hops) and week 2 is a 5-working-day idle gap (P's, and its team's: P's milestones are on their own team).
- Further tests reuse the same world: the team page of P's team (read as the administrator), the roadmap narrowed to the world's program with the program pick (the two bundle arrows `bundle:<X>-<Y>` and `bundle:<Y>-<P>`, five `data-critical` elements) and the programs page narrowed the same way (folded, the program's bar is the one `data-critical` and has no arrow).
- `accessibility.spec.ts`'s fixture adds a chain project (`c0` -> `c1` -> the fixture milestone) so the toggle-on scan has zero-slack links.

### The e2e schedule-proposal world

Files: `e2e/tests/schedule-proposal.spec.ts`; prefix `e2e-sp-*`. Year **2042** (no spec writes a holiday there).

- Seeded per test (the team-view helpers, copied): a project OWNER login, a team MANAGER login, a team whose FIRST capacity period starts Monday 2042-01-06 (the real clock is the proposal's `asOf`, but nothing can land before the first day with capacity, so the dates do not depend on today), two unscheduled milestones `a`, `b`, one scheduled `c` and the link `b -FS-> c`.
- The pin test pins `c`, discards, unpins and proposes again.
- `accessibility.spec.ts` seeds a second 2042 pair (`e2e-axe-prop-*`: two moves, one link the proposal would violate, one it resolves) in its own describe (and a second copy in the detail-pages block, for the hovered-row scan), so the fixture team's page does not stretch to 2042. The table's hover tint is theme-owned and AA-pinned (`web/src/theme.test.ts`); the axe cases hover a row on purpose.
- **A holiday written while a proposal is open.** The helpers of both proposal specs take the answer whatever its status and assert the 200 with the problem body as the message (a bare wait for an OK answer would time out after 30 s with nothing to read). A holiday written by `public-holidays.spec.ts` while a proposal was open refuses the accept with 409 `urn:astrolabe:problem:stale-scope` (the page then re-proposes and sends no second accept), and a holiday change refuses only an accept whose dates it changes (`scheduling.md` "The auto-proposal").

### The e2e cross-team world

Files: `e2e/tests/cross-team-proposal.spec.ts`; prefix `e2e-ct-*`. Year **2048** (2048-01-06 is a Monday; nothing writes a holiday there).

- Seeded per test (the schedule-proposal helpers, copied): a project OWNER login (manages nothing), a team MANAGER login whose person manages BOTH teams X and Y, a SINGLE manager login (third scenario: the world's `split` flag gives team Y to this person, because a team has one manager; fourth: `soloTeam` gives this person a third team Z instead, so they manage one team and neither of the run's). Each team has ONE capacity period from Monday 2048-01-06 (no WIP limit); `x1` on X is scheduled, `y1` on Y unscheduled, link `x1 -FS-> y1`.
- The plan revision is shared with every parallel spec, so the accept test asserts the answer's revision is ABOVE the run's, never an exact bump. The spec holds the lock `holiday-dictionary` (a run's scope hash covers the holiday dictionary).
- The fourth test SAVES a proposal through the page (`e2e-ct-saved-*`) and registers its delete first in the teardown: the saved table holds the newest 20 for everyone and any save evicts the oldest, so it never relies on another row, clears none, and saves once (10 a minute per login).
- `accessibility.spec.ts` sweeps `/schedule-proposals` (empty page, as the administrator it offers every team) among the list pages.

### The e2e baselines world

Files: `e2e/tests/baselines.spec.ts`; prefix `e2e-bl-*`. Year **2043** (2043-01-01 is a Thursday, so the Mondays are 01-05, 01-12, 01-19, 01-26; nothing writes a holiday there).

- Seeded per test (the team-view helpers, copied): a project OWNER login O and a team MANAGER login M (neither holds the baseline right: ADMIN or `ROADMAP_EDITOR` only), a login-less lead's stream and program, a team T managed by M, a project P owned by O with two milestones on T. The first two tests re-plan P (a move and a new milestone, the second also a delete).
- **Baselines are plan-wide shared state** (up to 100 active, each a copy of the WHOLE plan, other specs' rows included), so each test takes its OWN baseline (a unique `e2e-bl-*` name, through the UI in scenario 1, otherwise the API) and soft-deletes it in the afterEach (before the project: the teardown list runs in reverse), and no step counts rows, asserts the list is empty or reads a total: every assertion is anchored on P's milestones, rows or the baseline's own name.
- The pick is a browser setting (`localStorage` `timeline.baseline`), so a fresh browser context per test keeps it from every other spec. The two-baseline test ranks its own project at the end of the ranking (`updateRankingViaApi`; the page's "Unranked → rank N" is asserted, never N).
- The 1.26 test gives T a capacity period (2043-01-05, 10 MD a week) through the ADMIN API BEFORE taking its baseline, then adds a link `m1` -> `m2` and a cut period (2043-02-02, 5 MD a week); both go with the project and the team in the afterEach, and the assertions read only P's rows and T's own group of the Capacity table.
- `accessibility.spec.ts`'s baseline describe takes one `e2e-axe-bl-*` baseline in its `beforeAll` (a 2026 world) and soft-deletes it first in its `afterAll`; the scenario file's **Owns** line and the ledger in `e2e/README.md` carry the year.

### The e2e Jira world

Files: `e2e/tests/jira-sync.spec.ts`; prefix `e2e-jira-*`. Year **2044** (2044-01-04 is a Monday; nothing writes a holiday there).

- The stub is the compose `jira-stub` (WireMock, `E2E_JIRA_STUB_URL`) and its `E2E` project (E2E-1 Program, E2E-2/3 Initiatives, E2E-4..10 Epics; `E2E-6` is deleted and `E2E-10` moved to `OUT-6` on day 2).
- A connection is scoped to `E2E` ONLY (a scope the stub does not list falls to its 401 catch-all; `IMP` is the import spec's and `COV` the coverage spec's) and sits on a unique throwaway site `https://stub-e2ejira<random>.atlassian.net` (the server routes only `stub-` sites to the stub), so a Jira item is bound once per site and no other spec's or the user's connection meets its bindings. The refused token is `wrong-token`.
- The file is serial. The first scenario's UI-created connection is tested once and reused by the mapping scenario; one API-seeded connection (tested once, 0.5 man-days per point saved through the API) is shared by the two linking scenarios; each linking test seeds a project-owner login (no administrator right), people, a team, a work stream, a program, a project and its milestones through the admin API, removed in the afterEach (a connection's delete unlinks its bindings).
- The unscheduled-milestone scenarios bind an UNSCHEDULED milestone to `E2E-4` (a scheduled, unlinked milestone gives the pages their dates); the project's owner (no right to schedule) has no "Operations for <name> (dates from Jira)" button, and the throwaway administrator `runner` (a browser context of its own) schedules it from that row's menu. It writes nothing to Jira and spends no Test connection call.
- The chip scenario makes its OWN tested, never-refreshed connection (the shared one is refreshed by earlier scenarios) so "Jira data may be out of date" shows until the throwaway administrator's first Refresh; the same test also asserts the sentence on the Roadmap's and Programs' facts lines before that refresh (plan-wide, so never asserted absent afterwards on a shared stack).
- The milestones' ends are planted against the stub's (the stub's own `endLaterWorkingDays: 3` is Jira's end against the plan's, the other way round).
- **The stub is one process with one scenario state, and this file alone flips `jira-day2`**: the beforeAll starts it at `Started`, the day-2 step resets it right after the refresh that shows "Gone from Jira" (in a `finally`), and the afterAll is the backstop.
- A refresh is proven by the Deviations view's `observedAt` of the item growing (a bind already writes the first reading), never by a fixed sleep.
- Test connection and Peek share a per-IP bucket across the whole suite (10 a minute by default, 30 on the e2e stacks). This file spends about six calls (the chip scenario's own connection included), and one more in the accessibility Jira describe, which seeds its own `e2e-axe-jira-*` world and binds `E2E-4`, present in both stub states; the three result tables the file shows are axe-scanned in place, which costs no call.
- `schedule-proposal.spec.ts` and `public-holidays.spec.ts` share the Playwright lock `holiday-dictionary` (a proposal's scope hash covers the global holiday dictionary); the Jira specs never write a holiday and need none.

### The e2e Jira import world

Files: `e2e/tests/jira-import.spec.ts`; prefix `e2e-import-*`. Year **2045** (2045-01-02 is a Monday; `IMP-4` ends 2045-01-06, Polish Epiphany, harmless because no spec loads 2045 holidays).

- The stub's isolated `IMP` project (a Program, two Initiatives, six Epics with an undated, a long-summary, a team-less and a program-direct one) is imported into a throwaway work stream through the connection page's modal. Program names are global, so the spec is the only importer of `IMP` and holds the Playwright lock `jira-import-stub` (it serialises `--repeat-each` copies).
- One connection scoped to `IMP` on a unique throwaway site is tested once per worker start (a 429 waits the minute out once) and shared. Each test seeds its OWN administrator login (the preview and the apply share a 5-a-minute bucket per user), a person, a team and a work stream through the API, never applies into an existing stream, and removes the bindings, the stream's tree, the team, the person and the login in the afterEach, even after a failure.
- The beforeAll sweeps a crashed run's residue by the `e2e-import-` prefix only, over all pages, and fails fast on an "IMP Program" under any other work stream.
- **The import filter (dialog defaults: done items left out, 365 days).** The `IMP` figures hold at the defaults (every issue is open and stamped 2044; the stub does not evaluate the filter, the server's rule does). The 1,100-row preview switches the filter OFF (its projects are stamped 2026: a 365-day window would shrink it from late August 2027).
- The stub's `IMF` project (`expected.json` `imf`, dated 2045; the spec does not read the file, it hard-codes the `byFilter` figures) is previewed at the defaults through a connection of its own scoped to `IMF` (`e2e-import-filter-*`, one more Test call), then imported (two programs "IMF Program" / "IMF Program Old", four projects, four milestones); with the filter off it previews 15 rows, with only the done switch on 12. The spec guards the global names "IMF Program" and "IMF Program Old" as it guards "IMP Program".

### The e2e rooted-import world

Files: `e2e/tests/jira-import-children.spec.ts`; prefix `e2e-impchild-*`. Year **2045** (the stub's `IMC` project is dated there, as `IMP` is).

- The stub's isolated `IMC` project (`expected.json` `imc`; the spec hard-codes the `byRoot` figures and does not read the file): a root Program over open and Done Initiatives and Epics, a second Program whose children appear in no rooted answer, and a childless Program.
- One connection scoped to `IMC` ONLY on a unique throwaway `stub-` site is tested once per worker start (one Test call; a 429 waits the minute out once) and shared.
- Each test seeds a throwaway NON-admin login with its person, a second person who owns the work stream (so the login owns only the program, or only the project), a team without a manager (the milestones are created unscheduled), the stream, one or two programs (and a project) and ONE binding made through the API as the administrator, and removes the bindings, the tree, the team, the people and the login in the afterEach, even after a failure. The beforeAll sweeps a crashed run's residue by the `e2e-impchild-` prefix alone.
- A rooted import creates no program, so there is no global name to guard and no Playwright lock; each login spends at most three of its 5-a-minute preview/apply calls.
- The connection page's row button is an administrator's: the test signs in as a throwaway administrator of its own (`apiAsThrowawayAdmin`), because the preview bucket is per user. The entry points are found by their accessible names ("Import from Jira what is listed under <name>" with `exact: true`, "Import from Jira…").
- The "outside" world adds a second program owned by the other person with a project linked to `IMC-2` and a sibling project variant. The "match" world is the "program" world plus ONE unlinked project named exactly "Initiative North" (a plain name on purpose: the `e2e-…` prefix holds digits, which the matcher treats as numbering) under the linked program, so the stub's `IMC-2` "IMC Initiative North" word-matches it and the preview offers "Link instead". No new stub data.

### The e2e Jira coverage world

Files: `e2e/tests/jira-coverage.spec.ts`; prefix `e2e-cov-*`. Year **2046** (2046-03-05 is a Monday; nothing writes a holiday there, and the stub's `COV` project is dated there too).

- The stub's isolated `COV` project (untouched by day 2; `expected.json` `cov`): an Initiative over two bound Epics (one with partly done children, one with every child done while the epic is To Do) and two Epics the spec leaves UNBOUND (an open one, `UNLINKED_IN_JIRA`, and a DONE one, excluded as closed work).
- One manual-only connection scoped to `COV` ONLY on a unique throwaway site (`https://stub-e2ecov<random>.atlassian.net`) is tested once per worker start (one Test call; a 429 waits the minute out once), given 0.5 man-days per point through the API, and bound to the world's project and two milestones, all through the admin API. Estimates equal the points at 0.5 so no estimate deviation shows.
- One manual run (awaited by a bounded poll on the runs API) fills the census mirror; a second one in the last test proves an acknowledgement stands. The milestones are named `e2e-cov-epic-one/-two/-unlinked-*` (so every linked one also reads a "Renamed" info beside its other flags). The file never flips the stub, needs no lock, and removes everything through the API (the bindings, then the connection, then the plan nodes).

### The e2e Flow world

Files: `e2e/tests/flow-sync.spec.ts` (prefix `e2e-flow-*`; the Flow pages of `accessibility.spec.ts` are `e2e-axe-flow-*`), `flow-capacity-deviation.spec.ts` (`e2e-capdev-*`), `flow-capacity-acknowledge.spec.ts` (`e2e-capack-*`). Year **2047**.

- The stub's "E2E Flow Team": sprints 90001..90006 from Monday 2047-01-07, ten working days each, 20 / 18 / 22 / 20 / 19 / 21 man-days a week; nothing writes a holiday there.
- The stub is the compose `flow-stub` (WireMock). The APP reaches it as `E2E_FLOW_STUB_ORIGIN` (default `http://flow-stub:8080`, listed in the app's `FLOW_INSECURE_ORIGINS`) with the one public token of `sample-data/flow/expected.json`; the SPEC reads its admin API at `E2E_FLOW_STUB_URL` to fail fast when `flow-day2` or `flow-outage` is not at `Started` (`flow-sync` flips nothing).
- The flippers of `flow-day2` are `flow-capacity-deviation.spec.ts` and `flow-capacity-acknowledge.spec.ts`, each serial, reset in its beforeAll, right after its refresh and in its afterAll, and each holds the Playwright lock `flow-stub-scenario` with `flow-sync` (the same "E2E Flow Team" figures) and with the other. The acknowledge spec's last scenario flips it a second time (day one, then day two again, each followed by a refresh; reset in a `finally`).
- The acknowledge spec's world is the same shape plus one milestone of the linked team (so the team view's weekly strip covers sprints 1-3), and the day-one capacity imported before day two is read once. Its project, program and work stream names are kept in the world (`plan`), because the Roadmap and the Programs page are narrowed to its program by address (`?programId=`) and the project row carries the team's Flow capacity flag while a difference is open.
- The deviation spec's world: one manual-only connection, a team linked to "E2E Flow Team" and a team linked to the stub's "Billing" (the one team day two drops, `expected.json` `day2.gone`), a team-manager login; the day-two figures come from `expected.json` `day2.capacityChanges`.
- The specs read the token, the totals and the E2E team's rows from `expected.json` itself (`helpers.ts` `flowStub()`), never copy them. Every connection is manual-only (the scheduler never touches it); `flow-test` is its own per-IP bucket (30 a minute on the e2e stacks), spent twice per worker start of `flow-sync` and once by the accessibility describe.
- The team manager (no administrator right) links through the dialog's connection list from the team's panel; "Link all suggested" is never pressed (it would link the demo plan's teams).

## Schemathesis

An optional manual fuzz pass, not in CI: property-based fuzzing of the running stack from the spec.

- `docker compose up --build` (compose ships dev mode, so `/openapi` is exposed), grab a token — `TOKEN=$(curl -s -X POST localhost:8086/api/v1/login -H 'Content-Type: application/json' -d '{"email":"admin@astrolabe.local","password":"changeme"}' | jq -r .token)` — then `uvx schemathesis run -c all -H "Authorization: Bearer $TOKEN" --exclude-path /api/v1/logout http://localhost:8086/openapi/documentation.yaml --url http://localhost:8086`.
- The `/logout` exclusion is load-bearing: fuzzing it **revokes the bearer token** (everything after 401s).
- Login fuzzing also trips the per-account lockout for `admin@astrolabe.local` (the spec's example email); it is in-memory, so `docker compose restart app` clears it.
- Expect residual noise from stateful invariants the spec cannot express (rate-limit 429s, TRACE probes); a **`Server error` count above zero is the real signal**.
- It complements, not replaces, the suite-piggybacked conformance layer ("OpenAPI conformance internals"); fuzz junk lives only in the compose volume (`docker compose down -v` resets). Needs `uv` (or `pipx`); no Python dependency lives in the repo.

## Not yet ported

Flow's `SyncedStubFixture`/`DerivedStubFixture` (a SYNC into Postgres once per fork), its GitLab stub, its normalized-layer sweep and its shared read-only synced e2e fixture (exported to the workers as `E2E_SHARED_*`). A planning increment that needs one ports it and adds its rules here in the same commit.
