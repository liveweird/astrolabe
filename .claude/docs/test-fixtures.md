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

**The e2e baselines world (`e2e-bl-*`, `e2e/tests/baselines.spec.ts`).** Year **2043** (2043-01-01 is a Thursday, so the Mondays are 01-05, 01-12, 01-19, 01-26; nothing writes a holiday there). Seeded per test through the admin API (the team-view helpers, copied): a project OWNER login O and a team MANAGER login M (neither holds the baseline right: ADMIN or `ROADMAP_EDITOR` only), a login-less lead's stream and program, a team T managed by M, a project P owned by O with `m1` (3 MD, 2043-01-05..09) and `m2` (2 MD, 2043-01-12..16) on T; the re-plan the first two tests apply is `m1` -> 01-12..16 and a new `m3` (2 MD, 01-19..21), the second also deleting `m2` (P's span 01-05..16 -> 01-12..21: start +5, end +3 working days). **Baselines are plan-wide shared state** (up to 100 active, each a copy of the WHOLE plan, other specs' rows included), so each test takes its OWN baseline (a unique `e2e-bl-*` name, through the UI in scenario 1, otherwise the API) and soft-deletes it in the afterEach (before the project: the teardown list runs in reverse), and no step counts rows, asserts the list is empty or reads a total: every assertion is anchored on P's milestones, rows or the baseline's own name. The pick is a browser setting (`localStorage` `timeline.baseline`), so a fresh browser context per test keeps it from every other spec. `accessibility.spec.ts`'s baseline describe takes one `e2e-axe-bl-*` baseline in its `beforeAll` (a 2026 world: `s1` later, `s2` unscheduled, `s4` deleted, `s3` new) and soft-deletes it first in its `afterAll`; the scenario file's **Owns** line and the ledger in `e2e/README.md` carry the year.

**The e2e Jira world (`e2e-jira-*`, `e2e/tests/jira-sync.spec.ts`).** Year **2044** (2044-01-04 is a Monday; nothing writes a holiday there). The stub is the compose `jira-stub` (WireMock, `E2E_JIRA_STUB_URL`, default `http://localhost:8096`) and its `E2E` project (E2E-1 Program, E2E-2/3 Initiatives, E2E-4..10 Epics; `E2E-4` Mon 2044-01-04..Fri 01-08 with 5 story points, `E2E-6` 02-14..02-18, deleted on day 2); a connection is scoped to `E2E` ONLY (a scope the stub does not list falls to its 401 catch-all; `IMP` is the import spec's and `COV` the coverage spec's) and sits on a unique throwaway site `https://e2ejira<random>.atlassian.net`, so a Jira item is bound once per site and no other spec's or the user's connection meets its bindings; the refused token is `wrong-token`. The file is serial, the first scenario's UI-created connection is tested once and reused by the mapping scenario, one API-seeded connection (tested once, 0.5 man-days per point saved through the API) is shared by the two linking scenarios, and each linking test seeds a project-owner login (no administrator right), people, a team, a work stream, a program, a project and its milestones through the admin API, removed in the afterEach (a connection's delete unlinks its bindings). The milestones' ends are planted against the stub's: Wed 2044-01-13 against `E2E-4`'s Fri 01-08 reads "Ends 3 working days later than Jira" (the weekend does not count; the stub's own `endLaterWorkingDays: 3` is Jira's end against the plan's, the other way round) and, at 0.5 per point, "Estimate is 3.00 man-days in the plan and 2.50 man-days in Jira". **The stub is one process with one scenario state, and this file alone flips `jira-day2`**: the beforeAll starts it at `Started`, the day-2 step resets it right after the refresh that shows "Gone from Jira" (in a `finally`), and the afterAll is the backstop. A refresh is proven by the Deviations view's `observedAt` of the item growing (a bind already writes the first reading), never by a fixed sleep. Test connection and Peek share a per-IP bucket across the whole suite (10 a minute by default, 30 on the e2e stacks; about five calls here, one in the accessibility Jira describe, which seeds its own `e2e-axe-jira-*` world and binds `E2E-4`, present in both stub states); the three result tables the file shows are axe-scanned in place, which costs no call. `schedule-proposal.spec.ts` and `public-holidays.spec.ts` share the Playwright lock `holiday-dictionary` (a proposal's scope hash covers the global holiday dictionary); the Jira specs never write a holiday and need none.

**The e2e Jira import world (`e2e-import-*`, `e2e/tests/jira-import.spec.ts`).** Year **2045** (2045-01-02 is a Monday; `IMP-4` ends 2045-01-06, Polish Epiphany, harmless because no spec loads 2045 holidays). The stub's isolated `IMP` project (IMP-1 Program "IMP Program", IMP-2/3 Initiatives "IMP Initiative Alpha/Beta", IMP-4..9 Epics; IMP-6 undated, IMP-7 a 110-character summary, IMP-5 without a Jira team, IMP-8 straight under the program) is imported into a throwaway work stream through the connection page's modal. Program names are global, so the spec is the only importer of `IMP` and holds the Playwright lock `jira-import-stub` (it serialises `--repeat-each` copies). One connection scoped to `IMP` on a unique throwaway site is tested once per worker start (a 429 waits the minute out once) and shared; each test seeds its OWN administrator login (the preview and the apply share a 5-a-minute bucket per user), a person, a team and a work stream through the API, never applies into an existing stream, and removes the bindings, the stream's tree, the team, the person and the login in the afterEach, even after a failure. The beforeAll sweeps a crashed run's residue by the `e2e-import-` prefix only, over all pages, and fails fast on an "IMP Program" under any other work stream. A fresh import reads: to create 8 (1 program, 2 projects, 5 milestones), 4 scheduled (IMP-4, 5, 7, 9) with a default team, IMP-8 skipped `NO_PARENT`; a second preview offers nothing.

**The e2e Jira coverage world (`e2e-cov-*`, `e2e/tests/jira-coverage.spec.ts`).** Year **2046** (2046-03-05 is a Monday; nothing writes a holiday there, and the stub's `COV` project is dated there too). The stub's isolated `COV` project (ids 97001..97012, untouched by day 2; `expected.json` `cov`): `COV-2` an Initiative (02-19..05-04) over `COV-3` Epic One (Mon 03-05..Fri 03-09, 8 points, four children: two Stories done, a Task in progress, a Bug to do = 2 of 4 done, 13 points), `COV-4` Epic Two (Mon 03-19..Fri 03-23, 5 points, two Stories both done = 2 of 2, 5 points, so `CHILDREN_DONE` while the epic is To Do and the plan ends later), `COV-5` an open epic the spec leaves UNBOUND (`UNLINKED_IN_JIRA`) and `COV-10` a DONE one it also leaves unbound (closed work is excluded). One manual-only connection scoped to `COV` ONLY on a unique throwaway site (`https://e2ecov<random>.atlassian.net`) is tested once per worker start (one Test call; a 429 waits the minute out once), given 0.5 man-days per point through the API, and bound to the world's project (`COV-2`) and two milestones (`COV-3`, `COV-4`), all through the admin API; one manual run (awaited by a bounded poll on the runs API) fills the census mirror, a second one in the last test proves an acknowledgement stands. The milestones are named `e2e-cov-epic-one/-two/-unlinked-*` (so every linked one also reads a "Renamed" info beside its other flags): epic one ends Wed 03-14 against Jira's Fri 03-09 (a warning "Ends 3 working days later than Jira", sharing its Flags cell with the key, an info badge and the roll-up `2/4 · 13 pt`), epic two is in line (`2/2 · 5 pt`), the third is scheduled and bound to nothing (`UNLINKED_IN_PLAN` on the project). Estimates (4 and 2.5 man-days) equal the points at 0.5 so no estimate deviation shows. The file never flips the stub, needs no lock, and removes everything through the API (the bindings, then the connection, then the plan nodes).

**Fork warm-up (every `-Pforks`).** The first class of a JVM pays the container, Flyway and the first
Ktor boot, and when it runs in `testApplication` that is inside the hard 60 s limit. `ForkWarmup.kt` moves it into a
`@BeforeClass` (JUnit 4 does not time it): `ForkWarmup.warm()` migrates the container (`ensureMigrated()`), boots the app
once via `TestApplication { configureApp() }` and throws it away (marker `app-boot`); `ForkWarmup.assertWarm()` is the
one test of each `ForkWarmup<k>Test`. There are three such classes (`ForkWarmup1Test`..`ForkWarmup3Test`, one per
`-Pforks` value 1..3, `MAX_FORKS`) because Gradle deals one class FILE to one fork and collapses a repeated class name, while
`TestClassNamingTest` allows one concrete `*Test` class per file and forbids an abstract `*Test` base. (Flow had eight, for `-Pforks` up to 8; add
`ForkWarmup4Test`.. and raise `MAX_FORKS` together if a runner ever pays for more forks.) The `testClassesDirs`
Callable in `server/build.gradle.kts` puts `ForkWarmup1Test`..`ForkWarmup<forks>Test` at positions `0..forks-1` (one file tree each), so Gradle's round-robin
deal (position `p` goes to fork `p % forks`, all up front, no work stealing) gives fork k its own `ForkWarmup<k>Test` as the first class it runs; the surplus
warm-up classes stay out of the run through `exclude(FORK_WARMUP_GLOB)` (one fork) or the catch-all `exclude(TEST_CLASS_GLOB)` behind the balanced order (below). The Callable never throws: before `compileTestKotlin` ran, or while the compiled tree is stale
and lacks a needed `ForkWarmup<k>Test.class`, it returns the plain dirs (so `--dry-run` works) and is evaluated again at execution; the test task's `doFirst`, after the
compile, then fails a run whose class is still missing (naming the file; "run clean" if the source exists). Not covered: a `--tests` run drops every
warm-up class (no test in it matches), and a failed-first rerun (`RunPreviousFailedFirst`) may open a fork with another
class; both still open cold, which is fine for a focused run. The **tripwire** (`ForkWarmupLedger`, next to the stall
watchdog in `server/build.gradle.kts`) records each JVM's first class and the result of every `ForkWarmup*Test`; a FULL run
(the OpenAPI gate's condition: no `--tests`) fails unless exactly `ForkWarmup1..forksTest` ran SUCCESSFULLY in `forks`
distinct JVMs, and only warns about a JVM whose first class was not its warm-up. If the previous run's warm-up class failed, Gradle runs failed classes first and can deal two
warm-ups to one fork, so the distinct-JVM check can fire once on that rerun: rerun. It guards the Gradle-internals assumptions (round-robin dealing, in-order forwarding,
class-name dedupe). The throwaway boot runs `Bootstrap` on a fresh database before any test: no test may assume it is the fork's first boot.

**The Jira stub fixture (v1.1.0 C1: `JiraStubServer`, `JiraStubFixture`, `JiraStubWarmupGuardTest`, `JiraStubFixtureTest`).** `JiraStubServer.kt` (Flow's, ported) starts ONE in-JVM WireMock per fork over `sample-data/jira-stub`
(dynamic port, a request journal capped at 50 entries so the shared singleton does not retain every served body; `resetRequests()` + `countRequests(pattern)` let a test assert what was or was not called), the SAME `mappings/` + `__files/` the compose and Kubernetes `jira-stub` image serves
(`sample-data/jira/README.md` has the dataset, the request shapes it matches and the planted deviations; `expected.json` the figures a test compares with). A test class that touches
`JiraStubServer.` or `JiraStubFixture.` calls `JiraStubFixture.warm()` in a `@BeforeClass` (it starts the server, makes one unauthenticated and one authenticated request and prints
`fixture-cost<TAB>jira-stub<TAB>ms`, which `local-times.mjs` subtracts from the suite that paid it), so the first start (~2,300 mappings, ~2,200 bodies at 1.4.0) never lands inside `testApplication`'s 60 s;
`JiraStubWarmupGuardTest` fails a `*Test.kt` that reads the stub without that call within four lines of a `@BeforeClass`, and a helper file (not `*Test.kt`) that reads it at all (the two fixture files
excepted). Flow's `SyncedStubFixture`/`DerivedStubFixture` (a SYNC into Postgres once per fork) have no counterpart yet: Astrolabe's stub fixture is only the server. A test flips the day-2 scenario with
`JiraStubServer.setScenarioState("jira-day2", "day2")` and MUST `resetScenarios()` in a `finally` (the server is shared by every class in the fork); one-off failures come from `addOverride`/`removeOverride`.
**The Jira run's tests (step C6).** `JiraRunTest` (the route and the background runner against the stub: full read, incremental, `jira-day2` and back, `expected.json`'s `inScopeDelta`, the node sweep) and `JiraRunFailureTest` (a WireMock `addOverride` 503/400/410 on a page cursor, `sample-fulltypes-eip-started-p<n>`; a scenario-bound override for "once") follow the flip-and-reset rule above and add `@AfterClass resetScenarios()`. The stub answers every `fields` shape that names `summary` and `issuetype` and returns every field regardless, and its request journal is off, so the wire is verified elsewhere: `JiraRunSupport.kt`'s `MockJiraRun` drives the REAL `JiraObserver`, services and `HttpJiraClient`/`SourceHttp` over a Ktor `MockEngine` (no WireMock, no journal; `requestHistory` is the wire), and `JiraRunWireTest` uses it for the `fields` string of every read, the "no request at all" claims, the binding-level and mid-run-race cases. `JiraRunCensusTest` (1.4) is the census's MockEngine class (the child level's typed read and fields, an incremental story, the page ceiling, the prunes, the due id sweep, a milestone mapped to level 0, a disable mid-census); `JiraRunTest` keeps the one stub-backed case (the `COV` roll-up figures from `expected.json`). A run is awaited through `SyncRunner.await(runId)` (`SyncRunnerKey`) or called directly (`observer.run(claimed)` + `runs.finish`), never by sleeping.
`JiraStubFixtureTest` replays the contract over plain HTTP against `expected.json` (auth forms and the refused token, the reference endpoints, full/sweep/probe/incremental paging, issue by id and key, day 2, and the 1.4 child level: the fourth type set `s` (Story + Task + Bug) answers a typed read and a sweep per scope, and the isolated `COV` project (dated **2046**, anchor Monday 2046-03-05; the coverage e2e's world, nothing else touches it) folds to `expected.json` `cov.rollups`; the untyped `full/any` shape also lists the stories, so `totals.issues` counts the plan levels and `totals.stories` the rest) and pins
the `wiremock` version of `gradle/libs.versions.toml` against the stub image's `FROM wiremock/wiremock:<tag>@sha256:...`. The generator's own checks are Node: `node --test sample-data/jira/generate.test.mjs`
(determinism, the committed `sample-data/jira-stub` + `expected.json` equal to a fresh run, hierarchy, planted counts incl. `childrenDone`, the stories and the `COV` figures, the match regexes), run by `scripts/gates.sh` (which also generates twice into scratch directories and `diff`s) and CI's
`e2e-static`. Start-up cost: `build-times.md` "Jira stub fixture".

**Fork balancing (Flow's, ported after 1.4.0).** Gradle deals candidate classes to the forks ROUND-ROBIN in visit order (position `p` goes to fork `p % forks`, all up front, no work stealing), so an
alphabetical visit lets one fork draw the heavy classes and run alone at the end. With `-Pforks>1` the `testClassesDirs` Callable (`server/build.gradle.kts`) therefore asks `balancedCandidateOrder`
for the whole order: the candidates (the `**/*Test.class` files minus the warm-ups, so the rule is the `include` rule's) sorted by weight, descending, are dealt greedily (LPT) to the least loaded fork that still
has a free slot (a fork's slot count is capped at its round-robin share), and each fork's queue is laid out at the positions `p % forks == fork`, after the `ForkWarmup1..forksTest` head. Ties break by name, so the order is the same on every machine.
The weights are `server/test-weights.tsv` (`<fully.qualified.ClassName><TAB><seconds>`, committed, generated): `node scripts/timings/local-times.mjs test-weights` from the `server/build/test-results/test` of ONE full green run
(fewer than 100 suites or a failed suite refuses without `--force`; the time is the suite's minus the `fixture-cost` seconds it printed). **A class missing from the file weighs the average; a file that is
missing or unparseable warns once ("test fork balancing skipped") and keeps the alphabetical order; a stale file only skews the balance** - the set of classes that run never depends on it, and it is not a task input, so
refreshing it never reruns the tests. `-Pforks=1` ignores the file. The check is `local-times.mjs slow-tests --forks N --weights server/test-weights.tsv` (the "fork balance" block: the span against the ideal `sum / N`, a warning past `forkBalance` in
`budgets.json`, and the weights drift); refresh the file when that warns and at every milestone check (`build-times.md`). **The classes of a fork run in this order, so a test that only passes in alphabetical order is the bug**: the balanced order
exposed `BaselineCopyTest` comparing every active milestone with the copy, which skips the ones whose project another class had soft-deleted (the live query is now restricted to the plan's active projects).

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
`PostgreSQLContainer("postgres:18.6-alpine@sha256:10a5c69a…")` (the same digest `docker-compose.yaml` and
`k8s/postgres-deployment.yaml` pin — `PostgresImagePinTest`) started lazily by `PostgresTestSupport` and **shared
across the whole suite within a JVM fork** (one container per fork; test-side direct database access, `sharedDatabaseForTests()`, goes through a small
r2dbc-pool built by production's own `connectPooledDatabase` — an unpooled connect paid ~4 ms of backend
setup per transaction). Running tests requires a working Docker daemon (Docker Desktop,
OrbStack, etc. — with OrbStack and no `/var/run/docker.sock`, export
`DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`). The container runs **all** Flyway
migrations, so the V3 seed admin (`admin@astrolabe.local`) is present — tests scope their assertions
with unique prefixes/filters (`uniqueEmail("marker")`) rather than asserting absolute counts.

**Parallel forks (`-Pforks=N`).** `server/build.gradle.kts` sets `maxParallelForks` from the `forks` Gradle
property (an integer 1..3, anything else fails any build that runs the `test` task; default 1 = one JVM, which is CI's setting, while `scripts/gates.sh` passes 2; `forkEvery` is deliberately unset). Each fork is its own
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
  It likewise sets `sync.scheduler.enabled` to `false` (a live scheduler would start SCHEDULED runs for every tested connection other tests left in the shared database); `SyncSchedulerTest` builds `SyncScheduler` over the real `SyncRunService`, a fake `Connector` and an injected clock and drives `tick()` by hand, `JiraRunTest` builds one over the real observer narrowed to its own connection, and `SyncBootTest` is the one class that boots an app with `"sync.scheduler.enabled" to "true"`. The tests that boot the real engine with `-P:` arguments pass `-P:sync.scheduler.enabled=false` beside `-P:telemetry.enabled=false`.
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
  **Baseline fixtures** (V20, `PlanFixtures.kt`): `baselines` is GLOBAL shared state and counts toward the cap of 100, so a test that takes one removes it in a `finally`: `TestPlan.baseline(name = planName("bl"), byUserId = seed admin)` (through `BaselineService.create` past the guard — the plan lock, the cap, the copy and the bump apply; answers the id) and `TestPlan.deleteBaseline(id)` (a soft delete past the guard; tolerates a baseline the test already deleted through the API). `BaselineTest` seeds the cap with header-only rows by raw SQL (the cap counts active headers; 100 copies of the whole plan would only slow it) and soft-deletes them in its `finally`; the frozen-row assertions read the tables over raw JDBC (`BaselineCopyTest`), and the held-grant cases use `requestHeldAtPlanLock` with `DELETE FROM user_permissions`. **Overlay helpers** (v0.9 C7, `BaselineOverlaySupport.kt`): `HttpClient.rawJson(path)`, `JsonElement.withoutBaseline()`, `assertOverlayIsAdditive(path, id)` (the plain document has no `baseline` key anywhere and the `?baseline=` document minus its `baseline` keys equals the plain one - run it with no write in between) and `assertBaselineParameterRejected(path)` (the 400 matrix: malformed, negative, decimal, overflowing, repeated, unknown and soft-deleted with the `unknown-baseline` type; it takes and deletes one baseline). The movement figures are asserted on a 2027 world (2027-02-01 is a Monday) with a holiday through `TestHolidays.with`.
- **Scale tests** (1.0.0, `LoadKernelsScaleTest`, `ScheduleKernelsScaleTest`, `TeamScheduleBatchHoldTimeTest`, and 1.2's `JiraImportScaleTest`: a 1,120- and a 2,000-node import over a scripted Jira site, rows hard-deleted in a `NonCancellable` `finally`; `ScaleFigures.kt`): ordinary tests at the planning model's caps (`weeklyLoad` 520 weeks x 300 items, a cascading 300-milestone proposal, a 1,000-item batch accept). Each prints its figures as `scale-figure<TAB><name><TAB><ms>` lines into the suite's system-out (NOT `fixture-cost`, which `local-times.mjs` subtracts from the suite's time) and asserts a LOOSE tripwire on the median, at least 5x (measured 19x-160x) the figure on the dev machine, so a slower runner never flakes it. The batch test seeds its 1,000 milestones in one `INSERT ... SELECT` through `sharedDatabaseForTests()` on a throwaway chain and removes them (hard `DELETE`) and the chain (the API's soft deletes) in a `NonCancellable` `finally`; its one plan write is the batch itself. The figures: `timeline.md` "Measured figures (1.0.0)".
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
