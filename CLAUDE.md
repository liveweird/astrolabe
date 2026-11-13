# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Product

Astrolabe is a planning and roadmapping app (Jira-Plans-like, better UX, more opinionated, Gantt-centred) for a multi-stream / multi-program / multi-team environment, at a scale of about
15 teams, 5 work streams, 20 programs, 100 projects and 1,000 milestones. It keeps its **own** plan data; it reads Jira and Flow to **detect deviations** and, on request, import its items (corrections are made
in Astrolabe, never written back).

**Hierarchy (4 levels):** work stream (owner; end set only on close) → program (owner; span derived from its projects) → project (owner; optional target window; real span derived from its
milestones) → milestone (start/end, man-day estimate, exactly one team, no owner). **Four views**, all on one shared timeline component: the **project** view (its milestones), the **team** view
(its milestones against capacity), the **roadmap** (projects by one global rank, and in time) and the **programs** view. **Planning flow:** build the hierarchy and rank the projects; the
team manager schedules milestones (manual drag/resize, or accept a server proposal); dependencies (FS/SS/FF/SF + lag) and capacity overload only ever **warn**, never move anything.

**Roadmap:** 0.1–0.9 the plan, timelines, dependencies, capacity, auto-proposal, baselines · 1.0.0 checkup · 1.1–1.4 Jira sync, import, polling, coverage · 1.5–1.6 Flow, capacity · 1.7–1.8 planning, cross-team run · 1.9–1.13 follow-ups and fixes · 1.13.3 overnight fixes · 1.13.4 import search · **1.14.0 (current)** import under a linked node, coverage · next 1.15. Per-version scope, decisions, assumptions: `.claude/docs/product.md`. Open items: `BACKLOG.md`.

Brand: deep cyan (the `astrolabe` colour tuple in `web/src/theme.ts`, `primaryShade: { light: 8, dark: 9 }`); the logo a stylised astrolabe.

## Donors

**Flow is the primary donor**: this repository started as a trimmed exact copy of Flow (`~/Sources/flow` @ `e9c3b726`, Flow 1.35.0); Covenant, Lettuce and Toadie came in through it.
**Port, don't reinvent**: when a sibling already has a capability Astrolabe needs, port it. What each donated: `.claude/docs/product.md` "Donors". Ported for 1.1.0: `fetch/`, the Jira client slice, `EncryptedAtRest`/`Reencrypt`, the WireMock stub (port 8096); after 1.4.0: the weight-balanced test-fork order (`balancedCandidateOrder`, `server/test-weights.tsv`).

## Commands

Gradle wrapper: `./gradlew`. JDK 21 toolchain is required
(auto-provisioned via foojay-resolver; the local dev JDK is pinned in `mise.toml` —
`temurin-21.0.13+9.0.LTS`, Node 24.22.1). Run `mise install` once, then `mise exec -- <command>`
or activate mise. If `./gradlew` resolves the wrong JDK, point it explicitly: `JAVA_HOME=$(mise where java) ./gradlew build`.

- All local gates, timed like CI: `scripts/gates.sh [server|web|e2e|all]` (stops at the first failure; `ASTROLABE_FORKS=N` test forks, default 2, CI runs 1; `.claude/docs/build-times.md`)
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
- **Run the whole stack with one command: `docker compose up --build`** (only Docker required; "Running the full stack" below).
- Frontend: `cd web && npm install --legacy-peer-deps`, then
  `npm run dev|build|lint|test|test:coverage|knip|gen:api` (details in `web/CLAUDE.md`). The
  API-contract gate is `npm run lint:api` (Spectral lint of the OpenAPI spec + the conformant
  fixture against `api-guidelines/`) and `npm run check:api` (in-memory spec → `schema.ts` diff).
- E2E: `cd e2e && npm ci && npx playwright install chromium && npm test` (plus `lint`, `knip`, `typecheck`, `check:scenarios`, `test:setup`).
- CI: `.github/workflows/ci.yml` re-runs every gate above on push/PR; the blackbox Playwright suite (`e2e.yml`) runs
  nightly and on demand. The job list, the Markdown-only skip, Trivy and
  grouping: `.claude/docs/ci.md` (dependency rules: `dependencies.md`, `dependency-reproducibility.md`).

## Running the full stack

`docker compose up --build` serves everything at `http://localhost:8086` (sign in as `admin@astrolabe.local`; the README
has the initial password). Local dev: `docker compose up postgres mailpit` (Postgres on host port
**5437**, Mailpit UI **8029**) + `./gradlew :server:run` (API on **8086**) + `cd web && npm run dev` (Vite on **5178**,
proxying `/api`), each in its own terminal; the ports avoid the sibling repos' and bind to 127.0.0.1 only. The sibling port table, Mailpit and the Kubernetes (OrbStack) `astrolabe`
namespace: `.claude/docs/ci.md` "Running the full stack".

## Architecture

Astrolabe is Flow's generic foundation under the planning domain: **JWT auth**
with a sliding refresh pair and a server-side revocation blocklist, opt-in **email MFA**, self-service password reset,
per-account lockout and per-IP rate limits, **ADMIN-managed users** (`/api/v1/users`, `UserRole`) with per-user **feature flags**
and a synced UI/email **language** (EN/PL), the **people** directory (the owners and managers of the plan, optionally linked to a login), flat **teams** (the unit milestones belong to) with an optional manager (a person), the ADMIN **telemetry** panel, and the React
shell (nav model, palette, theme, changelog). Every feature follows the feature template below.

Multi-module Gradle build (Kotlin DSL) defined in `settings.gradle.kts` with two Kotlin modules
plus two standalone npm workspaces (Gradle never touches them):

- **`core`** — Kotlin Multiplatform (JVM target only). Shared code for `server`.
  Holds the OpenTelemetry SDK bootstrap (`getOpenTelemetry(serviceName)`).
- **`server`** — Kotlin/JVM. The Ktor application. Depends on `core`. One process, no worker.
- **`web/`** — Vite + React + TypeScript SPA over the server's HTTP API.
- **`e2e/`** — Playwright blackbox suite against the compose stack.

Group `ch.nokillswit`, version `1.0.0-SNAPSHOT` (the donor's; renaming is out of scope). Dependency
versions are centralized in `gradle/libs.versions.toml` (every pin carries its rationale; Ktor comes from the separate `ktorLibs`
catalog). Resolved Gradle dependencies use strict locking and SHA-256 verification; intentional updates follow
`.claude/docs/dependency-reproducibility.md`.

### Server bootstrap model

`server/src/main/kotlin/main.kt` is `EngineMain` plus `rearmReadTimeout`. The
application is wired declaratively in `server/src/main/resources/application.yaml` under
`ktor.application.modules` — each entry is a fully-qualified extension function on `Application`
(`ch.nokillswit.plugins.HttpKt.configureHttp`). **Module order is load-bearing**: base plugins
(Http → SecurityHeaders → Monitoring → Serialization → Security → RateLimits → ErrorHandling → OpenTelemetry → AutoHeadResponse → Resources) →
infra (Mail → Crypto → Flyway → Database → Bootstrap → Health) → Telemetry (the sampler) → feature route modules (users, people, teams, planning, `configureJira` → `configureFlow` → `configureSync` → the Jira, Flow and deviation routes, auth, password reset, telemetry reads) →
`RoutingKt.configureRouting` strictly last (the SPA catch-all). `configureDatabase` publishes the services into `Application.attributes` via `AttributeKey`s. To add a cross-cutting concern,
create a `configureXxx()` extension under `plugins/` and register it in `application.yaml`, not `main.kt` (whose one addition is the engine-level `rearmReadTimeout`). There is no DI framework — services travel via `attributes`.
There is no role switch (Flow's `FLOW_ROLE` split is not ported; `product.md` "Donors").

### Package layout

Source files sit flat under `server/src/main/kotlin/<area>/` but declare `package ch.nokillswit.<area>`
(no `ch/nokillswit` directory nesting — the deliberate `InvalidPackageDeclaration` detekt override). One line per package; `ls` gives the files. **Layering is one-way (`PackageBoundaryTest`):** `infra/` imports no feature package except the composition root (`infra/db/Database.kt`, `Bootstrap.kt`); `telemetry/` is imported by nothing; `sync/` imports no connector (`jira/`, `flow/` register themselves); `planning/` reads nothing of `jira/`.

- `plugins/` — cross-cutting Ktor wiring (`configureXxx` that only `install` plugins; Security = JWT, ErrorHandling = RFC 7807; `ReadTimeout` = Netty pipeline code, not a module). `Routing` (the SPA catch-all) is registered strictly last; `Health` (`/api/v1/health`, `/api/v1/ready`) is registered after Database; `RateLimits` holds every per-IP bucket (and the per-user `telemetry` one); `ResponseValidators` is the `ETag` seam for future view GETs.
- `infra/mail/` — outbound email (Lettuce's, ported): `MAIL_TRANSPORT` log/smtp/disabled; the `log` transport is refused in production (fail-closed); a null mailer = email features answer 503.
- `infra/crypto/` — encryption at rest (Lettuce's, ported): `FieldCipher` (AES-256-GCM `enc:v1:` envelopes, a fresh nonce per value, current + rotation key), `configureCrypto` (`DATA_ENCRYPTION_KEY`; a burned key fails startup closed), `EncryptedAtRest`/`Reencrypt` (the boot backfill).
- `infra/db/` — Flyway bootstrap, the R2DBC composition root, the seed bootstrap (admin rotation, prod fail-closed), `SoftDelete.kt` (`SoftDeletable`: ONE `active()` predicate, `nowMillis()`, `lockActiveForWrite`), `Sql.kt` (`containsNormalized` — the only substring filter), `Jsonb.kt`, `LocalDateColumn.kt` (the `DATE` column), `MultiRowInsert.kt` (`insertRows`/`upsertRows`/…), `StatementTimeoutCache.kt` (only `queryTimeout` sets `STATEMENT_TIMEOUT`), `LeakedSocketGuard.kt`, `DetachingConnectionFactory.kt` (pool hygiene, `persistence.md`).
- `infra/paging/` — the shared list-endpoint machinery (Lettuce's, ported verbatim; `list-endpoints.md`).
- `infra/validation/` — cross-feature input helpers (`sanitizeSingleLine`: trim + control-char 400; `Dates.kt`: `parseIsoDate`, `requireDateOrder`).
- `infra/outbound/` — `OutboundGuard.kt`, the SSRF guard for EVERY server-initiated call (address check, `GuardedDns`, origin rule, no proxy/redirects); its consumers are `jira/` and `flow/`, binding guidance in `security.md` "Outbound HTTP calls".
- `infra/json/` — `CanonicalJson.kt` (canonical JSON, sha256, `fingerprintOf`), `JsonArrays.kt`.
- `infra/time/` — `Millis.kt` (`MILLIS_PER_DAY`), `WorkingCalendar.kt` (the pure working-day calendar, Flow's `WorkingDayIndex` ported; kernels take it as a parameter, `MON_FRI` = no holidays; views load the V19 dictionary).
- `infra/config/` — `requireConfigInt`/`requireConfigLong`, boot-validated numeric config (Lettuce's).
- `infra/Failures.kt` — `catchingFailures` (keeps the failure without swallowing cancellation).
- `audit/` — the security audit trail: `audit(event, fields…)` → AUDIT-marked structured logs.
- `authz/` — `CallerPrincipal`, the guards (`requireAdmin`, `requireSelfOrAdmin`, `requireTeamManagerOrAdmin`, `requireRoadmapEditorOrAdmin`, the owner-chain pair) and the typed HTTP exceptions (401/403/404/409/429).
- `auth/` — login (+ the email-MFA second step), refresh, logout, self-service password reset, token minting, password hashing, the revoked-token blocklist; in-memory auth state is capacity-bounded with audited 429 saturation.
- `users/` — the user domain (Astrolabe's own login accounts, REST `/api/v1/users`): ADMIN-only CRUD (self-delete 403, last-admin 409), per-user feature flags (`Feature` enum, the V5 disabled-set model; MFA is the inverted-default login-scoped flag), per-user permissions (`Permission`, the V11 grant set read per request, never a token claim), the ONE synced UI+email language (`Languages.kt`: the `SUPPORTED_LANGUAGES` whitelist).
- `people/` — the people directory (V10; REST `/api/v1/people`): GET any authenticated (emails included), POST/PUT/DELETE ADMIN only; optional email and login link (`people.user_id`), the owners and managers of the plan.
- `teams/` — flat teams (V6) with an optional manager (a person since V10): GET any authenticated, POST/PUT/DELETE ADMIN only; and the team's capacity periods (V16, `TeamCapacityRoutes.kt`: man-days per week + an optional WIP limit from any date, written by the team's manager or ADMIN, team data).
- `planning/` — work streams, programs, projects (V12), milestones (V14), dependencies (V15), the global rank (V13), team order (V17), holidays (V19), baselines (V20); the five views, the auto-proposal and cross-team run over pure kernels (`*Kernels.kt`); owner-scoped writes under the `plan_state` lock, pure `PlanPermissions` (`planning-model.md`).
- `infra/fetch/` — the bounded outbound transport (Flow's, ported): retry/backoff, permits, size and page ceilings.
- `jira/` — the Jira sync (V21–V23, V27–V30, `/api/v1/integrations/jira`, `GET /views/deviations`, `GET /views/jira-links`): the ADMIN registry (token encrypted), probes, mapping, 1:1 bindings, observer, census, deviation kernel, import, acknowledge, flag source; routes per concern (`jira-sync.md`).
- `flow/` — the Flow sync (V24, `/api/v1/integrations/flow`, `GET /teams/{id}/flow`, `GET /views/capacity-deviations`; stub-proven): the ADMIN registry (token encrypted), probes, run, mirror, bindings by name, the capacity import (preview, apply via `teams/`), the deviation kernel, the per-sprint and all-open acknowledge (V26), `FlowFlagSource` (the team view's capacity flag through `planning`'s seam); `sync/`, `planning/`, `teams/` name nothing of it, nor it of `jira/` (`flow-sync.md`).
- `sync/` — the connector-agnostic run registry (`sync_runs`, unique-index claim), its executor, the poll scheduler, the connection status and the shared acknowledge vocabulary (`Acknowledge.kt`).
- `telemetry/` — per-process JVM/cgroup/request/storage samples in `ops.*` (V9), 90 days, hourly, ADMIN read API (`observability.md`).

**Feature template — copy `teams/`** (a small ADMIN-curated registry; the only shape the foundation ships). Before adding a feature, route, service, migration or page, read `.claude/docs/conventions.md` in full.

### The OpenAPI contract

`server/src/main/resources/openapi/documentation.yaml` is hand-maintained and authoritative: every endpoint change edits it in
the same commit. The server suite validates every test-client `/api/` interaction against it (`OpenApiConformance.kt`,
`-Dopenapi.conformance=fail`); the frontend derives its types from it (`npm run gen:api` → committed `web/src/api/schema.ts`,
regenerated in the same commit). The file says `openapi: 3.1.0` but must use only 3.0-compatible constructs
(`OpenApiSpecTest`). `AnonymousAccessTest` sweeps every operation without `security: []` for a 401 (the "401 sweep"), so a new
route is covered once its spec entry lands. `info.version` equals `APP_VERSION` (`app-releases.md`).

### Cross-cutting conventions

Two docs apply to nearly every change, always loaded:

@.claude/docs/testing.md
@.claude/docs/list-endpoints.md

Every other convention doc is **read on demand, not imported** (together they exceed the size budget) but binding:
**before touching an area, read its doc in full** (and name it in any implementer/reviewer brief). When a doc and this file
disagree, the doc wins. The always-loaded set (this file plus the two imports) stays under 36,000 bytes (`AlwaysLoadedDocsBudgetTest`).

| Doc | Read before you touch |
|---|---|
| `.claude/docs/conventions.md` | adding a feature, route, service, migration or page: the `teams/` feature template (DTO + validator, routes, service, migration + checksum pin, spec paths, `gen:api`, lazy page + nav entry, e2e spec + scenario) |
| `.claude/docs/persistence.md` | any migration (`db/migration/V*.sql`, V1–V30 today — applied bytes are immutable, `MigrationChecksumTest`), an Exposed table/`*Service.kt`, soft delete, a cross-feature table read/write (the matrix there IS the permission), the connection pool, the `ops` schema |
| `.claude/docs/security.md` | auth/JWT/MFA/password reset, rate limits, headers/CSP, outbound HTTP (the SSRF guard), secrets/encryption at rest, production fail-closed startup checks, payload validation |
| `.claude/docs/authorization.md` | any route: its guard (ADMIN vs any authenticated), 403-before-400/404 ordering, existence disclosure, the error/`ProblemDetail` mapping |
| `.claude/docs/observability.md` | any mutation or denial path (it needs an `audit(...)` event, listed there), logging, OpenTelemetry, health probes, the telemetry panel's server side |
| `.claude/docs/jira-sync.md` | the Jira sync: gateway, probes, mapping, bindings, run, deviations, stub, real-site walk-through, assumptions ledger |
| `.claude/docs/flow-sync.md` | the Flow sync: transport, probes, run, bindings, capacity import, stub, real-Flow walk-through, ledger |
| `.claude/docs/ci.md` | a CI job (ids, list), Dependabot rule, static-analysis config; the full-stack/Kubernetes notes, the sibling port table |
| `.claude/docs/product.md` | the per-version roadmap, the user's domain decisions, assumptions; what each donor contributed, what to port later |
| `.claude/docs/planning-model.md` | the planning domain: plan structure, lock, guards; milestones … capacity (sketch) |
| `.claude/docs/timeline.md` | the shared `Timeline*` component and Gantt-like pages: approach, measured figures |
| `.claude/docs/test-fixtures.md` | any server test fixture, the harness, fork warm-up, OpenAPI conformance internals, e2e scenario files, Schemathesis |
| `.claude/docs/web-internals.md` | any `web/` page's mechanics (per page, nav order), the transport/session layer, i18n, colour tokens/logo, changelog |
| `.claude/docs/dependencies.md` | any dependency, image or runtime-pin change |
| `.claude/docs/dependency-reproducibility.md` | lockfiles or `gradle/verification-metadata.xml` (the empty-`GRADLE_USER_HOME` rule) |
| `.claude/docs/app-releases.md` | a version bump, changelog entry, tag or GitHub release |
| `.claude/docs/build-times.md` | any CI/build/test-time change; when a gate gets slower (`scripts/timings/`, budgets) |

A new doc under `.claude/docs/` gets a row here, not an `@` import.

### Frontend (`web/`)

See `web/CLAUDE.md` for the frontend conventions (flat directories, co-located tests, typed i18n
with EN/PL parity, the transport layer, theming — the deep-cyan `astrolabe` brand is the interactive accent
only; red = blocking, orange = warning, green = success).
