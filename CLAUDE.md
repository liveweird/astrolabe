# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Product

Astrolabe is a planning and roadmapping app (Jira-Plans-like, better UX, more opinionated, Gantt-centred) for a multi-stream / multi-program / multi-team environment, at a scale of about
15 teams, 5 work streams, 20 programs, 100 projects and 1,000 milestones. It keeps its **own** plan data; later it syncs with Jira and Flow only to **detect deviations** (corrections are made
in Astrolabe, never written back).

**Hierarchy (4 levels):** work stream (owner; end set only on close) → program (owner; span derived from its projects) → project (owner; optional target window; real span derived from its
milestones) → milestone (start/end, man-day estimate, exactly one team, no owner). **Four views**, all on one shared timeline component: the **project** view (its milestones), the **team** view
(its milestones against capacity), the **roadmap** (projects by one global rank, and in time) and the **programs** view. **Planning flow:** build the hierarchy and rank the projects; the
team manager schedules milestones (manual drag/resize first, auto-proposal later); dependencies (FS/SS/FF/SF + lag) and capacity overload only ever **warn**, never move anything.

**Roadmap:** 0.1.0 = the foundation, Flow trimmed to its generic core: auth + email MFA, password reset, users, feature flags, teams with a manager, EN/PL, light/dark, changelog,
the ADMIN telemetry panel, the cyan brand. 0.2.0 = plan structure: people, the `ROADMAP_EDITOR` grant, work streams/programs/projects with owner-scoped rights, the Plan page, the ranked Roadmap. 0.3.0 = timeline + project view: milestones, the team-scoped schedule, the shared `Timeline*`, `/projects/:id`, reparenting. 0.4.0 = dependencies. 0.5.0 = team view + capacity: capacity periods with a WIP limit, the weekly load strip, the per-team milestone order (menu + row drag), the ranking's own revision, the sample dataset. **0.6.0 (current)** = roadmap + programs timelines: the Roadmap as a timeline (rank by row drag/menu), the Programs tree, derived spans upward, drift and rank-inversion flags, the target window by drag/draw/dialog, Year zoom. **Built, not yet released: 0.7.0** = calendar + critical path: the ADMIN holiday dictionary (+ Polish preset), the whole-chain critical path with slack, idle gaps (no release until asked). Next: 0.8.0 auto-proposal, 0.9.0 baselines, 1.0.0 checkup. Per-version scope, the user's domain decisions and the assumptions: `.claude/docs/product.md`; the domain sketch:
`.claude/docs/planning-model.md`; the timeline: `.claude/docs/timeline.md`. Open items: `BACKLOG.md`.

Brand: deep cyan (the `astrolabe` colour tuple in `web/src/theme.ts`, `primaryShade: { light: 8, dark: 9 }`); the logo is a stylised astrolabe (limb ring with ticks, rete star pointers, alidade).

## Donors

**Flow is the primary donor**: this repository started as an exact copy of Flow (`~/Sources/flow` @ `e9c3b726`, Flow 1.35.0), trimmed; Covenant, Lettuce and Toadie came in indirectly through it.
**Port, don't reinvent**: when Astrolabe needs a capability a sibling already has, port its implementation. What each donated: `.claude/docs/product.md` "Donors". **Port later** (still in Flow):
`ingest/`, `fetch/`, `jira/`, `plugins/Role.kt`, `EncryptedAtRest`/`Reencrypt` — for the Jira/Flow deviation sync;
`CapacityKernels.kt` — the pure-kernel idiom; Lettuce's WireMock stub pattern (stub port 8096); Flow's fork
balancing — when `server-tests` outgrows its budget.

## Commands

Gradle wrapper is at `./gradlew` (use `gradlew.bat` on Windows). JDK 21 toolchain is required
(auto-provisioned via foojay-resolver; the local dev JDK is pinned in `mise.toml` —
`temurin-21.0.12+101.0.LTS`, Node 24.22.0). Run `mise install` once, then `mise exec -- <command>`
or activate mise in your shell. If `./gradlew` resolves the wrong JDK, point it explicitly: `JAVA_HOME=$(mise where java) ./gradlew build`.

- All local gates, timed like CI: `scripts/gates.sh [server|web|e2e|all]` (stops at the first failure; `ASTROLABE_FORKS=N` for more test forks; `.claude/docs/build-times.md`)
- Build everything: `./gradlew build`; run the server (Ktor + Netty, port 8086): `./gradlew :server:run`; all tests: `./gradlew test`
- Run server tests only: `./gradlew :server:test` (Docker for Testcontainers; OrbStack: testing.md)
- Run a single test: `./gradlew :server:test --tests "ch.nokillswit.ServerTest.security headers are set on responses"`
- Static analysis (detekt, both Kotlin modules): `./gradlew detekt` — rides `check`, zero findings, no baseline file; rule
  tuning lives in `config/detekt/detekt.yml` ONLY; never add an uncommented `@Suppress`.
- Dependency alignment: `./gradlew :server:checkDependencyAlignment` — one version per aligned family
  (Netty, OpenTelemetry, kotlin stdlib/reflect, Jackson 2, Reactor) on the runtime classpath; rides `check`.
- Package the server: `./gradlew :server:installDist`. **Never use `:server:buildFatJar`** — the fat JAR breaks Flyway's
  `ServiceLoader` discovery.
- JVM memory flags are pre-tuned in `server/build.gradle.kts` (`applicationDefaultJvmArgs`; rationale in place).
- AppCDS class list (`server/cds/classlist.txt`, dumped into the Docker image): `node scripts/cds-classlist.mjs` regenerates it from a real run (in a git worktree pass `--image <tag>`);
  `CdsClassListTest` and CI's `scripts/check-cds-archive.sh astrolabe-app` guard drift
- **Run the whole stack with one command: `docker compose up --build`** (only Docker required).
  See "Running the full stack" below.
- Frontend: `cd web && npm install --legacy-peer-deps`, then
  `npm run dev|build|lint|test|test:coverage|knip|gen:api` (details in `web/CLAUDE.md`). The
  API-contract gate is `npm run lint:api` (Spectral lint of the OpenAPI spec + the conformant
  fixture against `api-guidelines/`) and `npm run check:api` (in-memory spec → `schema.ts` diff).
- E2E: `cd e2e && npm ci && npx playwright install chromium && npm test` (plus `lint`, `knip`, `typecheck`, `check:scenarios`, `test:setup`).
- CI: `.github/workflows/ci.yml` re-runs every gate above on push/PR; the blackbox Playwright suite (`e2e.yml`) runs
  nightly and on demand; Dependabot checks every workspace weekly. The job list, the Markdown-only skip, Trivy and
  grouping: `.claude/docs/ci.md` (dependency rules: `dependencies.md`, `dependency-reproducibility.md`).

## Running the full stack

`docker compose up --build` serves everything at `http://localhost:8086` (sign in as `admin@astrolabe.local`; the README
has the initial password). Local dev: `docker compose up postgres mailpit` (Postgres on host port
**5437**, Mailpit UI **8029**) + `./gradlew :server:run` (API on **8086**) + `cd web && npm run dev` (Vite on **5178**,
proxying `/api`), each in its own terminal; the ports avoid the sibling repos' and bind to 127.0.0.1 only. The sibling port table, Mailpit and the Kubernetes (OrbStack) `astrolabe`
namespace: `.claude/docs/ci.md` "Running the full stack".

## Architecture

Astrolabe is Flow's generic foundation under a planning domain that is still to be built. The foundation: **JWT auth**
with a sliding refresh pair and a server-side revocation blocklist, opt-in **email MFA**, self-service password reset,
per-account lockout and per-IP rate limits, **ADMIN-managed users** (`/api/v1/users`, `UserRole`) with per-user **feature flags**
and a synced UI/email **language** (EN/PL), the **people** directory (the owners and managers of the plan, optionally linked to a login), flat **teams** (the ownership unit the planning domain will point at) with an optional manager (a person), the ADMIN **telemetry** panel, and the React
shell (nav model, palette, theme, changelog). Every feature follows the feature template below.

Multi-module Gradle build (Kotlin DSL) defined in `settings.gradle.kts` with two Kotlin modules
plus two standalone npm workspaces (Gradle never touches them):

- **`core`** — Kotlin Multiplatform (JVM target only currently). Shared code consumed by `server`.
  Holds the OpenTelemetry SDK bootstrap (`getOpenTelemetry(serviceName)`).
- **`server`** — Kotlin/JVM. The Ktor application. Depends on `core`. One process: there is no worker and no role switch.
- **`web/`** — Vite + React + TypeScript SPA that consumes the server's HTTP API.
- **`e2e/`** — Playwright blackbox suite against the compose stack.

Group is `ch.nokillswit`, version `1.0.0-SNAPSHOT` (inherited from the donor scaffold; renaming is out of scope). Dependency
versions are centralized in `gradle/libs.versions.toml` (every pin carries its rationale; Ktor comes from the separate `ktorLibs`
catalog). Resolved Gradle dependencies use strict locking and SHA-256 verification; intentional updates follow
`.claude/docs/dependency-reproducibility.md`.

### Server bootstrap model

`server/src/main/kotlin/main.kt` just delegates to `io.ktor.server.netty.EngineMain`. The
application is wired declaratively in `server/src/main/resources/application.yaml` under
`ktor.application.modules` — each entry is a fully-qualified extension function on `Application`
(e.g. `ch.nokillswit.plugins.HttpKt.configureHttp`). **Module order is load-bearing**: base plugins
(Http → SecurityHeaders → Monitoring → Serialization → Security → RateLimits → ErrorHandling → OpenTelemetry → AutoHeadResponse → Resources) →
infra (Mail → Crypto → Flyway → Database → Bootstrap → Health) → Telemetry (the sampler) → feature route modules (users, people, teams, planning, auth, password reset, telemetry reads) →
`RoutingKt.configureRouting` strictly last (the SPA catch-all). `configureDatabase` publishes the services into `Application.attributes` via `AttributeKey`s. To add a cross-cutting concern,
create a `configureXxx()` extension under `plugins/` and register it in `application.yaml`; do not call it from `main.kt`. There is no DI framework — services travel via `attributes`.
There is no role switch (Flow's `FLOW_ROLE` web/worker/all split is not ported; `.claude/docs/product.md` "Port later").

### Package layout

Source files sit flat under `server/src/main/kotlin/<area>/` but declare `package ch.nokillswit.<area>`
(no `ch/nokillswit` directory nesting — deliberate, the `InvalidPackageDeclaration` detekt
override). One line per package; `ls` gives the files. **Layering is one-way (`PackageBoundaryTest`):** `infra/` imports no feature package except the composition root (`infra/db/Database.kt`, `Bootstrap.kt`); `telemetry/` is imported by nothing.

- `plugins/` — cross-cutting Ktor wiring (`configureXxx` that only `install` plugins; Security = JWT, ErrorHandling = RFC 7807). `Routing` (the SPA catch-all) is registered strictly last; `Health` (`/api/v1/health`, `/api/v1/ready`) is registered after Database; `RateLimits` holds every per-IP bucket (and the per-user `telemetry` one); `ResponseValidators` is the `ETag` seam for future view GETs.
- `infra/mail/` — outbound email (Lettuce's, ported): `MAIL_TRANSPORT` log/smtp/disabled; the `log` transport is refused in production (fail-closed); a null mailer = email features answer 503.
- `infra/crypto/` — encryption at rest (Lettuce's, ported): `FieldCipher` (AES-256-GCM `enc:v1:` envelopes, a fresh nonce per value, current + rotation key), `configureCrypto` (`DATA_ENCRYPTION_KEY`; a burned key fails startup closed). No consumer yet; the `EncryptedAtRest` registry and `Reencrypt` come back with the sync.
- `infra/db/` — Flyway bootstrap, the R2DBC composition root, the seed bootstrap (admin rotation, prod fail-closed), `SoftDelete.kt` (the `SoftDeletable` trait: ONE `active()` predicate, `nowMillis()`, `lockActiveForWrite`), `Sql.kt` (`containsNormalized` — the only substring filter), `Jsonb.kt`, `LocalDateColumn.kt` (the `DATE` column), `MultiRowInsert.kt` (`insertRows`/`upsertRows`/`insertRowsIgnoringConflicts`), `StatementTimeoutCache.kt` (only `queryTimeout` may set `STATEMENT_TIMEOUT`), `LeakedSocketGuard.kt`, `DetachingConnectionFactory.kt` (pool hygiene, `persistence.md`).
- `infra/paging/` — the shared list-endpoint machinery (Lettuce's, ported verbatim; `list-endpoints.md`).
- `infra/validation/` — cross-feature input helpers (`sanitizeSingleLine`: trim + control-char 400; `Dates.kt`: `parseIsoDate`, `requireDateOrder`).
- `infra/outbound/` — `OutboundGuard.kt`, the SSRF guard for EVERY server-initiated call (address check, `GuardedDns`, origin rule, no proxy/redirects); no consumer yet, binding guidance in `security.md` "Outbound HTTP calls".
- `infra/json/` — `CanonicalJson.kt` (canonical JSON + sha256 for stored payloads), `JsonArrays.kt`.
- `infra/time/` — `Millis.kt`, `MILLIS_PER_DAY` (the fixed-24h-day constant), `WorkingCalendar.kt` (the pure working-day calendar, Flow's `WorkingDayIndex` ported over the closed-form Mon–Fri index; the kernels take it as a parameter, `MON_FRI` = no holidays; the views load the V19 dictionary).
- `infra/config/` — `requireConfigInt`/`requireConfigLong`, boot-validated numeric config (Lettuce's).
- `infra/Failures.kt` — `catchingFailures` (keeps the failure without swallowing cancellation).
- `audit/` — the security audit trail: `audit(event, fields…)` → AUDIT-marked structured logs.
- `authz/` — `CallerPrincipal`, the guards (`requireAdmin`, `requireSelfOrAdmin`, `requireTeamManagerOrAdmin` (the milestone schedule PUT), `requireRoadmapEditorOrAdmin`, the owner-chain pair) and the typed HTTP exceptions (401/403/404/409/429; `ConflictException.cycle` carries the dependency-cycle path).
- `auth/` — login (+ the email-MFA second step), refresh, logout, self-service password reset, token minting, password hashing, the revoked-token blocklist; in-memory auth state is capacity-bounded with audited 429 saturation.
- `users/` — the user domain (Astrolabe's own login accounts, REST `/api/v1/users`): ADMIN-only CRUD (self-delete 403, last-admin 409), per-user feature flags (`Feature` enum, the V5 disabled-set model; MFA is the inverted-default login-scoped flag), per-user permissions (`Permission`, the V11 grant set read per request, never a token claim), the ONE synced per-user UI+email language (`Languages.kt` is the `SUPPORTED_LANGUAGES` whitelist).
- `people/` — the people directory (V10; REST `/api/v1/people`): GET any authenticated (emails included), POST/PUT/DELETE ADMIN only; an optional email and an optional login link (`people.user_id`), the owners and managers of the plan.
- `teams/` — flat teams (V6) with an optional manager (a person since V10): GET any authenticated, POST/PUT/DELETE ADMIN only; and the team's capacity periods (V16, `TeamCapacityRoutes.kt`: man-days per week + an optional WIP limit from any date, written by the team's manager or ADMIN, team data). **The feature template** (below).
- `planning/` — work streams, programs, projects (V12), milestones (V14: dates only by the team's manager/ADMIN), dependencies (V15: the SUCCESSOR's chain writes, cycle-checked on the time-point graph), `GET /views/plan`, `GET /views/project/{id}` (derived span + drift, links on working days, `criticalPath` + per-milestone slack over the whole chain: pure `CriticalPathKernels`), `GET /views/team/{id}` (the weekly load against prorated capacity and WIP: pure `LoadKernels`); both views' `idleGaps` (3+ idle working days: pure `IdleGapKernels`), the global project rank (V13, `/roadmap/ranking`; `GET /views/roadmap` adds spans, drift and inversion flags, rolled-up links: pure `RoadmapKernels`; `GET /views/programs` the plan tree with derived spans and flag roll-ups), the team milestone order (V17, `PUT /teams/{id}/milestone-order`: the team's own execution order, the project rank only its default), the public-holiday dictionary (V19, `/public-holidays`: ADMIN registry + Polish preset, a plan write, read once per view into the `WorkingCalendar`): owner-scoped writes under the `plan_state` lock; pure `PlanPermissions` kernel.
- `telemetry/` — per-process JVM/cgroup/request/storage samples in `ops.*` (V9), 90 days, hourly, ADMIN read API (`observability.md`).

**Feature template — copy `teams/`** (a small ADMIN-curated registry; the only shape the foundation ships). Before adding a feature, route, service, migration or page, read `.claude/docs/conventions.md` in full.

### The OpenAPI contract

`server/src/main/resources/openapi/documentation.yaml` is hand-maintained and authoritative: every endpoint change edits it in
the same commit. The server suite validates every test-client `/api/` interaction against it (`OpenApiConformance.kt`,
`-Dopenapi.conformance=fail`); the frontend derives its types from it (`npm run gen:api` → committed `web/src/api/schema.ts`,
regenerated in the same commit). The file says `openapi: 3.1.0` but must use only 3.0-compatible constructs
(`OpenApiSpecTest`). `AnonymousAccessTest` sweeps every operation without `security: []` for a 401 — the "401 sweep" — so a new
route is covered the moment its spec entry lands. `info.version` equals `APP_VERSION` (`app-releases.md`).

### Cross-cutting conventions

Two docs apply to nearly every change and are always loaded:

@.claude/docs/testing.md
@.claude/docs/list-endpoints.md

Every other convention doc is **read on demand, not imported** (together they exceed the instruction-size budget) but binding:
**before touching an area, read its doc in full** (and name it in any implementer/reviewer brief). When a doc and this file
disagree, the doc wins. The always-loaded set (this file plus the two imports) stays under 36,000 bytes (`AlwaysLoadedDocsBudgetTest`).

| Doc | Read before you touch |
|---|---|
| `.claude/docs/conventions.md` | adding a feature, route, service, migration or page: the `teams/` feature template (DTO + validator, routes, service, migration + checksum pin, spec paths, `gen:api`, lazy page + nav entry, e2e spec + scenario) |
| `.claude/docs/persistence.md` | any migration (`db/migration/V*.sql`, V1–V19 today — applied bytes are immutable, `MigrationChecksumTest`), an Exposed table/`*Service.kt`, soft delete, a cross-feature table read/write (the list there IS the permission), the connection pool, the `ops` schema |
| `.claude/docs/security.md` | auth/JWT/MFA/password reset, rate limits, headers/CSP, outbound HTTP (the SSRF guard), secrets/encryption at rest, production fail-closed startup checks, payload validation |
| `.claude/docs/authorization.md` | any route: its guard (ADMIN vs any authenticated), 403-before-400/404 ordering, existence disclosure, the error/`ProblemDetail` mapping |
| `.claude/docs/observability.md` | any mutation or denial path (it needs an `audit(...)` event, listed there), logging, OpenTelemetry, health probes, the telemetry panel's server side |
| `.claude/docs/ci.md` | a CI job (ids and list), Dependabot rule or static-analysis config; the full-stack/Kubernetes notes and the sibling port table |
| `.claude/docs/product.md` | the per-version roadmap, the user's domain decisions, assumptions; what each donor repo contributed and what to port later |
| `.claude/docs/planning-model.md` | the planning domain: plan structure, lock, guards; milestones … capacity (sketch) |
| `.claude/docs/timeline.md` | the shared `Timeline*` component and the Gantt-like pages: the approach and measured figures |
| `.claude/docs/test-fixtures.md` | any server test fixture, the harness, fork warm-up, OpenAPI conformance internals, e2e scenario files, Schemathesis |
| `.claude/docs/web-internals.md` | the `web/` transport/session layer, user/feature-flag pages, language switcher, colour tokens/logo, changelog wiring |
| `.claude/docs/dependencies.md` | any dependency, image or runtime-pin change |
| `.claude/docs/dependency-reproducibility.md` | lockfiles or `gradle/verification-metadata.xml` (the empty-`GRADLE_USER_HOME` rule) |
| `.claude/docs/app-releases.md` | a version bump, changelog entry, tag or GitHub release |
| `.claude/docs/build-times.md` | any CI/build/test-time change; when a gate gets slower (`scripts/timings/`, budgets — PROVISIONAL until the v0.1.0 re-baseline) |

A new doc under `.claude/docs/` gets a row here, not an `@` import.

### Frontend (`web/`)

See `web/CLAUDE.md` for the frontend conventions (flat directories, co-located tests, typed i18n
with EN/PL parity, the transport layer, theming — the deep-cyan `astrolabe` brand is the interactive accent
only; red = blocking, orange = warning, green = success).
