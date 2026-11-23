### Testing

Backend tests live flat in `server/src/test/kotlin/` (kotlin.test + `testApplication`; only `auth/` is a subfolder) against ONE Testcontainers Postgres per JVM fork (`PostgresTestSupport`, started lazily, image pinned by digest, `PostgresImagePinTest`).
A Docker daemon is required (OrbStack without `/var/run/docker.sock`: `DOCKER_HOST=unix://$HOME/.orbstack/run/docker.sock`; `scripts/gates.sh` exports it itself).
The container runs **all** Flyway migrations, so the V3 seed admin (`admin@astrolabe.local`) is present: tests scope assertions with unique prefixes/filters (`uniqueEmail("marker")`), never absolute counts.
Test-side direct database access is `sharedDatabaseForTests()`. The full reference (pool, every helper, forks, watchdog, Kover, fixtures, conformance internals, Schemathesis, e2e scenarios): `.claude/docs/test-fixtures.md`.

#### Parallel forks

`-Pforks=N` sets `maxParallelForks` (an integer 1..3, the number of `ForkWarmup<k>Test` classes; anything else fails any build running `test`; default 1; CI and `scripts/gates.sh` pass 2; `forkEvery` unset).
Each fork is its own JVM with its OWN container and fixture singletons, so every "shared suite" rule here holds per fork: a test must never assume another class ran before it on the same JVM, or ran at all (class order is not a contract; with `-Pforks>=2` the classes are dealt by `server/test-weights.tsv`, `test-fixtures.md`).
`PostgresTestSupport` migrates the container itself on start, so no fixture needs its own Flyway guard. Test classes are selected by file name (`**/*Test.class`, `TestClassNamingTest`). **A hung fork is thread-dumped and killed** (`-PtestStallMinutes`, default 5; dumps in `server/build/reports/hung-tests/`); raw JDBC uses `PostgresTestSupport.connect()`, never a bare `DriverManager.getConnection`.

**Fork warm-up.** `ForkWarmup<k>Test` is pinned as the FIRST class of fork k, so the one-time Postgres + Flyway + first-boot cost lands outside `testApplication`'s 60 s limit; a full run fails if one did not run first in its own JVM (`test-fixtures.md` "Fork warm-up"). A reader of the shared Jira/Flow stub fixtures warms them in a `@BeforeClass` (`StubWarmupGuardTest` fails a class that forgets); the stubs take a free port, so the gate runs beside a compose stack (`StubPortGuardTest`).

#### The `TestEnvironment.kt` harness

Use it instead of hand-rolling setup:

- App: `configureApp(vararg overrides)` points the app at the shared container (CSRF off) WITHOUT starting it (startup/fail-closed tests call `startApplication()`); `usePostgresTestcontainer()` configures and starts.
- Clients: `jsonClient()` / `authedClient(email, password)` (the shared defaults, incl. the `OpenApiConformance` plugin); `seededClient(prefix, role)` seeds a user and logs in.
- Users and teams: `TestUsers.seed(...)` (bcrypt cost 4; ADMIN by default, `UserRole.USER` for a non-privileged caller), `TestUsers.softDelete(id)`, `TestUsers.withSoloAdmins(ids) { }` (the last-admin pin), `TestTeams.seed(name)`, `TestPeople.seed(name, userId?)`. Shared suite state (the seed admin) is never mutated destructively: tests mint UNIQUE rows and remove their own.
- Audit and bootstrap: `LogCapture` + `hasKeyValue`/`awaitEvent`, `withAuditCapture { }` (detach in a finally), `postJson`/`putJson`, `HttpClient.login`, `withSeedRestored { }`, `assertStartupFails(part) { }`; use these, not re-rolled blocks.
- **Many failed logins** (rate limit, proxy trust): freshly seeded accounts with a wrong password (an UNKNOWN email costs ~225 ms), soft-deleted afterwards.
- `TestSeedState.restoreSeedAccounts()` — call it after bootstrap/production-mode tests (they rotate the seed admin's password in the SHARED container).
  Production-mode boots must also override `"mail.transport" to "disabled"` and `"security.encryption.key" to strongEncryptionKey()`; the checks fire in module order (JWT → mail → crypto → seed passwords), so a test asserting a later check satisfies every earlier one.

#### Gates, frontend tests and conformance

**Coverage gates.** Backend Kover enforces line- and branch-coverage floors in `server/build.gradle.kts` (the `minBound` floors, wired into `check` via `koverVerify`; `@kotlinx.serialization.Serializable` classes are excluded). The floors sit just below current actuals: **re-measure and raise** them as coverage improves (`./gradlew :server:koverXmlReport`), never lower them for new code; a tight-loop Kover disable is never committed. Frontend vitest enforces thresholds in `web/vite.config.ts` (`test.coverage.thresholds`, same convention; `cd web && npm run test:coverage`).

**Static analysis.** `./gradlew detekt` and the web `lint`/`knip` (`ci.md`): zero findings, no baseline; tune only in `config/detekt/detekt.yml` / `web/eslint.config.js` (one commented override per idiom), fix code first, a per-site `@Suppress` needs a justifying comment. `SourceFileSizeTest` caps main source files at 400 lines (a grandfathered ceiling only goes down; raising one is a reviewed exception).

**Frontend tests.** Vitest + happy-dom + Testing Library, **co-located** (`Foo.test.tsx` beside `Foo.tsx`);
`src/test/setup.ts` forces `en`, `src/test/render.tsx` is the shared wrapper, `src/test/http.ts` the fetch stubs. Every `MantineProvider` in a test must pass **`env="test"`** (otherwise Popover/Combobox
dropdowns stay `display: none` and Select-option clicks silently fail).

**The suite runs with `isolate: false`** (`web/vite.config.ts`): modules carry over between files (`setup.ts` calls `vi.resetModules()` before each file),
so tests must not assume what an earlier test left behind: await lazy chart chunks (`findBy…`/`waitFor`), reset module-level state in `afterEach`, unstub globals/timers.
The proof is `cd web && npx vitest run --sequence.shuffle` (run it a few times after adding a test); a test that passes only in file order is the bug.

`locales/parity.test.ts` enforces EN↔PL key parity (and pins folders == `SUPPORTED_LANGUAGES`).

**Runtime OpenAPI conformance.** Every `/api/` interaction in the server suite is validated against `documentation.yaml` by the `OpenApiConformance` client plugin, installed via `jsonClient()`/`authedClient()`; `testApplication`'s default `client` bypasses it, so never use it for `/api/` calls.
Drift fails the exercising test (`-Dopenapi.conformance=warn|off`: triage only). The spec stays 3.0-compatible (`nullable:`, never `type: [..., "null"]`, `OpenApiSpecTest`). 
The coverage gate fails the `test` task on a non-empty or missing `build/reports/openapi-conformance/gaps.txt` when the WHOLE suite ran, so a new operation lands with a test per declared status, or its list trimmed to what the route can answer, except the cross-cutting `400/401/413/415/429/500/default` (`CROSS_CUTTING_STATUSES`).

**Schemathesis** (optional manual fuzz, not in CI): never fuzz `/api/v1/logout` (it revokes the bearer token).

**E2E scenarios.** `e2e/README.md` governs the Playwright suite. Every spec has a scenario file in
`e2e/scenarios/` whose `## Scenario:` headings equal the `test()` titles verbatim; a new or behaviorally changed
test lands in the same commit with its scenario file and its line in the e2e README's "What's covered";
`cd e2e && npm run check:scenarios` (parity, both directions) and `npm run typecheck` enforce it.
