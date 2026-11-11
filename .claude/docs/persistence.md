### Persistence

PostgreSQL is the only database. Connection settings come from the `postgres:` block in
`application.yaml` (env-overridable via `POSTGRES_JDBC_URL`, `POSTGRES_R2DBC_URL`,
`POSTGRES_USER`, `POSTGRES_PASSWORD`); defaults match the `docker compose up postgres` service
(host port **5437** — the sibling repos occupy 5432–5436 on the same machine, table in `ci.md`;
in-network consumers use `postgres:5432`). There is one persistence stack:

- **Flyway** (`infra/db/Flyway.kt`) — runs schema migrations from
  `server/src/main/resources/db/migration/` at startup via the Java API, opening a short-lived
  JDBC connection. Migrations are the single source of truth for schema; do not call
  `SchemaUtils.create` anywhere. **An applied migration's bytes are immutable — comments
  included**: Flyway validates stored checksums at startup, so any edit to an existing `V*.sql`
  makes every long-lived database refuse to boot (a failure no fresh-container CI run can see).
  `MigrationChecksumTest` pins every file's checksum; a new migration adds one manifest line, and
  a red pin means REVERT the edit (clarifications go into this doc), never update the pinned
  value. The range today is **V1–V27**: V1 `users`, V2 `revoked_tokens`, V3 the seed admin, V4 the
  `unaccent` extension, V5 `user_disabled_features` (V1–V5 are Flow's), V6 `teams` (with the optional
  manager), V7 `users.credential_revision`, V8 `password_reset_tokens`, V9 the `ops` telemetry
  schema, V10 `people` (the people directory) with `teams.manager_person_id` replacing `manager_user_id`, V11 `user_permissions` (the per-user permission grants), V12 `plan_state` + `work_streams`/`programs`/`projects` (the plan structure), V13 `roadmap_entries` (the global project rank), V14 `milestones` (the fourth plan level), V15 `dependencies` (links between milestones and projects), V16 `team_capacity_periods` (a team's man-days per week and optional WIP limit from an effective-from date), V17 `team_milestone_orders` + `team_order_state` (a team's own milestone order and its revision), V18 `plan_state.ranking_revision` (the ranking's own revision: the plan revision at which `roadmap_entries` was last written; the ranking PUT compares against it, `planning-model.md` "The global project rank"), V19 `public_holidays` (the global ADMIN-curated holiday dictionary, no seed; `planning-model.md` "The calendar (V19)"), V20 `baselines` + `baseline_projects` + `baseline_milestones` (the named plan snapshots: a soft-deleted header and two FROZEN row tables, trigger-enforced; "The baselines (V20)" below), V21 `jira_connections` + `jira_bindings` + `jira_observations` + `sync_runs` (the Jira sync: the connection registry with the first encrypted-at-rest column, the 1:1 bindings, the latest observation per binding and the run registry; "The Jira sync tables (V21)" below), V22 `jira_connections.poll_interval_minutes` + the three `jira_bindings.ack_*` columns (polling and acknowledge-until-changed, 1.3; "The Jira sync tables (V21)" below), V23 `jira_issues` + `jira_connections.census_at` (the Jira census mirror, 1.4; "The Jira census (V23)" below), V24 `flow_connections` + `flow_teams` + `flow_sprints` + `flow_members` + `flow_team_bindings` + `team_capacity_periods.source`/`flow_sprint_id`/`flow_sprint_name` (the Flow sync, 1.5: the second encrypted-at-rest registry, a wholesale-replaced mirror of Flow's one document, the team bindings and the provenance of a capacity period; "The Flow sync tables (V24)" below), V25 `milestones.pinned` + `ck_milestones_pinned_scheduled` (the milestone pin, 1.7: a pinned milestone is fixed for the auto-proposal; "The milestone pin (V25)" below), V26 `flow_capacity_acknowledgements` (the per-sprint acknowledge of a Flow capacity deviation, 1.9; "The capacity acknowledgements (V26)" below), V27 `jira_observations.gone_probed_at` (the Jira gone-probe's answer stamp, 1.10: a failed, cut or over-cap probe stays NULL and is retried by a later run; `ck_jira_observations_gone_probed` CHECK (`gone_probed_at IS NULL OR gone`); "The Jira sync tables (V21)" below). (Astrolabe renumbered Flow's history when it was bootstrapped; from V10 on, migrations are
  append-only like any other.)
- **Exposed + R2DBC** (`infra/db/Database.kt` + the feature services) — runtime DB access.
  `Database.kt` connects the `R2dbcDatabase` and is the composition root: it constructs the
  services and publishes them into `Application.attributes` (`UserServiceKey`, `PersonServiceKey`, `TeamServiceKey`, the planning keys (`BaselineServiceKey` since V20, `JiraConnectionServiceKey` since V21),
  `TokenBlocklistServiceKey`, `PasswordResetServiceKey` today); each service itself lives next to the feature it serves
  (`users/UserService.kt`, `people/PersonService.kt`, `teams/TeamService.kt`, `planning/{WorkStream,Program,Project,Milestone,Dependency,PlanView,Roadmap}Service.kt`, `auth/TokenBlocklistService.kt`, `auth/PasswordResetService.kt`, `jira/JiraConnectionService.kt`). The Exposed
  table `object`s (e.g. `UserService.Users`, nested inside their service) are used for queries
  only, not DDL. Ids are `UIntIdTable` — unsigned end-to-end (the spec declares `minimum: 0`, and
  `ErrorHandling.kt` 400s negative path segments before kotlinx's `UInt` decoding can silently
  wrap them); one wrinkle inherited from Toadie: V1 creates `users.id` as `BIGSERIAL` (64-bit in
  SQL, 32-bit everywhere above it) while `teams` uses `SERIAL`/`INTEGER` — harmless at this scale,
  documented so nobody "fixes" one to match the other without a migration (an `INTEGER` FK column
  may reference the `BIGINT` id; Postgres compares them fine).

The `org.postgresql:postgresql` JDBC driver is on the classpath solely for Flyway; runtime queries
go through R2DBC.

### Connection pool

- **Applies when:** touching `infra/db/Database.kt`'s connect call, the `postgres.pool.*`
  configuration, or reasoning about how many PostgreSQL backends one Astrolabe instance can hold.
- **Requirement:** Exposed connects through ONE bounded `io.r2dbc:r2dbc-pool` `ConnectionPool`
  (ported from Lettuce via Flow) wrapping the plain PostgreSQL R2DBC factory, built by the one shared
  `connectPooledDatabase` (the test harness's direct `sharedDatabaseForTests()` uses it too, with a
  small pool of its own) — never a raw `r2dbc:postgresql://` connect, which opens one backend per `suspendTransaction` with nothing
  capping concurrency (measured in Lettuce: 120 parallel requests took ALL 100 backends of PostgreSQL's default `max_connections`;
  the JWT validation's blocklist read failed and surfaced as an invalid token — so a throwing blocklist lookup answers the
  catch-all's 500, never 401, see "JWT model" in `.claude/docs/security.md`).
  Bounds come from `application.yaml`'s `postgres.pool` block, each boot-validated (startup fails
  outside the range, via the shared `infra/config/` `requireConfigInt`/`requireConfigLong` helpers): `maxSize`
  (`POSTGRES_POOL_MAX_SIZE`, default 20, 1..1000), `initialSize` (`POSTGRES_POOL_INITIAL_SIZE`,
  default 2, 0..maxSize — the floor the pool fills up to on its FIRST acquire, not at
  construction: r2dbc-pool warms up lazily and `warmup()` is deliberately not called),
  `maxAcquireTimeSeconds` (`POSTGRES_POOL_MAX_ACQUIRE_SECONDS`, default 10,
  1..600) and `maxIdleTimeSeconds` (`POSTGRES_POOL_MAX_IDLE_SECONDS`, default 600, 1..86400). Every
  pooled connection carries `application_name = astrolabe` (`postgres.pool.applicationName`, test-only
  override), so operators count this instance's backends with
  `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'astrolabe'`. The driver's per-connection
  prepared-statement cache is bounded (`PREPARED_STATEMENT_CACHE_QUERIES` = 256 in `Database.kt`, applied in
  `connectPooledDatabase`, so the test pool has it too; r2dbc-postgresql's default is unbounded and every cached text stays a
  named server-side statement for the connection's life) — it matters because `MultiRowInsert.kt`'s SQL text varies with the row count
  (quantized to a handful of sizes per table). **A multi-row statement is bounded in payload as well as in bind parameters**:
  `MultiRowInsert.kt` also splits a batch so one statement binds at most `MAX_PAYLOAD_CHARS` (1 MiB) of `String` values (a lone
  heavier row goes alone, never refused there). `insertRows` / `insertRowsIgnoringConflicts` build each row (run the caller's body)
  lazily, only while the statement that carries it is assembled, so the rows in flight are one statement's cap, not the call's, and
  each body runs exactly once (`upsertRows` builds them all first: its collapse of repeated keys needs every key). Exposed lists every
  statement a transaction ran until it ends (parsed SQL and encoded parameters included): `insertRows` clears the list after each statement.
- **Statement timeouts: use the transaction's `queryTimeout`, nothing else.** Exposed's R2DBC executor *requests* the
  transaction's `queryTimeout` (whole seconds, default 0, never null) from the driver before EVERY statement. The telemetry reads
  use it (`queryTimeout` 5 s, "Telemetry (V9)"). **The per-connection cache (`infra/db/StatementTimeoutCache.kt`).**
  r2dbc-postgresql answers each request with its own `SET STATEMENT_TIMEOUT` simple query that Exposed awaits — a large share of all
  round trips. `connectPooledDatabase` therefore wraps the RAW connection factory (below the pool) in
  `StatementTimeoutCachingConnectionFactory`: each physical connection remembers the value the server last confirmed, and the
  driver call is *sent* only when the requested value differs from it. No reset on release is needed — Exposed requests its
  value before every statement, so the borrower after a 30 s budget sees `0 != 30` and sends it, which is also why a budget
  never leaks to the next borrower. **The hazard it handles:** PostgreSQL reverts a session-level
  `SET` issued inside a transaction when that transaction rolls back, and a statement cancelled by the timeout aborts its
  transaction — a naive cache would then believe the budget is still set and run the next query unbudgeted. The remembered value
  is therefore forgotten on every rollback (also to a savepoint), on a failed commit and on `setAutoCommit(true)`, forgotten
  before a SET is sent and remembered only once it completed under an unchanged generation, and kept across a successful commit.
  **Rule: ONLY the transaction's `queryTimeout` may set the statement timeout.** A `SET LOCAL statement_timeout` may stay in
  force for the rest of its transaction (the cache no longer sends a request that matches its remembered value, so nothing
  overwrites it), and a session-level `SET`, `set_config(…, false)`, `RESET` or `DISCARD` on a pooled connection desyncs the cache
  from the backend. Deployment assumption: one client connection is one server session — a transaction-mode PgBouncer in front of
  Postgres would break the cache (none today). `StatementTimeoutCacheTest` (own one-connection pool) pins convergence, the
  rolled-back SET, the aborted-transaction canary, a budget enforced again after a cancelled statement, and the skip with its limit.
- **Sizing.** Size it as `maxSize × replicas + 1` (Flyway's short-lived JDBC connection, `infra/db/Flyway.kt`) well under
  the server's `max_connections`. `maxAcquireTimeSeconds` is a per-attempt deadline, and the effective
  bound is about 2× the setting. r2dbc-pool 1.0.2's `ConnectionPool` builds `create()` as
  `Mono.defer { acquire.flatMap(…).timeout(maxAcquireTime) }.retry(acquireRetry)` and the builder default is
  `acquireRetry = 1`: the timeout is an ordinary error to `retry`, so a timed-out waiter is
  re-queued at the BACK of the acquire queue for a second full deadline before the failure surfaces. Astrolabe keeps the
  default on purpose: the same retry is what transparently replaces a connection that fails `LOCAL` validation
  (`prepareConnection` invalidates it and the outer retry acquires another), so a connection closed from the driver
  side — a Postgres or pod restart, a FIN/RST on an idle socket — costs no request, whereas with
  `acquireRetry(0)` each such stale connection would fail one. After a Postgres restart the pool therefore heals itself as long as
  at most one stale connection is handed out per acquire; size `maxAcquireTimeSeconds` knowing a saturated pool fails after twice it
  (`ConnectionPoolTest` pins the ~2×). A caller that waits past the acquire deadline fails with the pool's timeout
  exception, which `plugins/ErrorHandling.kt`'s catch-all renders as a logged `500` — deliberately NOT a new declared status, since the
  OpenAPI conformance gate would need it on every operation. The pool is disposed on `ApplicationStopped`, so every `testApplication` the
  suite boots releases its connections. Exposed's `R2dbcDatabase.connect(connectionFactory, databaseConfig)` derives the dialect from
  `databaseConfig.connectionFactoryOptions` alone, so the parsed options (still `driver=postgresql`) are threaded into the config
  unchanged while traffic goes through the pool. The same config pins `defaultMaxAttempts = 1`: Exposed would otherwise retry ANY
  `R2dbcException` three times, and the pool's acquire timeout is one — a saturated pool would cost 3 × the acquire budget per request.
  **Dependency alignment:** r2dbc-pool declares an older reactor-pool than the reactor-core Astrolabe resolves, so
  `server/build.gradle.kts` imports the Reactor BOM (`reactor-bom` in `gradle/libs.versions.toml`) as a platform — it pins
  reactor-core, reactor-pool and reactor-netty as one release train, and `:server:checkDependencyAlignment` fails when any
  reactor module resolves to a version other than the BOM's. Move the `reactor-bom` catalog line together with the `netty` pin.
  Covered by `ConnectionPoolTest` (bounded concurrency, a saturated pool's acquire timeout, its ~2× deadline, disposal on
  `ApplicationStopped` and on a later module's failed startup, and the config range-check cases) and `checkDependencyAlignment`'s own Reactor guard.
- **A backend left holding its transaction.** Two defences, both on every pooled connection
  (built in `connectPooledDatabase`, so the test pool has them too). (1) `infra/db/LeakedSocketGuard.kt`: r2dbc-postgresql 1.1.3
  never closes the socket after a protocol-level connection error ("Response queue is full"). The backend then keeps its transaction
  and locks for the life of the process — `idle in transaction`, or `active` in `ClientWrite`, which no server timeout ends. A decorator
  on the RAW factory (below the pool, beside the statement-timeout cache) disposes the netty channel after the driver's close when the
  client is closed but the channel is open; the pool's release validation (`LOCAL`) fails such a connection at once and destroys it. It
  reads two private driver fields by reflection; `LeakedSocketGuardTest` pins them AND the driver bug on an unguarded connection (red
  after an upgrade = the upstream fix landed, delete the guard). (2) `idle_in_transaction_session_timeout`, sent as a startup parameter
  (`postgres.pool.idleInTransactionTimeoutSeconds`, `POSTGRES_POOL_IDLE_IN_TRANSACTION_TIMEOUT_SECONDS`, default 300, 0..86400, 0 = off;
  an operator's own `options=` key in the URL wins): the server ends any pooled session idle inside a transaction for longer — the
  backstop for a client that stopped talking with a transaction open (a coroutine stuck mid-transaction). No transaction may span an
  outbound call or a mail send. It is a different setting from the statement timeout, so the "only `queryTimeout`" rule is untouched.
  `LeakedSocketGuardTest` pins both.
- **A pooled connection must not pin the frame that created it.** reactor-netty keeps the subscriber
  chain of the `create()` that opened a channel on the channel (`ChannelOperations.listener`) for the channel's whole life
  (`maxIdleTimeSeconds` of idleness, never while the connection is reused). Through r2dbc-pool's allocator, the pool's borrower and
  Exposed's `awaitOne` that chain reached the continuation of the coroutine that happened to trigger the creation, so a finished
  request's frame stayed reachable from the netty selector for minutes. `infra/db/DetachingConnectionFactory.kt` ends the chain at a
  bridge: it subscribes to the real `create()` with a `DetachingBridge`, which forwards the one connection / error / completion to the
  pool and then DROPS the pool's subscriber. It offers the driver an EMPTY Reactor context (reactor-netty copies the subscriber context
  into the observer at connect time and keeps the copy for the channel's life). It is the OUTERMOST decorator of the raw factory in
  `connectPooledDatabase` so that a connection it closes is the decorated one (the close reaches the socket guard). It honours demand,
  delivers exactly once and CLOSES a connection nobody owns (it arrived after a cancel): never a leaked socket.
  `PooledConnectionPinTest` proves it with weak references on a fresh pool (a 16 MiB array held across the query, the function returned,
  the connection idle, `System.gc()` must clear it); its callers run on `Dispatchers.IO` (a test that runs the query directly on the
  `runBlocking` thread keeps a stale reference on that thread's own stack and is red either way). `DetachingConnectionFactoryTest`
  pins the contract without a database.
- **Exception:** the pool runs r2dbc-pool's defaults for liveness (`ValidationDepth.LOCAL`, no
  `maxLifeTime`): a connection killed server-side between uses is handed out once and fails that
  request with a 500 — accepted until a deployment introduces an idle killer or proxy.

### Cross-feature table reads AND writes (the service-layer rule, inherited from Lettuce)

A feature service MAY query — or WRITE — another feature's Exposed table objects directly when the operation must run **inside its own transaction** (SQL joins,
atomic snapshots, a single soft-delete that must also close a dependent row elsewhere) — the transaction boundary must be explicit rather than relying on an
unrelated service to preserve it. Exposed reuses an enclosing transaction for nested `suspendTransaction` calls on the same database. Route handlers never touch
tables (services only). The matrix below lists the reads/writes in place, one row per table; the protocol notes after it hold the locks, transactions and audits
per owner. The matrix IS the permission: a new cross-feature read or write adds its cell and its protocol line in the same commit.

**The matrix.** *Owner* is the service whose Exposed object declares the table. *Also read by* and *Also written by* name every other service that touches it,
inside or outside its package (a bare package name means every service of that package that needs it; the notes name them); a write through the owner's exported
function (`deleteCapacityPeriodsOf`, `removeFromRanking`, …) counts as the caller's. *Protocol* names the `####` notes below.

| Table (migration) | Owner | Also read by | Also written by | Protocol |
|---|---|---|---|---|
| `users` (V1; `credential_revision` V7) | `users/UserService` | `auth/` (`TokenBlocklistService.accessVerdict`: role, credential revision, deleted flag, by primary key, on every authenticated request; `PasswordResetService`: the liveness predicate and `FOR NO KEY UPDATE` on the row); `people/` (the active-login check, the login's email); `teams/` (`isActiveManager` and its twins join it); `planning/` (`creatorsOf`); `jira/` (`creatorsOf`, through `planning/`); `flow/CapacityAcknowledgeService` (the acknowledging login's display name, `creatorsOf` through `planning/`; `flow_capacity_acknowledgements.ack_by_user_id` references it); `plugins/Health.kt` (`id`, `LIMIT 1`) | `auth/PasswordResetService` (`password_hash`, `password_changed_at`, `credential_revision`, through `updatePasswordInTransaction`, in the transaction that consumes the grant) | `users/` + `auth/` |
| `user_disabled_features` (V5) | `users/UserService` | none | none | `users/` + `auth/` |
| `user_permissions` (V11) | `users/UserService` | none directly: the guards call `UserService.hasPermission` (a database read per request, never a token claim) | none | `users/` + `auth/` |
| `revoked_tokens` (V2) | `auth/TokenBlocklistService` | none (`plugins/Security.kt` asks `accessVerdict`) | none | `users/` + `auth/` |
| `password_reset_tokens` (V8) | `auth/PasswordResetService` | none | none | `users/` + `auth/` |
| `people` (V10) | `people/PersonService` | `teams/` (the manager's name, the manager check, `isActiveManager` and its twins); `planning/` (`ownerNames`, `requireActiveOwner`, the team view's manager, `creatorsOf`); `flow/CapacityAcknowledgeService` (the acknowledger's person name, `creatorsOf` through `planning/`); `jira/JiraImportService` (`requireShape`, `namedChains`); `jira/` bind, unbind, import and acknowledge and the `planning/` routes lock the caller's person through `PersonService.lockedActivePersonIdOf`; `planning/`, `jira/` (bind, import, acknowledge, the deviation routes) read it unlocked through `activePersonIdOf` | none | `people/`, `teams/`, `planning/` plan: `FOR SHARE` on the person row against `PersonService.delete`'s `FOR NO KEY UPDATE` |
| `teams` (V6; `manager_person_id` V10) | `teams/TeamService` | `people/` (the delete 409 while the person manages an ACTIVE team); `planning/` (milestone, dependency, order, schedule, proposal, cross-team run and view services, baselines); `jira/` (`JiraImportService`, `DeviationViewRows.kt`); `flow/` (`FlowTeamBindingService`, `FlowTeamService`, `CapacityAcknowledgeService` through `bindingOf`'s join and its guard) | none | `teams/`, `planning/` plan, `flow/`, `jira/` import: `FOR SHARE` on the team row (`requireActiveTeam`, `lockActiveTeam`, link, match, and the unbind's and the acknowledge's guard) against `TeamService.delete`'s `lockActiveForWrite` |
| `team_capacity_periods` (V16; `source` columns V24) | `teams/TeamCapacityService` | `planning/` (`TeamViewRows.kt`, `ScheduleProposalService`, `CrossTeamProposalService`, the `scopeHash` loader; the team view's Flow flag through the `ExternalFlagSource` seam, implemented by `flow/FlowFlagSource`: the view only asks); `flow/` (`CapacityImportService`, `CapacityDeviationService`) | `teams/TeamService.delete` (`deleteCapacityPeriodsOf`); `flow/` (the capacity import's apply, ONLY through `TeamCapacityService.applyImport`) | `teams/`: the team row `FOR NO KEY UPDATE` first, then the manager and person rows `FOR SHARE`; no plan lock |
| `plan_state` (V12; `ranking_revision` V18) | `planning/` (`PlanState.kt`: `withPlanWrite`, `readPlanRevision`, `readRankingRevision`) | every `planning/` view (the timeline views, the plan view, `BaselineViewService`) and `ScheduleProposalService`, `CrossTeamProposalService` (the revision first; the roadmap reads `readRankingRevision`, also inside its write); `jira/` (`DeviationViewService`, `JiraImportService`: `readPlanRevision`) | `jira/JiraImportService.apply` (its one `withPlanWrite`: the lock and one bump); every `planning/` plan write takes the lock and bumps | `planning/` plan |
| `work_streams` (V12) | `planning/WorkStreamService` | the other `planning/` services (chains, `PlanViewService`, `RoadmapService`, the views); `jira/` (`JiraBindingNodes.kt`, `DeviationViewRows.kt`, `JiraImportService` through `workStreamChain`); `people/` (`ownsActivePlanNode`) | none | `planning/` plan |
| `programs` (V12) | `planning/ProgramService` | `WorkStreamService.delete` (counts ACTIVE children), the other `planning/` services; `jira/` (`JiraBindingNodes.kt`, `DeviationViewRows.kt`, `JiraImportService`); `people/` (`ownsActivePlanNode`) | `jira/` (the import's apply, through `insertProgramRow`) | `planning/` plan; the import in `jira/` |
| `projects` (V12) | `planning/ProjectService` | `ProgramService.delete` (counts ACTIVE children), the other `planning/` services; `jira/` (`JiraBindingNodes.kt`, `DeviationViewRows.kt`, `DeviationCoverageRows.kt`, `JiraImportService`); `people/` (`ownsActivePlanNode`) | `jira/` (the import's apply, through `insertProjectRow`) | `planning/` plan; the import in `jira/` |
| `milestones` (V14) | `planning/MilestoneService` | the other `planning/` services (chains, dependencies, order, schedule, proposal, views); `teams/` (`TeamService.delete`, through `hasActiveMilestones`); `jira/` (`JiraBindingNodes.kt`, `DeviationViewRows.kt`, `DeviationCoverageRows.kt`, `JiraImportService`) | `ProjectService.delete` (`deleteMilestonesOf`); `TeamScheduleService` (`writeSchedules`: the dates, and since V25 `pinned` through the clear rule); `jira/` (the import's apply: `insertMilestoneRow`, `writeSchedules`, which only ever writes dates on a milestone it just inserted, so it never clears a pin) | `planning/` plan; the import in `jira/` |
| `dependencies` (V15) | `planning/DependencyService` | the four timeline views; `ScheduleProposalService`, `CrossTeamProposalService`; `TeamScheduleService` (the `scopeHash` loader); `BaselineService` (create) | `MilestoneService.delete` and `ProjectService.delete` (`deleteDependenciesOf`) | `planning/` plan |
| `roadmap_entries` (V13) | `planning/RoadmapService` | the roadmap, programs and team views; `ScheduleProposalService`, `CrossTeamProposalService`; `BaselineService` (create) | `ProjectService.delete` (`removeFromRanking`) | `planning/` plan |
| `team_milestone_orders`, `team_order_state` (V17) | `planning/TeamOrderService` | `TeamViewService`; `ScheduleProposalService`, `CrossTeamProposalService`; `TeamScheduleService` (the `scopeHash` loader) | `MilestoneService.update` (a team change), `MilestoneService.delete`, `ProjectService.delete` (`removeFromTeamOrder`, `removeFromTeamOrders`: `team_milestone_orders` only; `team_order_state` is never touched by a removal) | `planning/` plan |
| `public_holidays` (V19) | `planning/PublicHolidayService` | `planning/` (the four views, `ScheduleProposalService`, `CrossTeamProposalService`, `MilestoneService.schedule`, `TeamScheduleService`, `BaselineService`, `BaselineViewService`); `jira/` (`DeviationViewService`, `JiraImportService`); `flow/` (`CapacityImportService`, `CapacityDeviationService`), all through `loadWorkingCalendar()` | none | `planning/` views and baselines |
| `baselines`, `baseline_projects`, `baseline_milestones` (V20) | `planning/BaselineService` | the four timeline views when a request carries `?baseline=N` (`BaselineRows.kt`); `BaselineViewService` | none (the frozen rows are never updated or deleted: the V20 triggers refuse both) | `planning/` views and baselines |
| `jira_connections` (V21; `poll_interval_minutes` V22; `census_at` V23) | `jira/JiraConnectionService` (with `JiraMappingStore` and `JiraTestRecorder` over the same table; `JiraIssueStore` writes `census_at`) | `jira/` (`JiraBindingService`, `JiraImportService`, `DeviationViewService`, `DeviationViewRows.kt`, `DeviationCoverageRows.kt`, `JiraConnectionPolling.kt`); `sync/ConnectionRegistry.kt` (the table passed in, only the `ConnectionColumns`; `lockActiveConnection`, the claim's `FOR SHARE` on the ACTIVE row through `JiraConnectionService.lockActiveInTransaction`); `telemetry/` (`Connector.connections()`: the poll columns, never a token) | none; the boot backfill re-wraps `api_token` through the service's own `EncryptedAtRest` | `jira/` |
| `jira_bindings` (V21; acknowledgement columns V22) | `jira/JiraBindingService` | `jira/` (`JiraImportService`, `DeviationViewRows.kt`, `DeviationCoverageRows.kt`, `JiraRunStore`); `planning/` views through the `ExternalFlagSource` seam, implemented by `jira/JiraFlagSource` | `jira/JiraConnectionService.delete` (soft-deletes the connection's ACTIVE bindings); `JiraRunStore` (a moved issue's key, `marked_as_deleted`); `JiraAcknowledgeService` (the three `ack_*` columns); `JiraImportApply` (through `insertBoundLocked`) | `jira/`: the bind's lock order |
| `jira_observations` (V21) | `jira/` (`JiraObservations.kt`; the first row is written by `JiraBindingService`) | `jira/` (`DeviationViewRows.kt`); `planning/` views through the `ExternalFlagSource` seam | `jira/JiraRunStore` (`upsertRows`, `markGone`, `clearGone`, `recordProbe`); the import's bind (`JiraBindingService.insertBoundLocked`) | `jira/` |
| `jira_issues` (V23) | `jira/JiraIssueStore` | `jira/DeviationCoverageRows.kt`; the run's census (the store's `index` and `censusAt`) | `jira/JiraConnectionService.delete` (hard-deletes the mirror); the run's census (`JiraCensus.kt`, through the store's `upsert` and `delete`) | `jira/` |
| `sync_runs` (V21) | `sync/SyncRunService` | `jira/` and `flow/` (the derived `status`: `recentRunsInTransaction`, `statusesInTransaction`); `sync/` (the scheduler's `recentRuns`); `telemetry/` (`TelemetrySync`) | `jira/JiraConnectionService.delete` and `flow/FlowConnectionService.delete` (hard-delete the connection's rows through `deleteForConnectionInTransaction`) | `sync/`: the claim takes the CONNECTION row `FOR SHARE` (through `Connector.lockActiveInTransaction`, the connector's own service) BEFORE it touches `sync_runs`, against the delete's `FOR NO KEY UPDATE` on the same row followed by its run purge, so a claim racing a delete lands first (the delete removes its row) or is refused `400` after it (`SyncClaimDeleteRaceTest`, and `SyncClaimDeletedConnectionTest` through the real observers); no run is ever left for a deleted connection, and `sync_runs` needs no FK or sweep |
| `flow_connections` (V24) | `flow/FlowConnectionService` (`FlowMirrorStore` writes `teams_at`) | `flow/` (`FlowTeamBindingService`, `FlowTeamService`, `CapacityImportService`, `CapacityDeviationService`, `FlowConnectionPolling.kt`); `sync/ConnectionRegistry.kt` (only the `ConnectionColumns`; `lockActiveConnection`, the claim's `FOR SHARE` on the ACTIVE row through `FlowConnectionService.lockActiveInTransaction`); `telemetry/` (`Connector.connections()`) | none; the boot backfill re-wraps `api_token` through the service's own `EncryptedAtRest` | `flow/` |
| `flow_teams`, `flow_sprints`, `flow_members` (V24) | `flow/FlowMirrorStore` | `flow/` (`FlowTeamBindingService`, `FlowTeamService`, `CapacityImportService`, `CapacityDeviationService`, through `teamSprintsOf`); `planning/` views only through the `ExternalFlagSource` seam (`flow/FlowFlagSource`; the team view asks) | `flow/FlowConnectionService.delete` (hard-deletes the mirror through `deleteForConnectionInTransaction`) | `flow/` |
| `flow_team_bindings` (V24) | `flow/FlowTeamBindingService` | `flow/` (`FlowTeamService`, `CapacityImportService`, `CapacityDeviationService`, `CapacityAcknowledgeService` (`bindingOf`; it also locks the row)); `planning/` views only through the `ExternalFlagSource` seam (`flow/FlowFlagSource`; the team view asks) | `flow/FlowConnectionService.delete` (soft-deletes the connection's ACTIVE bindings) | `flow/`: the link's lock order; **binding-first for the unbind and the acknowledge** (the binding row `FOR NO KEY UPDATE`, then the guard's team and person rows `FOR SHARE`) |
| `flow_capacity_acknowledgements` (V26) | `flow/CapacityAcknowledgeService` | `flow/` (`CapacityDeviationService`: ONE statement per view, `Acknowledgements.storedOf`, inside the view's snapshot); `planning/` views only through the `ExternalFlagSource` seam (`flow/FlowFlagSource`, the team view's Flow flag: the same read inside the view's snapshot) | the service's `acknowledge` (the stamp, and since 1.10 the prune of its binding's unlisted rows) / `acknowledgeAll` (1.10: the batch - deletes the named keys, then ONE multi-row insert, plus the same prune) / `unacknowledge` and (1.11) `unacknowledgeAll` (hard rows: the named keys deleted in one statement, no prune), its `pruneConnectionInTransaction` (1.10: the run's prune, inside `FlowMirrorStore.replace`'s transaction, which no longer writes the table) and `Acknowledgements.deleteForConnectionInTransaction` (the connection delete); an unlink or a team delete leaves the rows until the connection's next run prunes them; FK `ack_by_user_id → users`, `binding_id → flow_team_bindings` | `flow/`: the binding row `FOR NO KEY UPDATE` first (the acknowledge, `acknowledgeAll`, withdrawal), then the guard's team and person rows; the run's prune and the connection delete: the connection row, then the binding rows (id order; the delete's soft delete), then these rows |
| `ops.telemetry_processes`, `ops.telemetry_samples` (V9) | `telemetry/TelemetryStore` | `telemetry/` (the ADMIN read API); `StorageCollectors.kt` reads the catalogs only, never a payload | none | `telemetry/` |

#### `users/` + `auth/`

- `auth/TokenBlocklistService.accessVerdict` (the per-request access-token check, `plugins/Security.kt`) READS `users/UserService.Users` (`role`,
  `credential_revision`, `marked_as_deleted`, by primary key) and its own `revoked_tokens` (an `EXISTS` on the `jti`) in ONE uncached statement per
  authenticated request; it writes nothing.
- `auth/PasswordResetService` (V8) READS `users/UserService.Users` (the `active()` / `credential_revision` / `email` predicate of a grant's liveness, and
  `FOR NO KEY UPDATE` on the user row) and WRITES `users.password_hash` / `password_changed_at` / `credential_revision` through `users`' `updatePasswordInTransaction`
  inside its own transaction (the grant is consumed in the same transaction).
- `plugins/Health.kt` (`GET /api/v1/ready`, the readiness probe) READS `users/UserService.Users` (`id`, `LIMIT 1`), a bounded round trip that proves the
  database answers; it writes nothing and returns no row.

#### `people/`

- `PersonService` reads `UserService.Users` (the linked login: the active-user check on create AND update, the login's email on read/list through ACTIVE users)
  and `TeamService.Teams` (the delete 409 while the person manages an ACTIVE team; since V12 `planning/OwnerChains.kt`'s `ownsActivePlanNode` extends it to an
  ACTIVE work stream, program or project the person owns). `people.user_id` has no `ON DELETE` rule: users are only ever soft-deleted and the link stays INERT
  while the user is deleted (guards resolve the caller's person through `people.user_id = caller AND people.active()`, and a deleted login never passes the
  access verdict); a future hard purge of users must clear it first, and a future user RESTORE must re-audit the link (the person may have been re-linked to
  another login meanwhile — the partial unique index refuses a clash). A PUT from the SPA carries `userId: null` for an inert link (the response reads it as
  unlinked), so a rename from the UI clears a link to a soft-deleted login.

#### `teams/`

- `TeamService` reads `PersonService.People` for the manager (V10): the active manager's name (one batched lookup per page), the manager id check on create AND
  update (it locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE`: a delete racing an assignment either commits
  first and the assignment is a 400, or waits and then sees the team and answers 409), and `isActiveManager`'s `Teams` ⋈ `People` ⋈ `Users` join (the
  team-manager guard: an ACTIVE team, an ACTIVE person whose `user_id` is the caller, and that user ACTIVE). `teams.manager_person_id` has no `ON DELETE` rule:
  people are only ever soft-deleted, and `PersonService.delete` refuses (409) while an ACTIVE team names the person.
- `TeamService.activeManagedTeamIds(userId)` (the actor's managed teams for the `can.schedule` flags) READS `PersonService.People` and `UserService.Users` —
  `isActiveManager`'s join without the team id; a plain read, no lock.
- `teams/` (V16): `TeamCapacityService` owns `team_capacity_periods` and reads/locks `TeamService.Teams`: every write takes `Teams.lockActiveForWrite(teamId)`
  (`FOR NO KEY UPDATE`) FIRST, then `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`, the guard's second run), then writes — no plan lock; the
  reads join `Teams` for the `active()` predicate. `TeamService.delete` WRITES `team_capacity_periods` through `deleteCapacityPeriodsOf` (same package, listed
  anyway: the team's ACTIVE periods are soft-deleted inside its locked transaction, after the milestone 409; the count goes to `team.deleted`).
  `team_capacity_periods.team_id → teams(id)` has no `ON DELETE` rule: teams are only soft-deleted (V24 adds the import's second writer, `applyImport`, below).
  `ck_team_capacity_periods_wip` (`wip_limit` NULL or 1..99) and `ck_team_capacity_periods_md` (`>= 0`) back the validator up (the V16 index also serves the
  per-team reads, so no separate `team_id` index); `TeamCapacityLifecycleTest` pins both and the partial index at the database.
- `teams/TeamCapacityService` (V24) owns the new `team_capacity_periods` columns: `source` (`MANUAL`|`FLOW`, `ck_team_capacity_periods_source`; Kotlin
  `CapacityPeriods.capacitySource`, because Exposed's `Table.source` is taken), `flow_sprint_id`, `flow_sprint_name`. `create` writes `MANUAL`; `update` (the
  PUT) always leaves the period `MANUAL` with the sprint columns cleared, and a PUT on a `FLOW` period counts as a change even with equal figures
  (`CapacityUpdateOutcome.sourceBefore`). `planning/TeamViewRows.kt` READS the two response columns for the team view's periods.
- `teams/TeamCapacityService.applyImport` (V24; the capacity import's apply, `POST /integrations/flow/team-bindings/{id}/capacity-import`) is the ONLY writer of
  `source = 'FLOW'` rows and the only way `flow/` writes `team_capacity_periods` (the matrix IS the permission: `teams/` names no `flow/` type - it takes the guard
  and a `decide` lambda that `flow/` fills with its kernel's answer). ONE transaction: `Teams.lockActiveForWrite` (`FOR NO KEY UPDATE`, gone = 404) FIRST, then
  the guard's second run (`TeamService.lockedIsActiveManager`, `FOR SHARE OF teams, people`: a manager cleared while the request waited is a 403 and nothing is
  written), then the team's ACTIVE periods read under the lock, then `decide` (which re-reads the binding, unlocked, and re-runs the kernel over the mirror read
  NOW), then the writes: removals (one `UPDATE … WHERE id IN`, soft delete), the updates (`md_per_week`, `flow_sprint_id`, `flow_sprint_name`, `updated_at`; the
  WIP limit and the date are kept) and the creates (`insertRows`, `source = 'FLOW'`, no WIP limit; the new ids are read back by their `(team, date)` key).
  Deletes go before inserts (a freed date can be taken again under `uq_team_capacity_periods_team_from_active`). **A MANUAL period is never written, by
  construction twice over**: `requireOnlyFlowPeriodsChanged` checks every update and delete against the rows read under the lock (FLOW, this team, each period
  once; every new date free among the periods that remain) and aborts the transaction with an `IllegalStateException` (a bug, a 500, nothing written), and every
  `UPDATE`'s own `WHERE` adds `source = 'FLOW'` and checks the row count. No plan lock and no revision: capacity is team data. Locks held: the team row
  `FOR NO KEY UPDATE`, then the manager/person rows `FOR SHARE`; the binding, connection and mirror reads take none (plain MVCC reads). The mirror's own writer,
  `FlowMirrorStore.replace`, takes the CONNECTION row `FOR NO KEY UPDATE` and writes the mirror tables, and a bind takes the connection row `FOR SHARE` then the
  team row `FOR SHARE`: the apply takes no connection-row lock and writes no mirror or binding row, and `replace` takes no team row, so no wait chain through
  the apply closes into a cycle (an apply waits only on the team row and the manager/person rows, whose holders - a team write, a manager change - wait on
  nothing the apply holds). The mirror is read in ONE statement (`FlowMirrorStore.teamSprintsOf`: the Flow team LEFT JOINed to its sprints), so "absent from the
  mirror" and "its sprints" are decided by the same snapshot of a refresh.

#### `planning/` plan

- `planning/` (V12): the node services read `PersonService.People` — `OwnerChains.kt`'s `ownerNames` (the owners' display names, one batched lookup per read, no
  `active()` filter: an active node's owner is always an active person) and `requireActiveOwner` (the owner of a node being written must be ACTIVE, else 400; it
  locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE`: a delete racing a node write either commits first and the
  write is a 400, or waits and then sees the node and answers 409 — never an active node owned by a deleted person; `PlanStateTest` pins both halves). The
  services also read each other's tables inside one feature: a delete counts the ACTIVE children (`Programs` from the work stream delete, `Projects` from the
  program delete) and the chain lookups join all three. `work_streams`/`programs`/`projects` hold `owner_person_id → people(id)` with no `ON DELETE` rule:
  people are only ever soft-deleted and `PersonService.delete` refuses (409) while an ACTIVE node names the person. `PlanViewService` reads the three tables
  (and `people` names) in one `SNAPSHOT` read-only transaction (below), the revision first; `PlanViewSnapshotTest` pins that a write committing between its
  selects cannot tear the tree.
- `planning/` (V13): `RoadmapService` reads `ProjectService.Projects`, `ProgramService.Programs`, `WorkStreamService.WorkStreams` (the view's names, the
  active-id check of a ranking write) and `PersonService.People` (owner names, via `OwnerChains.kt`); it owns `roadmap_entries`, and `ProjectService.delete`
  WRITES it through `removeFromRanking` (same package, same locked transaction — no other feature touches the table).
- `planning/` (V14): `MilestoneService` reads and joins `ProjectService.Projects`/`ProgramService.Programs`/`WorkStreamService.WorkStreams` (`milestoneChain`,
  beside the other chains in `OwnerChains.kt`) and reads/locks `TeamService.Teams`: `requireActiveTeam` (the team of a milestone being created or changed must
  be ACTIVE, else 400; it locks the team row `FOR SHARE`, which conflicts with `TeamService.delete`'s `lockActiveForWrite` — `FOR NO KEY UPDATE`: a delete
  racing a milestone write either commits first and the write is a 400, or waits and then counts the milestone and answers 409 — never an active milestone on a
  deleted team; `TeamTest` pins both halves) and `teamName` (no `active()` filter: an active milestone's team is always active). `TeamService.delete` READS
  `Milestones` through `hasActiveMilestones` (the 409 "Team still has milestones", ACTIVE rows only, counted under the team row lock) and
  `ProjectService.delete` WRITES `Milestones` through `deleteMilestonesOf` (the cascade: the project's ACTIVE milestones are soft-deleted in the same
  plan-locked transaction, the count goes to the `project.deleted` audit). `TeamService.lockedIsActiveManager` (the schedule PUT's re-guard under the plan lock)
  is `isActiveManager`'s join with `FOR SHARE OF teams, people` — Exposed's `ForUpdateOption.PostgreSQL.ForShare(null, Teams, People)`, NOT the parameterless
  `ForShare` companion (which locks every joined row, the USER row included, and would queue a drag behind a password reset): a manager change
  (`TeamService.update`, `FOR NO KEY UPDATE`) or a re-link/delete of the manager's person either commits first (403 under the lock, no bump) or waits.
  `FOR SHARE` is refused with an aggregate, so the twin reads rows, never `count()`. `milestones.project_id → projects(id)` and `team_id → teams(id)` have no
  `ON DELETE` rule: projects and teams are only soft-deleted. The three plan-node inserts (program, project, milestone) and `requireActiveTeam` live in
  `planning/PlanNodeInserts.kt`, run inside the caller's `withPlanWrite` transaction and are shared by the three services' `create` and (1.2) the Jira import.
- `planning/` (V15): `DependencyService` reads `MilestoneService.Milestones`, `ProjectService.Projects`, `ProgramService.Programs`,
  `WorkStreamService.WorkStreams` and `TeamService.Teams` — `dependencyChain` (the SUCCESSOR's project chain, beside the other chains in `OwnerChains.kt`),
  `isActiveEndpoint` (the chain lookups), `resolveEndpoints` (a milestone's name, project and team, a project's name and the DERIVED span over its scheduled
  ACTIVE milestones; names read WITHOUT an `active()` filter: an active milestone's project and team are always active) and `loadTimePointGraph` (every active
  milestone's `(id, project_id)` and every active dependency, the cycle check's input) — all under the plan lock on a write. `MilestoneService.delete` and
  `ProjectService.delete` WRITE `Dependencies` through `deleteDependenciesOf` (the cascade: the ACTIVE links with either end at the milestone, or at the project
  and its milestones, are soft-deleted in the same plan-locked transaction; the counts go to the `milestone.deleted` / `project.deleted` audits;
  `activeMilestoneIdsOf` supplies the project's milestone ids before they are deleted). `dependencies` holds four nullable FKs to `milestones(id)` /
  `projects(id)` with no `ON DELETE` rule: both are only soft-deleted.
- `planning/` (V17): `TeamOrderService` owns `team_milestone_orders` and `team_order_state` and reads `MilestoneService.Milestones` (the ids of a write must be
  ACTIVE milestones OF the team, `requireMilestonesOfTeam`) and locks `TeamService.Teams` (`lockActiveTeam`: the active team row `FOR SHARE` for every caller,
  ADMIN included, conflicting with `TeamService.delete`'s `FOR NO KEY UPDATE`); the caller's route guard reaches `TeamService.lockedIsActiveManager`
  (`FOR SHARE OF teams, people`) inside the plan lock — plan lock first, then the team row, the order the schedule PUT already uses (capacity writes take the
  team row alone, so no cycle). `MilestoneService.update` (a team change) and `delete` and `ProjectService.delete` WRITE `team_milestone_orders` through
  `removeFromTeamOrder`/`removeFromTeamOrders` (same package, same plan-locked transaction; listed anyway: the row is hard-deleted and the positions above
  renumbered; the team's `team_order_state` is NOT touched by a removal). Nothing else writes either table: the roadmap's `replaceRanking` and
  `removeFromRanking` touch `roadmap_entries` only, which is what keeps a manager's override out of reach of a rank change.
  `team_milestone_orders.milestone_id → milestones(id)` and `team_id → teams(id)` and `team_order_state.team_id → teams(id)` have no `ON DELETE` rule:
  milestones and teams are only soft-deleted (a team delete is refused while an ACTIVE milestone names it, and a removal hook has already emptied the
  soft-deleted milestones' rows). The unique constraint's index also serves the per-team reads, so there is no separate `team_id` index.
- `planning/` (no migration): `TeamScheduleService` (`POST /teams/{id}/milestone-schedules`, the batch accept, and since 1.8 `acceptRun`, `POST /schedule-proposals/accept`) WRITES `MilestoneService.Milestones`
  (`start_date`, `end_date`, `schedule_revision`, `updated_at` and, since V25, `pinned` - an item with the null pair clears the pin in the same statement: the second
  writer of those columns beside `MilestoneService.schedule`, listed so; the Jira import's apply is the third) under `withPlanWrite`, with the team row locked `FOR SHARE` (`lockActiveTeam`, shared with `TeamOrderService`) and the manager
  guard re-run (`TeamService.lockedIsActiveManager`: `FOR SHARE OF teams, people`) inside the plan lock — plan lock first, then the team row, the order the
  schedule PUT and the order PUT already use. It READS `MilestoneService.Milestones` (the ids of the batch: their stored team, span and `schedule_revision`,
  ACTIVE rows only, ONE query) and `PublicHolidayService.PublicHolidays` (`loadWorkingCalendar`, under the lock like the single PUT). With a request `scopeHash`
  it also READS, under the lock, every table the auto-proposal reads (`loadScheduleSnapshot`: the team's milestones with their project and rank,
  `team_milestone_orders`, `CapacityPeriods`, every active milestone and link - the proposal's own loader, so the two fingerprints are one function over one row
  shape) plus one `LIMIT 1` sweep of the team's milestones with `schedule_revision` above `expectedRevision` that the batch does not name. "Active" is
  `milestoneChain`'s (the milestone and its project, program and work stream). The accepted items are written by multi-row `UPDATE … FROM (VALUES …)` statements
  (`MilestoneScheduleWrite.kt`: typed `::int`/`::date` columns so null pairs bind, chunked like `MultiRowInsert.kt` so the SQL texts stay few) instead of a
  round trip per item under the plan lock; a skipped item writes nothing; no `team_milestone_orders` / `team_order_state` row is touched.
- `planning/` (no migration): the picker lists. `ProjectService.list` reads `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈
  `WorkStreamService.WorkStreams` (their `name`s for `programName`/`workStreamName`, all three `active()`) and `PersonService.People` via `ownerNames`;
  `MilestoneService.list` reads `MilestoneService.Milestones` ⋈ `Projects` ⋈ `Programs` ⋈ `WorkStreams` (all four `active()`; the project's `name`) and
  `TeamService.Teams` (`teamName`, no `active()` filter: an active milestone's team is always active). One read transaction per list, count + rows on one
  predicate, no lock, no revision.
- `planning/PublicHolidayService` (V19) WRITES only its own table, `public_holidays` (hard-delete), and only inside `withPlanWrite` (so it takes the
  `plan_state` lock and bumps `plan_state.revision` like every plan write); it reads no other feature's table.

#### `planning/` views and baselines

- **The timeline views read …** the plan's tables under one shared protocol: each view is ONE READ ONLY REPEATABLE READ snapshot
  (`suspendTransaction(database, IsolationLevel.REPEATABLE_READ, readOnly = true)`, `io.r2dbc.spi.IsolationLevel`; the `SNAPSHOT` constant) that reads the
  revision FIRST (`readPlanRevision()`; the roadmap: the ranking revision), takes no lock and writes nothing, so the revision, the milestones, the links, the external ends, the chains and the
  calendar are one snapshot (`PlanViewService` included); the lists in this layer stay at the default READ COMMITTED. The project view:
  `ProjectViewService` (`GET /views/project/{id}`) reads the project through `projectChainRow` (`OwnerChains.kt`: the ONE project-chain join + active predicate,
  which `projectChain` also uses; it joins `PersonService.People` for the owner name) and also reads `ProjectService.Projects`, `ProgramService.Programs`,
  `WorkStreamService.WorkStreams`, `MilestoneService.Milestones` and `TeamService.Teams` (the milestones ⋈ teams join for `teamName`, no `active()` filter on
  the team: an active milestone's team is always active) and `PersonService.People` (owner names, via `ownerNames`). Its links: `ProjectViewService` also READS
  `DependencyService.Dependencies` (the project's links, via `linksTouching`, shared with the delete cascade) and, through `resolveEndpoints`, OTHER projects'
  `MilestoneService.Milestones`, `ProjectService.Projects` and `TeamService.Teams` (names, teams and dates of the external ends, no `active()` filter: an active
  link's ends are active) plus, through `projectChains(ids)` (`OwnerChains.kt`, one batched join, the `projectChainRow` predicates without the owner name), the
  chains of the projects holding the successors of its external links (`can.delete`). The team view: `TeamViewService` (`GET /views/team/{id}`) READS
  `TeamService.Teams` (the team and its manager, via `PersonService.People` with the `active()` predicate), `MilestoneService.Milestones` ⋈
  `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` (the team's ACTIVE milestones and their names, no `active()` filter on
  the ancestors: an active milestone's chain is active) left-joined `RoadmapService.RoadmapEntries` (`rankPosition`), `TeamOrderService.TeamMilestoneOrders` /
  `TeamOrderState` (through `positionsOf` and `orderRevisionOf`, positions looked up FROM the team's active milestones, never by iterating the order table),
  `TeamCapacityService.CapacityPeriods` (the team's ACTIVE periods by `effectiveFrom`) and, through `viewDependencies` (the project view's generalised link
  read), `DependencyService.Dependencies` plus the ends' `Milestones`/`Projects`/`Teams` and the successors' `projectChains`. The roadmap view:
  `RoadmapViewService` (`GET /views/roadmap`, the RANKING revision first; its row loaders `RoadmapViewRows.kt` are shared with the programs view) READS
  `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` (the three owner ids of the chain, all three `active()`) and
  `PersonService.People` via `ownerNames`, `RoadmapService.RoadmapEntries`, `MilestoneService.Milestones` ⋈ `TeamService.Teams` (every ACTIVE milestone and its
  team's name, no `active()` filter on the team or the project: an active milestone's are active) and `DependencyService.Dependencies` (every ACTIVE link,
  resolved to projects in memory by the pure `RoadmapKernels`; with `?criticalPath=` (1.7) the SAME rows feed `CriticalPathKernels`, no further statement). The programs view: `ProgramsViewService` (`GET /views/programs`, the PLAN revision first) READS
  everything the roadmap view reads through the shared `loadRoadmapSnapshot` (above, EXCEPT the revision it takes: the plan's, not the ranking's) and, apart
  from the projects' joins so empty ones are not lost, `WorkStreamService.WorkStreams` and `ProgramService.Programs` (every row with `active()`) with
  `PersonService.People` via `ownerNames` for their owners' names. The working calendar (V19): `ProjectViewService`, `TeamViewService`,
  `RoadmapViewRows.loadRoadmapSnapshot` (the roadmap AND programs views) and `MilestoneService.schedule` READ `PublicHolidayService.PublicHolidays` — the whole
  dictionary, one unfiltered `SELECT` of `holiday_date, name` — through `loadWorkingCalendar()` (`PublicHolidayService.kt`), a plain suspend function that runs
  INSIDE the caller's own transaction: right after `readPlanRevision()` in the views' REPEATABLE READ snapshot (so the revision, the rows and the calendar are
  one snapshot), and under the plan lock in the schedule write. A read, no lock; never from a route, never cached across requests (the calendar is a per-request
  parameter of the pure kernels). The critical path: `ProjectViewService` and (1.7) `TeamViewService` (`loadCriticalPaths`, one load for every project of the team) READ EVERY active milestone (`MilestoneService.Milestones` joined to
  `TeamService.Teams`, with its name), every active link (`DependencyService.Dependencies`) and every active project's id and name (`ProjectService.Projects`)
  through the roadmap's shared loaders (`RoadmapViewRows.kt` `milestoneFacts`/`linkFacts`, now `internal`, plus `activeProjectNames`) in the view's REPEATABLE
  READ snapshot, for the whole-chain critical path (`loadCriticalPath`, `CriticalPathView.kt`). A read, no lock; about 1,000 narrow milestone rows, 300 links
  and 100 project names on the sample plan. With `?baseline=N` (V20): `ProjectViewService`, `TeamViewService`, `RoadmapViewService` and `ProgramsViewService`
  READ `BaselineService.Baselines` (the ACTIVE header), `BaselineProjects` and `BaselineMilestones` (the frozen rows: `idx_baseline_milestones_project` /
  `_team` and the primary key) when a request carries `?baseline=N`, one indexed select each inside the view's own `REPEATABLE READ` snapshot (`activeBaseline`,
  `frozenProject(s)`, `frozenMilestonesOf…`, `frozenMilestonesById`), plus `TeamService.Teams` for the names of the teams of removed rows (`teamNames`) and
  `MilestoneService.Milestones` ⋈ `Teams` for the team a removed row of the team view moved to (`liveTeamsOfMilestones`). `BaselineViewService`
  (`GET /views/baseline/{id}`) READS the three baseline tables, `UserService.Users`/`PersonService.People` for `createdBy`, the roadmap view's tables except
  `Dependencies` (`loadRoadmapSnapshot(withLinks = false)`: `Projects` ⋈ `Programs` ⋈ `WorkStreams`, `RoadmapEntries`, `Milestones` ⋈ `Teams`,
  `PublicHolidays`), `MilestoneService.Milestones` again for the estimates (`baselineMilestoneFacts`) and `Teams`; with `?against=N` (1.7) it reads the second baseline's
  header and frozen rows (`frozenProjects`/`frozenMilestones`) and the calendar INSTEAD of that live snapshot. All are reads in a read-only transaction: no
  lock, no write, nothing cached; a request without the parameter touches none of the baseline tables. External flags (1.3): `ProjectViewService`,
  `TeamViewService`, `RoadmapViewService` and `ProgramsViewService` (through `loadRoadmapSnapshot`; the baseline capture and comparison pass no source) READ
  `jira_bindings` ⋈ `jira_observations` ⋈ `jira_connections` (and, for the nodes, `DeviationViewService`'s own reads: the live bound nodes with their ancestors,
  the derived spans of bound projects, the parent issue's binding, `creatorsOf` for an acknowledgement's author) through the `ExternalFlagSource` seam declared
  in `planning/ExternalFlags.kt` and implemented by `jira/JiraFlagSource`, inside each view's own `READ ONLY REPEATABLE READ` snapshot, after the calendar.
  `planning` names no `jira` type (`PackageBoundaryTest`); `infra/db/Database.kt` wires the source into the four services (they are built after
  `DeviationViewService`). Reads only: no lock, no write, no revision. The scope (`DeviationScope`, with `levels` since 1.3) pushes the requested node ids and
  levels into the bindings statement, an EMPTY id list names nothing (never "everything") and an unrestricted whole-plan ask reads project and milestone
  bindings only (never programs). Measured cost: `timeline.md` "Measured figures (1.3)".
- `planning/` (no migration): `ScheduleProposalService` (`POST /teams/{id}/schedule-proposal`, a computation: ONE READ ONLY REPEATABLE READ snapshot, the plan
  revision first, no lock, writes nothing, nothing stored) READS `TeamService.Teams` (the team's name and `active()`), `MilestoneService.Milestones` ⋈
  `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` left-joined `RoadmapService.RoadmapEntries` (the team's rows through
  `teamMilestoneRows`, with the order key and the estimate), `TeamOrderService.TeamMilestoneOrders` (`positionsOf`), `TeamCapacityService.CapacityPeriods`
  (`teamCapacityRows`), every ACTIVE milestone (`milestoneFacts`: the other teams' dates are the fixed constraints) and `DependencyService.Dependencies`
  (`linkFacts`), `PublicHolidayService.PublicHolidays` (`loadWorkingCalendar`, right after the revision) and, through `resolveEndpoints`, the touched links'
  ends (`Milestones`/`Projects`/`Teams`).
- `planning/` (no migration): `CrossTeamProposalService` (`POST /schedule-proposals`, the 1.8 cross-team run, and `GET /schedule-proposals/teams`) is the same kind of reader as `ScheduleProposalService` for N teams: ONE READ ONLY REPEATABLE READ snapshot (`SNAPSHOT`), the plan revision FIRST, no lock, nothing written, nothing stored. `loadCrossTeamSnapshot` reads the calendar (`PublicHolidays`), then per run team `teamMilestoneRows` (`Milestones` ⋈ `Projects` ⋈ `Programs` ⋈ `WorkStreams` left-joined `RoadmapEntries`), `positionsOf` (`TeamMilestoneOrders`) and `teamCapacityRows` (`CapacityPeriods`), and the plan-wide `milestoneFacts` and `linkFacts` ONCE (not once per team); the run teams' names come from `Teams` (`active()`) inside the same snapshot, and the link ends are named through `resolveEndpoints`. The route's 404 half is `TeamService.activeNamesAmong` (one `Teams` query) and its 403 half `TeamService.activeManagedTeamIds` (one `Teams` ⋈ `People` ⋈ `Users` query), each in its own short transaction BEFORE the snapshot: a team deleted or a manager changed in that gap is covered by the snapshot's own 404 and by the fact that nothing is written. `GET /schedule-proposals/teams` reads the active `Teams` rows only. `CrossTeamProposalService.check` (`POST /schedule-proposals/check`) is the same reader over the same snapshot and the same `loadCrossTeamSnapshot` rows (no revision statement: it answers none, so the snapshot is established by `activeTeamNames`, its first statement), writes nothing and overlays the request's spans in memory. The accept is `TeamScheduleService.acceptRun` (a plan write, `withPlanWrite`, ONE bump): under the lock it takes `lockActiveTeam` and the locked manager guard for EVERY run team in ascending id order, reads the teams' CURRENT names (`activeTeamNames`, after the rows are locked `FOR SHARE`, so a rename - `FOR NO KEY UPDATE` - has committed first or waits), rebuilds the SAME `loadCrossTeamSnapshot` and compares `CrossTeamSnapshot.scopeHash` with the request's, adds one `LIMIT 1` sweep of the milestones of ANY run team that the accept does not name with `schedule_revision` above `expectedRevision` (fixed ones included), and writes the items through `writeSchedules` (`Milestones`, the matrix cell unchanged: team-scoped writers only).
- `planning/BaselineService` (V20) WRITES only its own tables - `baselines` (the header: create, rename, the soft-delete flag), `baseline_projects` and
  `baseline_milestones` (FROZEN: one multi-row `insertRows` each at create, never updated or deleted; the V20 triggers refuse both) - and only inside
  `withPlanWrite`, so a baseline is the plan at ONE revision and every baseline write bumps the revision; the caller's guard (`requireRoadmapEditorOrAdmin`, the
  grant re-read through `UserService.hasPermission` in the same transaction) re-runs inside the lock. `create` READS, under the lock, everything the roadmap
  view reads through `loadRoadmapSnapshot` (`ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams`,
  `RoadmapService.RoadmapEntries`, `MilestoneService.Milestones` ⋈ `TeamService.Teams`, `DependencyService.Dependencies` and
  `PublicHolidayService.PublicHolidays` for the rolled-up links it does not keep) plus `baselineMilestoneFacts` (the active `MilestoneService.Milestones` with
  name and estimate); the response reads `UserService.Users` (ACTIVE logins) and `PersonService.People` (ACTIVE persons linked to them) for `createdBy`. The
  frozen rows hold NO foreign key to any live row (`baselines.created_by_user_id → users(id)` is the only FK out of the three tables). The read loaders
  (`BaselineRows.kt`) are what the views read inside their snapshot after `readPlanRevision()`.

#### `jira/`

- `jira/JiraConnectionService` (V21) reads and writes its own table, `jira_connections` (the registry: soft-delete, no plan lock, no revision - connections are
  not plan state; `delete` also WRITES `jira_bindings` - see the bindings line below - and, in the same transaction, hard-deletes the connection's `sync_runs`
  (`SyncRunService.deleteForConnectionInTransaction`) and (V23) hard-deletes the connection's `jira_issues` (`JiraIssueStore.deleteForConnectionInTransaction`;
  the count rides `JiraConnectionDeleteOutcome.censusDeleted` to a log INFO after the commit, no audit field) and sets `api_token` NULL (V21: `api_token` is an
  `enc:v1:` envelope, or NULL on a deleted row only, `ck_jira_connections_api_token` and `_live`; `sync_runs.requested_by_user_id` references `users` like
  `jira_bindings.created_by_user_id`), so it is no longer "its own table only"; a stored Test connection (written by `jira/JiraTestRecorder`, a collaborator
  over the same table that never selects `api_token`) records `cloud_id`, `last_tested_at/ok` (the real verdict) and - whenever the `field` and `issuetype`
  probes both answered, a failed other probe notwithstanding - the `discovery` snapshot (up to ~300 KB, so the registry's reads select every column but
  `discovery`) under a row `FOR NO KEY UPDATE`, skipped when the row was edited since it was read, and a change of token, account email, auth scheme or project
  keys clears `last_tested_at/ok`); it reads no other feature's table (but `sync_runs`, through `SyncRunService.recentRunsInTransaction`, for each response's
  derived `status` since 1.3, in the same transaction) and no other feature reads it but as the matrix row lists. Since V22 it also owns `poll_interval_minutes` (nullable, CHECK 5..1440, `null`
  = manual only; `create` and `update` write it, and a PUT is a full replace, so a PUT without the member resets it to the default 15). It also owns the
  `mapping` document, read and written by `jira/JiraMappingStore` (a collaborator over the same table that selects only `mapping` and `discovery`, never
  `api_token`): `readMapping` (the stored document and the snapshot, no token), `writeMapping` (`FOR NO KEY UPDATE` on the row, so it serializes with a Test
  connection replacing the snapshot; validates against the snapshot it just read, a missing one being a 409; writes the canonical text and NOT `updated_at` (a
  mapping is not an input of a Test connection, so a PUT landing between `readForTest` and `recordTest` must not make the latter drop its result), but stamps
  `mapping_changed_at` when - and only when - the canonical document differs from the stored one (the Jira run's signal to read in full; an identical PUT stamps
  nothing); rewrites NOTHING else, so bindings and observations are untouched); the service's own `readForPeek` (the target with the token decrypted in memory
  plus the mapping state, ONE short transaction before the Jira call, none across it). It owns the first ENCRYPTED column, `api_token`: written as a
  `FieldCipher` envelope, decrypted by exactly three readers — `readForTest`, for the Test connection's connector, `readForPeek`, for Peek, and `readForBind`,
  for the bind - the only one a non-ADMIN can trigger (a decrypt failure reads as a null token, never an exception out of the service); the Jira sync run is a
  second CALLER of `readForBind` (the bind and the run call it; Test and Peek have their own readers), not a fourth decrypt site (an `AEADBadTagException` reads
  as a null token, which the run reports as the typed `TOKEN_UNREADABLE`) — and never on a read path (the response carries `hasApiToken`), and registered with
  the boot backfill (`EncryptedAtRest`, `infra/db/Bootstrap.kt`, "Encryption at rest" in `security.md`). It also owns `readForBind` (the third of the three
  decrypting readers, with `readForTest` and `readForPeek`: the target, the mapping state and `enabled`, one short transaction before the bind's Jira call) and
  `delete` soft-deletes the connection's ACTIVE bindings in the same transaction (D2: `uq_jira_bindings_node_active` has no connection column, so a binding left
  active on a deleted connection would block its node for good; the count goes to the `jira.connection_deleted` audit as `bindingsUnbound`).
- `jira/JiraIssueStore` (V23, 1.4) OWNS `jira_issues` and the `jira_connections.census_at` column (the `Connections` object declares it; ONLY the store writes
  it, `stampCensus`). `upsert` (`upsertRows` over `(connection_id, issue_id)`, ONE short transaction per chunk, every column of a row set so a fresh read
  overwrites) first takes the connection row `FOR SHARE` and skips the write when it is no longer ACTIVE: a connection delete holds `FOR NO KEY UPDATE`, so a
  racing run either finishes first (the delete then removes its rows) or finds the connection gone - no mirror row outlives its connection. `index`, `delete`
  (by ids; the caller chunks by `RUN_CHUNK`) and `censusAt` are plain reads/writes of the mirror; none takes the plan lock or touches a revision.
  `JiraConnectionService.delete` hard-deletes the mirror in the delete's transaction (`JiraIssueStore.deleteForConnectionInTransaction`, the `sync_runs`
  pattern; a log INFO with the count, no audit field). **The run writes it (1.4, `jira/JiraCensus.kt`)**: every page entry of the run's read becomes a row
  (`CensusIssue.of`, kept at the mapped and child levels), buffered by id and flushed through `upsert` in `RUN_CHUNK`s; after the reconcile the run diffs
  `index` against the sweep's listing and prunes in `RUN_CHUNK` batches (`delete` takes at most `RUN_CHUNK` ids), and lists the child level in full (a full
  read) or as an id sweep (every `jira.censusHours`) before `stampCensus` writes `census_at`; a child listing that hit the page ceiling prunes NOTHING. The
  deviation view is the only VIEW that reads it (`jira/DeviationCoverageRows.kt`, below). The mirror keeps Jira business text in PLAINTEXT like `jira_observations`
  (summaries of every in-scope issue, unbound stories included; `security.md` "Encryption at rest"); a row is kept only for a type the run's sweeps ask for, so
  an issue of an unlisted type never flaps in and out.
- `jira/JiraBindingService` (V21) OWNS `jira_bindings` (V22 added the acknowledgement columns `ack_fingerprint`, `ack_at`, `ack_by_user_id` to its table object;
  the bind inserts none, `JiraAcknowledgeService` below writes them, the deviations view reads them) and writes the FIRST `jira_observations` row of a bind
  (`JiraObservations`, `JiraObservations.kt`: the table object the run's observer will upsert through). It takes no plan lock and bumps no revision - a binding
  is not plan state. It READS `planning`: `OwnerChains.kt`'s `programChain`/`projectChain`/`milestoneChain` (the ACTIVE chain, the guard's input and the "is
  this node dead?" test of the inline release) and, in `JiraBindingNodes.kt`, `MilestoneService.Milestones` ⋈ `ProjectService.Projects` ⋈
  `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` for the nodes' names (batched per level, no `active()` filter: the names of nodes a page of live
  bindings sits on), the `lastKnownChain` of a binding whose node is gone (the unbind guard: the owner columns WITHOUT any `active()` filter, for the guard
  only) and the list's live-node and `q` sub-queries (a binding is listed only while its node and every ancestor are ACTIVE); `PlanPermissions`-style arithmetic
  is not used (the guard is `requireOwnerOrAdmin`). It READS `JiraConnectionService.Connections` (`site_url` and `enabled` for D1 and the browse URL; never
  `api_token`, never `discovery`), `UserService.Users` and `PersonService.People` through `planning`'s `creatorsOf` (`createdBy`: the creating login's ACTIVE
  person, else its display name, never an email). **Locks, in this order, all inside the bind's one transaction (the Jira call is made BEFORE it, in the route,
  never inside it):** (1) `pg_advisory_xact_lock(BIND_LOCK_KEY)` - ONE global transaction-scoped advisory lock taken first by every bind (binds are human clicks
  of a few milliseconds, so global serialization costs nothing and makes the checks below exact; D1's cross-connection rule is a check over rows that do not
  exist yet, which no row lock can serialize); (2) the connection row `FOR SHARE` (conflicts with the connection delete's and edits' `FOR NO KEY UPDATE`: a
  delete racing a bind either commits first - the bind is a 400 - or waits and then unbinds the committed binding with D2); (3) the node's own row `FOR SHARE`
  (`lockNodeShared`, conflicts with its soft delete and owner change: either the delete commits first - the bind is a 404 - or waits for the bind's commit and
  the binding is released by the next bind or the run's sweep); never an ancestor's row, so no lock cycle with a plan writer that updates a chain top-down; (4)
  the caller's person row `FOR SHARE` inside the guard's second run (`PersonService.lockedActivePersonIdOf`); (5) the conflicting ACTIVE bindings
  `FOR NO KEY UPDATE`, in id order. The connection row is selected WITH its `project_keys` in that same locked statement and the issue key's project is
  re-checked against them, so a `projectKeys` PUT that lands while the Jira read is in flight cannot commit an out-of-scope binding
  (`JiraBindingGuardRaceTest`). Nothing else creates an active binding while the advisory lock is held (unbind, the connection delete and the sweep only free
  rows), so the node check, the issue check - this connection AND every other ACTIVE connection with the same `LOWER(site_url)`, D1 - and the insert are exact,
  and the two V21 unique indexes are a pure backstop (`ErrorHandling.kt` carries no wording for their 23505s, so a violation that ever escaped the locked checks
  answers the generic `409` of the backstop). A conflicting binding of the ISSUE whose node (or any ancestor) is soft-deleted is RELEASED (soft-deleted in the
  same transaction, reported to the route for the `jira.binding_released` audit after the commit); a live holder is a `409 already-bound`. **Residual window,
  named:** an ANCESTOR's owner changed (or the caller's right through an ancestor revoked) between the chain re-read and the commit is not excluded - only the
  node's own row is locked; the effect is a binding made by a caller who stopped owning the chain milliseconds earlier.
  `jira_observations.binding_id → jira_bindings(id)` and the binding FKs to `programs`/`projects`/`milestones`/`users`/`jira_connections` have no `ON DELETE`
  rule (all soft-deleted).
- `jira/JiraAcknowledgeService` (1.3; `POST`/`DELETE /integrations/jira/bindings/{id}/acknowledge`) WRITES the three acknowledgement columns of `jira_bindings`
  (`ack_fingerprint`, `ack_at`, `ack_by_user_id`, plus `updated_at`) and nothing else: no plan lock, no revision bump (an acknowledgement is not plan state), no
  `plan_state` read. It READS `planning`'s ACTIVE chains (`programChain`/`projectChain`/`milestoneChain` through `activeChain`), `UserService.Users` and
  `PersonService.People` through `creatorsOf` (the response's `acknowledgedBy`: the ACTIVE person's name, else the login's display name, never an email), and -
  to recompute the one binding's deviations IN its own transaction - everything the deviations view reads (`DeviationViewService.computeBindingInTransaction`:
  the connection row, the binding left-joined to its observation, the node and its ancestors, the derived span of a bound project or program, the parent issue's
  binding, `public_holidays`). **Locks, one short READ COMMITTED transaction:** (1) the binding row `FOR NO KEY UPDATE` (`lockActiveForWrite`; gone = 404), (2)
  the caller's person row `FOR SHARE` inside the guard's second run (`lockedActivePersonIdOf`; the unbind's order - a person writer never waits for a binding
  row, so no cycle), nothing else. The row lock is what makes the compare exact: the run's observation write locks the same binding row first
  (`JiraRunStore.lockActive`), so the Jira side cannot move under the compare; the plan side is read statement by statement, so an edit landing in between makes
  the compare a `409` or, at worst, accepts the fingerprint of a mixed state - harmless, since a stored fingerprint is re-compared on every read and such an
  acknowledgement just reads `current = false`. The scope passed to the recompute names the binding's connection too, so only that connection row (and its
  discovery) is decoded. The `409 stale-deviations` also covers a binding with no deviation at all. `ack_by_user_id` has no `ON DELETE` rule: a soft-deleted
  login keeps its acknowledgement and reads `by = null`. Tests: `JiraAcknowledgeRaceTest`.
- `jira/JiraRunStore` (V21) is the run's database side: it OWNS the upserts of `jira_observations` (`upsertRows` over `binding_id`, one transaction per chunk of
  100 bindings, EVERY column of the row set so a fresh read always carries `gone = false`) and the `gone` flag (`markGone` / `clearGone`: `OUT_OF_SCOPE`, refined to `DELETED` / `FORBIDDEN` by the run's probe via `recordProbe`, which also stamps `gone_probed_at`; the stored reason is never `MOVED_OUT`: since 1.12 the API derives that wire value from `OUT_OF_SCOPE` + a non-null stamp (`wireGoneReason`), the CHECK and the column are unchanged; the run's four writers (`writeObservations`, `markGone`, `clearGone`, `recordProbe`) set or clear the stamp with the flag, and the bind/import's `insertFirstObservation` relies on the column default (gone = false, stamp NULL); the
  content last read untouched), and WRITES `jira_bindings.marked_as_deleted` for the node sweep (`releaseDeadNodeBindings`: the connection's ACTIVE bindings
  whose node or any ancestor is soft-deleted, `NODE_GONE`). It READS `jira_bindings` (**every read filters `Bindings.active()`**: a deleted connection's rows
  stay in the table) left-joined to `jira_observations`, and, through `JiraBindingNodes.kt`'s `liveNodeIds`, `MilestoneService.Milestones` ⋈
  `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` for the liveness of a node (decided in Kotlin: `NOT (a OR b OR c)`
  over the three nullable node columns is NULL, not true, for a dead node). **A run takes no plan lock, bumps no revision and holds no transaction across a Jira
  call** (the plan's `plan_state` is never touched; an observation is not plan state); each write transaction re-selects its bindings `active()` in ID ORDER,
  `FOR NO KEY UPDATE` for the chunk that may rewrite a key (never upgraded from `FOR SHARE`) and `FOR SHARE` for the gone-flag writes, so a binding unbound
  after the run started is skipped (never resurrected, never a foreign-key failure - bindings are only ever soft-deleted) and an unbind waits for the chunk or
  has won. The run's transaction takes binding rows and nothing before them, so the bind's documented order (advisory lock, connection, node, person, binding
  rows) still holds. **A moved issue's new key** (an observation whose key differs from `jira_issue_key`) is written to `jira_bindings.jira_issue_key` in the
  same chunk, with a new `updated_at` for those rows only. **Residual deadlock, named:** the connection delete's `UPDATE` of all its bindings locks rows in scan
  order, not id order, so a chunk and a delete can in theory lock two rows in opposite orders (`40P01`); PostgreSQL aborts one, the run ends `FAILED`/`INTERNAL`
  (class names only in the log) and the next run recovers on its own. A binding created after the run's start snapshot is not in it and waits for the next run.
  `JiraObserver` itself touches no table. The run asks `JiraConnectionService.runnableState` (a read of `jira_connections`, its own short transaction) before
  every search page and stops with `CONNECTION_GONE`/`CONNECTION_DISABLED` once the connection is deleted or disabled.
- `jira/JiraImportService` (1.2; the import preview) WRITES nothing and takes NO lock: `read` is ONE `READ ONLY REPEATABLE READ` transaction (`planning`'s
  `SNAPSHOT`) that reads the plan revision FIRST (`readPlanRevision`), then `PublicHolidays` (`loadWorkingCalendar`), the picked work stream's active tree
  (`programs`, `projects ⋈ programs`, `milestones ⋈ projects ⋈ programs`, with each node's owner for the guards' chains), ALL active `programs.name` (the global
  name rule), `teams` (active; the caller's managed teams through `TeamService.activeManagedTeamIds`, which reuses this transaction) and `jira_bindings` /
  `jira_connections` (the active bindings of the browsed issues on every active connection of the site, with `liveNodeIds`/`describeNodes`); `requireShape` and
  `namedChains` are plain short reads of `people`, `teams`, `programs`, `projects` and the owner chains (`workStreamChain`, `programChain`, `projectChain`). The
  browse (`JiraImportBrowse.kt`) calls Jira outside every transaction. **The apply (1.2; `JiraImportApply.kt`, `JiraImportService.apply`) is the ONE Jira write
  that moves the plan**, and WRITES in ONE `withPlanWrite` (one bump, also when everything is skipped): `programs`, `projects`, `milestones` through
  `PlanNodeInserts.kt` (the services' own insert blocks; milestones inserted with `schedule_revision = revision + 1`),
  `milestones.start_date/end_date/schedule_revision/updated_at` through `writeSchedules` at `revision + 1` for the scheduled ones (**the third writer of those
  columns**, beside `MilestoneService.schedule`, `TeamScheduleService.batch` and `acceptRun`, listed so; a milestone inserted at `revision + 1` and then scheduled ends with
  the value the schedule PUT stamps, so a client at the answered revision is not stale and a view older than the import is), and `jira_bindings` /
  `jira_observations` through `JiraBindingService.insertBoundLocked` (the dead-node holders it finds are soft-deleted: the binding's own release). **Lock order,
  which nothing may invert:** the plan lock (`plan_state FOR UPDATE`) -> `pg_advisory_xact_lock(BIND_LOCK_KEY)` -> the connection row `FOR SHARE` (gone `404`,
  disabled `400`, project keys moved since the browse `400`, `mapping_changed_at` or `discovered_at` moved `409`) -> the caller's person `FOR SHARE` -> the
  named defaults' chains -> the owner (`requireActiveOwner`) and every named team (`requireActiveTeam`) `FOR SHARE` -> the caller's managed teams
  (`lockedIsActiveManager`, `FOR SHARE OF teams, people`) -> the plan side re-read (tree, names, holders, calendar: plain reads, exact under the lock) -> the
  kernel over THOSE rows -> the guard on every ticked CREATE/BIND row's target -> the dead holders to release locked `FOR NO KEY UPDATE` in ONE `ORDER BY id`
  statement (the run's sweep updates in id order) -> each written milestone's team `FOR SHARE` -> top-down, per row, the insert of a CREATE's node or
  `lockNodeShared` on a BIND's target -> `writeSchedules` -> per written row `insertBoundLocked`. A bind holds the advisory lock and waits only on node, person
  and binding rows; node rows are held by plan writers (never concurrent with the import, which holds the plan lock), person rows by person writers, binding
  rows by an unbind or the run's sweep - none of which waits for the advisory lock - and the import takes the advisory lock before touching any row, so there is
  no cycle (`JiraImportApplyRaceTest` races one against the other and pins that an import waiting for the plan lock holds no advisory lock). The Jira browse
  happens BEFORE the transaction: the plan lock is never held across HTTP. **`NAME_TAKEN` is decided in Kotlin** from the names read under the plan lock
  (programs: every active `LOWER(name)`; projects per parent program; milestones per parent project) plus the batch's own earlier rows: exact because every
  creator of these rows holds the plan lock. The `uq_*` indexes stay the backstop: a `23505` aborts the whole transaction (it cannot be caught per row) and is
  the central whole-request `409`. Residual: PostgreSQL `LOWER()` vs Kotlin `lowercase()` disagreeing on an exotic character. Measured hold
  (`JiraImportScaleTest`, `build-times.md`): about 1 s for 20 programs / 100 projects / 1,000 milestones, about 2 s at the 2,000-item cap.
- `jira/DeviationViewService` (V21; `GET /views/deviations`) WRITES nothing and takes NO lock: ONE `READ ONLY REPEATABLE READ` transaction (`planning`'s
  `SNAPSHOT`, the timeline views' protocol) that reads the plan revision FIRST (`readPlanRevision`; the view moves none: observations are not plan state), then
  `PublicHolidays` (`loadWorkingCalendar`), `JiraConnectionService.Connections` (the ACTIVE rows, enabled or not: `name`, `site_url`, `enabled`, `mapping` and -
  to resolve the mapping - `discovery`, decoded in memory and never returned; never `api_token`), `SyncRunService.recentRunsInTransaction` (each connection's
  newest `sync_runs` rows, `idx_sync_runs_connection`, in the caller's transaction; the connection's `status` derives from them and the poll columns
  `poll_interval_minutes`, `mapping_changed_at`, `updated_at`, `discovered_at`, since 1.3), `JiraBindingService.Bindings` ⋈ `Connections` (active; a disabled
  connection's bindings are read, they still block their node) left-joined to `JiraObservations` (**every read filters `Bindings.active()`**; the three `ack_*`
  columns ride the binding row, and `creatorsOf` names the acknowledging logins), and `planning`'s tree (the owner columns of the stream, program and project
  too, for `can.acknowledge`): `Programs`/`Projects`/`Milestones` ⋈ `WorkStreams`/`Programs`/`Projects` ⋈ `Teams` for the LIVE bound nodes (node and every
  ancestor ACTIVE, batched per level), `Milestones` ⋈ `Teams` via `milestoneFacts(projectIds)` for the bound projects' and programs' derived spans (only those
  projects' milestones, only when one is bound) and `Projects` ⋈ `Programs` ⋈ `WorkStreams` for the live projects of a bound program. Since 1.4
  (`jira/DeviationCoverageRows.kt`, still the same snapshot, one statement per input, scoped to the bindings in view) it also READS `jira_issues` (the census
  mirror: a bound epic's children grouped for the roll-up, and the open children of a bound program or project at the mapping's level, with a correlated
  `NOT EXISTS` over `jira_bindings` ⋈ `jira_connections` aliased as the peer that matches the issue id on the SAME `site_url`, both `active()`), and
  `Projects`/`Milestones` for a bound program's and project's direct ACTIVE children that have no active binding on an active connection (`NOT EXISTS` over
  `jira_bindings`); a read of other features' tables, which the matrix above covers. The verdict of a binding reads its own row, its connection, the mirror and
  the other bindings from the tables, never from the computation's scope, so a scoped computation gives the full view's fingerprint. Bounded by the plan's scale
  (at most one binding per node, ≤ 2,000 rows answered); a dead node's or a deleted connection's binding stays a row and is simply not read into the answer.

#### `sync/`

- `sync/SyncRunService` (V21) OWNS `sync_runs` and reads no other table - except that `sync/ConnectionRegistry.kt` (`runnableStateOf`, `isRunnable`,
  `pollRowsOf`) reads a connector's connection table passed in as a parameter, only through the `ConnectionColumns` interface (name, enabled, interval,
  `updated_at`, `marked_as_deleted`: no credential column; the connector's own mapper adds its `ready`/`changedAt` columns), and
  `statusesInTransaction(kind, …)` (`sync/SyncStatus.kt`) is the one status reader both connectors call (`sync/` imports no connector package; the connector
  registry is `SyncConnectors`, filled by `configureJira` and `configureFlow`; `sync_runs.kind` stores the `SyncKind` NAME, `JIRA` or `FLOW`, the V21 CHECK
  admits exactly those two, and a persisted enum value is never renamed or removed). `claim` is ONE transaction: finish any unfinished row of the (kind,
  connection) older than `sync.maxRunMinutes` as `ABANDONED`, prune the FINISHED rows to the newest 49, INSERT the unfinished row - a `23505` on
  `uq_sync_runs_running` is the `409 run-in-progress` (the abandon and the prune roll back with it, harmlessly). `finish` updates `WHERE finished_at IS NULL`
  only, so a late finish never rewrites an abandonment, and clamps `error_detail` (500) and `error_code` (40). The partial unique index IS the lock (see
  `observability.md` "Sync runs" for the replicas): no advisory lock, no `SKIP LOCKED`. `recentRuns` / `recentRunsInTransaction` (1.3) read
  `started_at, finished_at, outcome` of a connection's newest 50 rows for the scheduler's due rule (one indexed `LIMIT` per connection,
  `idx_sync_runs_connection`); the scheduler writes nothing but through `claim`.

#### `flow/`

- `flow/FlowConnectionService` (V24) reads and writes its own table, `flow_connections` (the registry: soft-delete, no plan lock, no revision), and nothing of
  any other feature's but through the owners' own methods, with one exception: its `delete` runs in ONE transaction under the connection row
  `FOR NO KEY UPDATE`, sets `api_token` NULL (V24: an `enc:v1:` envelope, or NULL on a deleted row only, `ck_flow_connections_api_token` and `_live`), WRITES
  `flow_team_bindings` (`FlowTeamBindingService.Bindings`: the connection's ACTIVE bindings soft-deleted, the count `bindingsUnbound` for the
  `flow.connection_deleted` audit; the team index has no connection column, so a binding left active would block its team for good), hard-deletes the
  connection's `sync_runs` (`SyncRunService.deleteForConnectionInTransaction(SyncKind.FLOW, id)`) and hard-deletes the mirror
  (`FlowMirrorStore.deleteForConnectionInTransaction`; the counts are a log INFO, not an audit field), and (1.10) hard-deletes the capacity
  acknowledgements of those bindings (`Acknowledgements.deleteForConnectionInTransaction`, AFTER the soft delete so the binding rows are locked first; the
  count `acknowledgementsDeleted` is an audit field). It owns the second ENCRYPTED column: written as a
  `FieldCipher` envelope, decrypted by exactly two readers — `readForTest` and `readForRun` (a decrypt failure reads as a null token, never an exception) —
  never on a read path (the response carries `hasApiToken`), registered with the boot backfill (`encryptedAtRestServices()`, never to be removed). `pollRows`
  (`FlowConnectionPolling.kt` maps the row; `sync/ConnectionRegistry.kt`'s `pollRowsOf` reads it over `ConnectionColumns`, the columns both registries share -
  no `api_token`) selects eight columns by name, never the token; `status`/`lastRun` on its responses are DERIVED per read from the connection's own `sync_runs`
  (`SyncRunService.recentRunsInTransaction(SyncKind.FLOW, …)`, one indexed query per listed connection, nothing stored). **`FlowMirrorStore.replace`** (the
  run's one write, `FlowObserver`; ONE transaction, the connection row `FOR NO KEY UPDATE`, nothing written for a deleted connection) replaces the mirror
  wholesale, except that a TRUNCATED document (`teamsTruncated`) replaces only the teams it carries (`keepAbsentTeams`) and keeps every other mirrored team
  whole, so a team Flow merely did not send is never absent from the mirror. `flow/` WRITES no other table of another feature; the capacity import's apply
  writes `team_capacity_periods` only through `TeamCapacityService.applyImport`, listed under `teams/`.
- `flow/FlowMirrorStore` (V24) OWNS `flow_teams`, `flow_sprints`, `flow_members` and the `flow_connections.teams_at` column (the `Connections` object declares
  it; ONLY the store writes it). `replace` is ONE transaction: the connection row `FOR NO KEY UPDATE` (taken at its final strength, since the same transaction
  stamps `teams_at` on that row: never `FOR SHARE` upgraded by the UPDATE; a delete, an edit or a second replace queues on it, so a racing run either finishes
  first and the delete removes its rows, or finds the connection gone and writes nothing — no mirror row outlives its connection), then the three tables' old
  rows deleted, the new ones inserted by multi-row `insertRows` (fitted to the columns first: text cut, control characters to spaces, an out-of-range figure
  dropped, a repeated key collapsed to the first), `teams_at` stamped; a failure rolls the whole document back and the previous one stays. It takes no plan
  lock, bumps no revision and holds no transaction across an outbound call. The `FOR NO KEY UPDATE` does not conflict with an FK check's `FOR KEY SHARE`, so a
  binding insert is never stalled by a replace. **It writes no acknowledgement itself (1.9's `clearGoneAcknowledgements` is gone):** its `afterWrite` block runs
  inside the transaction after `teams_at` is stamped, and the run fills it with `CapacityAcknowledgeService.pruneConnectionInTransaction` (listed under
  `flow/CapacityAcknowledgeService` below), which takes the binding rows AFTER the connection row.
- `flow/FlowTeamBindingService` (V24) OWNS `flow_team_bindings` (the writes - `bind`, `unbind`, `match` - and the reads `bindingsOf`/`teamIdOf`; every read
  filters `Bindings.active()` AND joins `TeamService.Teams` on `active()`). It READS `teams` (active ids and names) and LOCKS the team row `FOR SHARE` in a link
  or a match (no `teams` write), reads the connection row (`FOR SHARE`: enabled) and the mirror's `flow_teams` (the Flow team's name) and writes none of them;
  `FlowTeamService` (the Flow team list and the team panel) is read-only over the mirror, the bindings, the registry and `teams`. Lock order of a link or a
  match: the advisory bind lock (`FLOW_BIND_LOCK_KEY`), the connection row, the team row(s), the guard's team and person rows, then the binding rows
  `FOR NO KEY UPDATE`. `flow_team_bindings.team_id → teams(id)`, `created_by_user_id → users(id)` (a plain `long` column in Exposed: `flow/` imports no `users`
  type) and `connection_id → flow_connections(id)` have no `ON DELETE` rule: all are soft-deleted. **A soft-deleted team leaves its binding ACTIVE** (`teams/`
  may not name `flow/`, so `TeamService.delete` cannot unbind), and `uq_flow_team_bindings_flow_active` would then block that Flow team for good: every read
  (`bindingsOf`, the match, the team panel) filters on ACTIVE teams, and the link and the match release a dead-team holder of the Flow team inside their own
  transaction (soft-delete the binding, the Jira bind's dead-node release). The two partial unique indexes are a pure backstop under the advisory bind lock and
  have no `ErrorHandling` wording (unreachable; `FlowBindingGuardRaceTest` pins the Kotlin 409 text).
- `flow/CapacityImportService` (V24) is READ-ONLY: one `READ ONLY REPEATABLE READ` transaction over the binding (`FlowTeamBindingService.bindingOf`), the
  connection's `time_zone`, `public_holidays` (`planning.loadWorkingCalendar`), the mirror's `flow_teams`/`flow_sprints` and - through
  `TeamCapacityService.importRowsOf` - the team's ACTIVE `team_capacity_periods` with their provenance columns. The PREVIEW writes nothing. The APPLY
  (`CapacityImportService.apply`) writes `team_capacity_periods` ONLY through `TeamCapacityService.applyImport` (listed under `teams/`) - `flow/` never touches
  the table itself; it reads, inside that transaction and under the team row lock, the binding, the connection's `time_zone`, `public_holidays` and the mirror's
  `flow_teams`/`flow_sprints` (plain reads; the Flow team and its sprints in one statement, so a refresh cannot make the team look present with no sprints).
- `flow/CapacityDeviationService` (1.6, no migration; `GET /views/capacity-deviations`) is READ-ONLY: one `READ ONLY REPEATABLE READ` transaction over
  `public_holidays` (`planning.loadWorkingCalendar`), `flow_connections` (its own registry table: the scheduler's eight poll columns plus `time_zone`, NEVER
  `api_token`), `sync_runs` (`SyncRunService.statusesInTransaction(SyncKind.FLOW, …)` in `sync/SyncStatus.kt`, the connections' newest runs),
  `flow_team_bindings ⋈ teams` (`FlowTeamBindingService.activeBindingsWithTeams`: ACTIVE bindings of ACTIVE teams, the `bindingsOf` predicate in one statement),
  `flow_teams`/`flow_sprints` (`FlowMirrorStore.teamSprintsOf`, the team and its sprints in one statement per binding) and the bound teams' ACTIVE
  `team_capacity_periods` (`TeamCapacityService.importRowsOfTeams`, one statement, `importRowsOf`'s predicate and order grouped by team). Nothing is locked,
  written or audited, and no revision is read: capacity periods are team data.
- `flow/CapacityAcknowledgeService` (V26, 1.9; `POST`/`DELETE /integrations/flow/team-bindings/{id}/acknowledge`, 1.10 `POST …/acknowledge-all`, 1.11 `POST …/unacknowledge-all`) OWNS `flow_capacity_acknowledgements` and READS
  `flow_team_bindings ⋈ teams` (ACTIVE both), and - through `CapacityDeviationService.computeBindingInTransaction` - the view's inputs for ONE binding
  (`public_holidays`, the connection's `time_zone`/`teams_at`, the mirror's team and sprints, the team's ACTIVE periods); it writes no other table. **Lock order:
  the unbind's shape** - the binding row `FOR NO KEY UPDATE` FIRST (`lockActiveForWrite`), then the guard's team and person rows `FOR SHARE`
  (`TeamService.lockedIsActiveManager`), then the acknowledgement rows; no plan lock, no bind lock, no connection row. It joins the no-cycle argument of
  `FlowTeamBindingService` as a second binding-first path (a `FOR SHARE` on a team never waits for a binding row; a team delete locks the team row and touches
  no binding). **Since 1.10 a row lives only while its deviation row is listed, and the service is the table's only writer:** `acknowledge` also deletes its
  binding's rows that are no longer listed (under the binding row it already holds); `pruneConnectionInTransaction` runs INSIDE the run's `FlowMirrorStore.replace`
  transaction (its `afterWrite`) and deletes the unlisted rows of every binding of the connection, in the **connection-first order: the connection row (the
  replace), then the binding rows `FOR NO KEY UPDATE` in id order (only bindings that have stored rows), then the acknowledgement rows**, one `DELETE`; and
  `Acknowledgements.deleteForConnectionInTransaction` (the connection delete, after its soft delete of the bindings) removes every row of the connection's
  bindings. **Invariant: every write of a binding's acknowledgement rows holds that binding's row lock**, so no two multi-row writes lock one binding's rows in
  opposite orders; nobody goes binding → connection (the binding-first paths never take the connection row). `binding_id → flow_team_bindings(id)` and
  `ack_by_user_id → users(id)` (a plain `long` in Exposed: `flow/` names no `users` type) have no `ON DELETE` rule: bindings and users are only soft-deleted,
  so the rows of an unlinked binding or a deleted team go at the connection's next run (and a deleted connection's with it; those of a connection deleted before
  1.10 stay, invisible: every read joins an ACTIVE binding of an ACTIVE team). A test that hard-deletes bindings or users removes these rows first
  (`removeFlowFixtureRows`).

#### `telemetry/`

- `telemetry/StorageCollectors.kt` (the storage panel) reads, OUTSIDE the telemetry cluster transaction (the heavy phase: each statement is a short transaction
  of its own, `HeavyCollectors.kt`): the catalogs (`pg_class`, `pg_namespace`, `pg_attribute`, `pg_database_size`, `pg_total_relation_size`) for sizes — row
  COUNTS and sizes only, never a payload; it writes nothing outside `ops`.
- `telemetry/TelemetryRoutes.kt` (the ADMIN read API: `TelemetryReads.kt`, `TelemetryCurrent.kt`, `TelemetryHistory.kt`) READS `ops.telemetry_processes` /
  `ops.telemetry_samples` (its own schema; one SELECT per transaction under `queryTimeout` 5 s, the history grouped per role/metric/label/bucket in SQL). Since
  1.3 `TelemetrySync.kt` (the `sync` block of `GET /telemetry/current`) also READS `sync_runs` through `SyncRunService.recentRuns` and the connectors' rows
  through `Connector.connections()` (the poll columns, never a token): two read-only transactions of their own, no table of its own touched, so the matrix above
  is the permission.

### Schemas

Astrolabe's PostgreSQL database is split across schemas:

- **`public`** — the foundation tables (`users`, `people`, `teams`, `revoked_tokens`, `user_disabled_features`, `password_reset_tokens`) and the planning tables
  (`plan_state`, `work_streams`, `programs`, `projects` since V12, `roadmap_entries` since V13, `milestones` since V14, `dependencies` since V15, `team_milestone_orders` and `team_order_state` since V17, `public_holidays` since V19, `baselines` + `baseline_projects` + `baseline_milestones` since V20; `planning-model.md`), the team data (`team_capacity_periods` since V16), the Jira sync (`jira_connections`, `jira_bindings`, `jira_observations`, `sync_runs` since V21, `jira_issues` since V23), the Flow sync (`flow_connections`, `flow_teams`, `flow_sprints`, `flow_members`, `flow_team_bindings` since V24). Flyway's own history table also stays here — `flyway.schemas` is left at its default.
- **`ops`** — Astrolabe's own operational telemetry (V9, "Telemetry (V9)" below): the process registry and the metric samples each
  process writes about itself. Numbers and labels only, never project data.

**How Exposed addresses a schema-qualified table.** No Exposed `Schema` object and no
`search_path` override are involved: a table object simply passes the dotted, schema-qualified name straight to the `Table(...)`
constructor — e.g. `object Samples : Table("ops.telemetry_samples")` — and Exposed/R2DBC resolve it as-is, including a cross-schema
FK reference. `CREATE SCHEMA IF NOT EXISTS <schema>` runs in the first migration that needs the schema (V9 for `ops`) — never a
standalone "create schemas" migration.

### Per-user permissions (V11)

`user_permissions (user_id BIGINT REFERENCES users ON DELETE CASCADE, permission VARCHAR(30), PRIMARY KEY (user_id, permission))` — the **grant** set
(a row = held, no row = not held; the opposite polarity of V5's disabled set, so the empty table needs no backfill and nobody starts with a right). The
Kotlin `Permission` enum (`users/User.kt`) is the whitelist (no CHECK, the V5 precedent); `UserService.UserPermissions` is the Exposed table, a
hard-delete join table like `user_disabled_features` (see "Soft delete (convention)"): `PUT /users/{id}/permissions` replaces the set wholesale inside
one transaction that first locks the user row `FOR NO KEY UPDATE` (`replacePermissions`: concurrent PUTs serialize instead of racing on the primary key, and
the previous set it returns is exact for the audit event). `UserService.hasPermission` reads the table per call, never cached — see `authorization.md`
"Roles vs permissions". `ON DELETE CASCADE` is inert today (users are only soft-deleted); a soft-deleted user's rows stay, unread.

### Credential revision (V7)

`users.credential_revision` is an internal nonnegative BIGINT generation, initially zero. Every
password update/reset and conditional bootstrap rotation increments it atomically in SQL with the
hash update. It is carried in signed access and refresh tokens and pending MFA challenges; the per-request access
check (`TokenBlocklistService.accessVerdict`), refresh and MFA acceptance compare it with the current user row.
Soft delete and role changes do NOT bump it (the access check compares the stored role separately; a delete
is `user_gone`). It is not exposed in user DTOs. A password-reset grant (V8) captures it and goes stale when it moves.
`password_changed_at` remains a timestamp, not an authorization boundary.

### Password reset tokens (V8)

`password_reset_tokens`: single-use grants, only the SHA-256 digest of the emailed token is stored (`token_hash` PK), with the
account snapshot (`email`, `credential_revision`) the link was issued against and `expires_at`; `user_id` references `users` with
`ON DELETE CASCADE`. A hard-delete table (expiring credentials, not history — see "Soft delete (convention)"); expired rows are
pruned opportunistically.

### Telemetry (V9)

`ops.telemetry_processes` and `ops.telemetry_samples` (V9; `telemetry/TelemetryStore.kt`, `.claude/docs/observability.md` "Telemetry")
are the tables of the `ops` schema (created by this migration, the "no standalone create-schemas migration" rule). A process row is one
JVM run (`role`, `instance`, `started_at`, `last_seen`, `build_version`/`build_commit`, `processors`, `heap_max_bytes`, nullable
`container_limit_bytes`; unique on `(role, instance, started_at)`; `role` is the constant `"app"` — Astrolabe is one process, no worker);
`telemetry_samples` is ONE narrow table for every metric —
`(resolution, metric, ts, process_id, label)` is the primary key (`resolution` = the sample width in seconds: a raw row stores the sampler's real interval, 60..1800 and a divisor of 3600, an hourly rollup 3600 - the tier is `resolution < 3600`; the CHECK enforces it), `n`/`avg`/`max` the figures, so a metric is added in
`TelemetryMetrics.kt` with no migration. Epoch-millis `BIGINT` timestamps, `SERIAL` ids, the cluster section's rows (its marker today) attributed to
the process that took the lock. Writes go through `infra/db/MultiRowInsert.kt`'s `insertRowsIgnoringConflicts`; every statement runs under
the transaction's `queryTimeout`.

**The telemetry prune is a hard-delete exception**: samples are regenerated, high-volume observations with no reader once old, so they
are deleted, not soft-deleted — raw rows older than 7 days, hourly rows older than 90, processes unseen for 90 days (their samples
cascade, `ON DELETE CASCADE`; an index on `process_id` keeps that cascade off a table scan). The prune runs inside the telemetry cluster
transaction under `TELEMETRY_LOCK_KEY`, and a row exactly at its cutoff stays. The tests own the schema:
`TelemetryStoreTest`/`TelemetrySamplerTest` empty `ops` before each test (the suite starts no sampler).

### Soft delete (convention)

`users`, `people`, `teams`, `work_streams`, `programs`, `projects`, `milestones`, `dependencies`, `team_capacity_periods`, `baselines` (V20, the header), `jira_connections` and `jira_bindings` (V21; an unbound binding stays as history), `flow_connections` and `flow_team_bindings` (V24, the same two shapes) are **soft-deleted** — rows are flagged, never physically removed; every
business entity follows the same convention. Only join/token tables (today: `revoked_tokens`, a
pure token registry, `password_reset_tokens` (V8, expiring single-use credentials, not history), `user_disabled_features`, a pure flag join
whose PUT is a wholesale replace, `user_permissions` (V11, the same shape: a pure grant join rewritten wholesale), `roadmap_entries` (V13, a pure position join: the global rank is rewritten wholesale by `PUT /roadmap/ranking` and compacted when a project is deleted, so a project that leaves the rank has no history worth keeping — the soft-deleted project row stays), `team_milestone_orders` (V17, the same shape per team: a team's order is rewritten wholesale by `PUT /teams/{id}/milestone-order` and compacted when a milestone leaves the team, is deleted or its project is deleted; `team_order_state` beside it is one revision row per team, never removed, inert for a deleted team), `public_holidays` (V19, the registry exception: nothing references a holiday by FK, a removed row is simply re-added and its UNIQUE date must free on delete, so a soft-delete flag would only block re-adding it; every write still runs under the plan lock), `jira_observations` (V21, the registry exception: it is the LATEST observed state of a binding, upserted by every run since C6 (`JiraRunStore.writeObservations`), so history is not kept and there is nothing to soft-delete; no purge exists - its binding is only ever soft-deleted), `sync_runs` (V21, pure operational history pruned to the last 50 per connection at claim time, the `ops.telemetry_*` class, and removed with its connection: `JiraConnectionService.delete` hard-deletes the connection's runs in its own transaction, because the unfiltered run list has no connection filter that would hide a deleted connection's runs and a run is no record worth keeping of a registry row that no longer shows; a run still in flight ends as a no-op finish and writes no observation, its chunks re-selecting ACTIVE bindings), `jira_issues` (V23, the census mirror: the latest observed in-scope issues of a connection, overwritten by every run and pruned by its sweeps, so nothing is soft-deleted; removed with its connection like `sync_runs`: `JiraConnectionService.delete` calls `JiraIssueStore.deleteForConnectionInTransaction` in its own transaction), `flow_capacity_acknowledgements` (V26, a stamp keyed by binding and sprint: an un-acknowledge, a prune of a row that left the list and the connection delete remove it, like `jira_observations` it keeps no history), `flow_teams`, `flow_sprints` and `flow_members` (V24, the Flow mirror: the latest observed document of a connection, replaced wholesale by every run in one transaction and removed with its connection by `FlowConnectionService.delete`, the `jira_issues` class), and the `ops.telemetry_*` samples (the prune above)) hard-delete — a new
hard-delete table needs a documented justification, exactly like Lettuce's exceptions list. **A third category, v0.9 (V20): FROZEN rows** — `baseline_projects` and `baseline_milestones` are never updated, soft-deleted or hard-deleted: a `BEFORE UPDATE OR DELETE … FOR EACH ROW` trigger plus a `BEFORE TRUNCATE … FOR EACH STATEMENT` one (`forbid_baseline_row_change`, Flow's `metrics.forbid_snapshot_change` ported WITHOUT its purge bypass) raises for every such statement (the header `baselines` has the TRUNCATE twin and its own `forbid_baseline_header_change`: DELETE refused, and `id`, `plan_revision`, `created_by_user_id`, the counts and `created_at` immutable; name, description, `updated_at` and the flag stay writable), and the rows of a soft-deleted baseline are kept as history (no purge exists; a future one adds its own bypass in its own migration). They hold no FK to a live row, so a frozen copy reads the same whatever happens to the live milestone, project or team. Pure operational history with no reader once
old (job queues, samples) may be pruned by a fixed documented retention window, the same shape as the JWT blocklist's opportunistic
pruning of expired `revoked_tokens` rows. To add soft-delete to a new entity, follow the established pattern
(reference implementation: `users/UserService.kt`):

1. **Migration** — `marked_as_deleted BOOLEAN NOT NULL DEFAULT FALSE` in the CREATE (a retrofit
   adds the column plus `CREATE INDEX idx_<t>_marked_as_deleted ON <t>(marked_as_deleted);`).
2. **Exposed table** — declare the table `: UIntIdTable("…"), SoftDeletable` with
   `override val markedAsDeleted = bool("marked_as_deleted").default(false)`; the ONE `active()`
   predicate, `nowMillis()` and `lockActiveForWrite` come from `infra/db/SoftDelete.kt` (no
   private copies).
3. **Filter every read** — `read`, `list`, `count`, and any lookup (e.g. `findWithIdByEmail`) get
   `… and active()`. Apply it in the shared list predicate so the `count()` (total) and the row
   select stay consistent.
4. **`delete` flips the flag** — `update({ (id eq id) and (markedAsDeleted eq false) }) { it[markedAsDeleted] = true }`,
   returning the affected-row `Int`; guard `update` mutations the same way. The route maps
   `0 → 404` (the `orNotFound` helper), so a missing-or-already-deleted row is `404` (not `204`)
   and delete stays idempotent in effect — `UserService.deleteGuarded` shows the shape, adding the
   last-admin check inside the same transaction.
5. **Routes need no special-casing** — they key `404`/`204`/`NoContent` off the row-count and the
   `active()`-filtered `read`.

**Freeing a unique business field on delete.** To let a value be reused once its holder is
soft-deleted, use a **partial unique index** over active rows instead of a global `UNIQUE`:
`CREATE UNIQUE INDEX uq_<t>_<col>_active ON <t>(<col>) WHERE NOT marked_as_deleted;`. Skip the
Exposed `.uniqueIndex()` on that column (Exposed defs are query-only — the DB enforces it). A
clash with an **active** row still raises `23505 → 409` (mapped centrally in
`plugins/ErrorHandling.kt`, which names WHAT clashed per constraint — extend
`UNIQUE_CONSTRAINT_DETAILS` when adding a partial unique index). In place today: `users.email`
(`uq_users_email_active`, `V1`), the team name (`uq_teams_name_active`, `V6` — an expression
index over `LOWER(name)`), and in V10 the person email (`uq_people_email_active`, over `LOWER(email)`, only when set) and the login link
(`uq_people_user_id_active`, one active person per login); person names are deliberately NOT unique. V12 adds `uq_work_streams_name_active` and `uq_programs_name_active` (global,
over `LOWER("name")`) and `uq_projects_program_name_active` (per program, over `(program_id, LOWER("name"))`) — the 409 wording for all three is in `UNIQUE_CONSTRAINT_DETAILS`. V14 adds `uq_milestones_project_name_active` (per project, over `(project_id, LOWER("name"))`). V15 adds `uq_dependencies_pair_active` over the four endpoint columns with **`NULLS NOT DISTINCT`** (Postgres 15+; the pinned image is 18): each side leaves one of its two id columns NULL, and a default unique index treats NULLs as distinct, so without it two links on the same pair would never collide. V16 adds `uq_team_capacity_periods_team_from_active` (per team, over `(team_id, effective_from)`, so a team's period start dates are unique among ACTIVE periods). V20 adds `uq_baselines_name_active` (global, over `LOWER(name)`: a baseline name is unique among ACTIVE baselines, case-insensitively). V21 adds `uq_jira_connections_name_active` (global, over `LOWER(name)`), and the binding indexes `uq_jira_bindings_node_active` (over the three node columns with `NULLS NOT DISTINCT`, the V15 trick) and `uq_jira_bindings_issue_active` (over `(connection_id, jira_issue_id)`), both over ACTIVE rows.

**`infra/db/Sql.kt`** (ported from Lettuce with the first list endpoint): `containsNormalized` —
the case- AND accent-insensitive substring filter over `public.unaccent` (V4); every per-column
substring filter MUST use it. Also `orVanished` (post-commit read-back guard → 500, for every
create that reads its row back).

### Row locks vs. FK locks

PostgreSQL's foreign-key check takes `FOR KEY SHARE` on the REFERENCED row for every child insert and keeps it until the
inserting transaction ends. A long transaction whose inserts reference a parent row therefore holds key-share locks on every parent it
touched for its whole run; `SELECT … FOR UPDATE` on that parent conflicts with `FOR KEY SHARE` and would wait behind it (Flow hit this
with its long-running derive job against team rows; Astrolabe's planning writes, which reference teams and projects, are the same shape).

The rule: **lock a row `FOR NO KEY UPDATE` unless the write changes its key.** That mode conflicts with itself and with
`UPDATE`/`DELETE` (writers of the row, e.g. a soft delete racing a child insert, still serialize) but
NOT with `FOR KEY SHARE`, so FK locks never stall it. `lockActiveForWrite` (`infra/db/SoftDelete.kt`,
`FOR NO KEY UPDATE`), `TeamService.update`, `PersonService.update`/`delete` and `PasswordResetService.lockUser` (the active `users` row) follow it; none of them touches
`id`, and the unique indexes on these tables are partial or expression indexes (`uq_teams_name_active`, `uq_users_email_active`), which
PostgreSQL does not count as key columns — a rename is still a non-key update. Plain `FOR UPDATE` is for a row nothing references from a
long transaction (`users` is referenced only by columns no long transaction inserts — `updated_by_*`, `people.user_id`,
`user_disabled_features.user_id`, `password_reset_tokens.user_id` (short inserts only) — plus `baselines.created_by_user_id`, inserted inside the plan-locked baseline create (tens of milliseconds): its FK check holds `FOR KEY SHARE` on the creating user's row until the create ends, so a plain `FOR UPDATE` on that user waits for the create, boundedly, and cannot deadlock with it (the create waits on no `users` row lock, and the user-row writers take no plan lock): `UserService.lockedActiveAdminCount`), or for
`SKIP LOCKED` claims. A new `FOR UPDATE` on an FK-referenced row needs that justification in a comment. Flow pinned both halves with `RowLockVersusDeriveTest` (a writer completes while another transaction holds `FOR KEY SHARE` on the row, and a second `FOR NO KEY UPDATE` writer still waits); Astrolabe's planning writes take ONE lock instead, on `plan_state` (below), so the lock-wait barrier tests of `PlanStateTest` (a raw JDBC session holds the lock, the request waits, the release lets it complete) are the descendant of that test. The plan's **count-the-children-then-delete** needs more than a parent-row lock: a child INSERT's FK check takes only `FOR KEY SHARE`, which `lockActiveForWrite`'s `FOR NO KEY UPDATE` does not block, so the count runs under the `plan_state` lock that every child create also holds.

### The plan (V12)

`plan_state` (one row, `CHECK id = 1`: the plan's monotonic `revision` and the lock row), `work_streams`, `programs`, `projects` (`planning/*Service.kt`; DDL, constraints and uniqueness scopes in `planning-model.md`).
Dates are `DATE` through `LocalDateColumn.kt` (`start_date`/`end_date`, `target_start`/`target_end`, each with a `CHECK` backstop); ids are `SERIAL`; every node has `owner_person_id INTEGER NOT NULL REFERENCES people(id)`.
**Every write of these tables (and of `milestones`, V14 — the batch schedule of v0.8.0 included —, `dependencies`, V15, and `team_milestone_orders`/`team_order_state`, V17, `public_holidays`, V19, and the `baselines` registry with its frozen rows, V20 — and the milestone pin, V25, `MilestoneService.pin`) runs in `withPlanWrite`** (`planning/PlanState.kt`): `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, the block, `UPDATE … revision = revision + 1`. **This is the one deliberate PLAIN
`FOR UPDATE` on a table the code treats as a lock row** — justified by the rule above: nothing references `plan_state` by a foreign key (no FK check can queue behind or in front of it) and its key never changes, so the
`FOR NO KEY UPDATE` refinement buys nothing. Because all plan writers serialize there, the node services take no per-row locks; the plan lock is held across the whole block, which makes the delete's child count race-free
and lets the ranking (V13) compare `expectedRevision` atomically — against `plan_state.ranking_revision` (V18), which `replaceRanking` and `removeFromRanking` stamp with the new plan revision (`revision + 1`). A block that throws rolls the bump back. Reads (`PlanViewService`, `RoadmapViewService.view`) read the revision first without the lock (both views are `SNAPSHOT, readOnly`). `ProjectService.delete` calls
`removeFromRanking`: the project's `roadmap_entries` row is hard-deleted and the positions above renumbered in the same locked transaction.

### The roadmap rank (V13)

`roadmap_entries (project_id INTEGER PRIMARY KEY REFERENCES projects(id), position INTEGER NOT NULL CHECK (position >= 1), CONSTRAINT uq_roadmap_entries_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED)`
(`planning/RoadmapService.kt`; semantics in `planning-model.md` "The global project rank"). One row per RANKED project; no row = unranked. **Positions are dense 1..n**, kept so by the two writers, both inside
`withPlanWrite`: `replaceRanking` (`DELETE` all, then one `insertRows` with positions 1..n in the given order) and `removeFromRanking` (delete the row, then ONE `UPDATE … SET position = position - 1 WHERE position > ?`); both then stamp `plan_state.ranking_revision` (V18).
**`DEFERRABLE INITIALLY DEFERRED` is load-bearing**: an immediate unique constraint is checked row by row, so the sweep (and any reorder that swaps two positions in one statement) can collide with a
not-yet-updated neighbour depending on physical row order; deferred, the check runs once at commit, when the table is dense again. The cost is that a genuine duplicate surfaces at COMMIT, not at the statement
(only a bug can produce one: every writer holds the plan lock). `project_id` has no `ON DELETE` rule: projects are only soft-deleted, and the delete hook removes the entry in the same transaction. A hard-delete
table, justified in "Soft delete (convention)".

### The team milestone order (V17)

`team_milestone_orders (milestone_id INTEGER PRIMARY KEY REFERENCES milestones(id), team_id INTEGER NOT NULL REFERENCES teams(id), position INTEGER NOT NULL CHECK (position >= 1), CONSTRAINT uq_team_milestone_orders_position UNIQUE (team_id, position) DEFERRABLE INITIALLY DEFERRED)` and
`team_order_state (team_id INTEGER PRIMARY KEY REFERENCES teams(id), revision BIGINT NOT NULL, updated_at BIGINT NOT NULL)` (`planning/TeamOrderService.kt`; semantics in `planning-model.md` "The team milestone order"). The roadmap rank's shape, per team: one row per LISTED milestone, **positions dense 1..n per team**, kept so by
the writers inside `withPlanWrite` — `replaceOrder` (`DELETE` the team's rows, one `insertRows` with positions 1..n) and `removeFromTeamOrders` (delete the rows, then one `UPDATE … SET position = position - 1 WHERE team_id = ? AND position > ?` per removed row, highest position first). **`DEFERRABLE INITIALLY DEFERRED`** for the roadmap's reason: the
sweep and a swap are single statements an immediate check can reject depending on physical row order (`TeamOrderLifecycleTest` pins the swap, the commit-time duplicate and the CHECK). `team_order_state.revision` is the plan revision at which the team's order was last written (the first write inserts the row, later ones update it; a removal never touches it) — the
`expectedRevision` of the order PUT compares against it, so another team's reorder never stales this one. Both tables are hard-delete, justified in "Soft delete (convention)".

### The public holidays (V19)

`public_holidays (id SERIAL PRIMARY KEY, holiday_date DATE NOT NULL, name VARCHAR(100) NOT NULL, created_at BIGINT NOT NULL, CONSTRAINT uq_public_holidays_date UNIQUE (holiday_date))` (`planning/PublicHolidayService.kt`; semantics in `planning-model.md` "The calendar (V19)"): Flow's V25 registry, ported, with a real `DATE` (the `localDate` column) instead of Flow's `VARCHAR(10)` and **no seed** — the `POLISH` preset endpoint is the path. One global dictionary, unique per date (a duplicate is `23505` -> the central `409`, the plan lock rolled back with it). Hard-delete, justified in "Soft delete (convention)". Every create, delete and preset application is one `withPlanWrite`; the preset selects the year's existing dates under the lock and inserts the rest with `insertRowsIgnoringConflicts` (one statement).

### The baselines (V20)

`baselines (id SERIAL PRIMARY KEY, name VARCHAR(100), description VARCHAR(500) NULL, plan_revision BIGINT, created_by_user_id BIGINT NULL REFERENCES users(id), milestone_count INTEGER, project_count INTEGER, created_at BIGINT, updated_at BIGINT, marked_as_deleted BOOLEAN)` plus `uq_baselines_name_active ON (LOWER(name)) WHERE NOT marked_as_deleted` and `idx_baselines_marked_as_deleted` (`planning/BaselineService.kt`; semantics in `planning-model.md` "Baselines"). `plan_revision` is the plan revision the baseline EQUALS: the one its creation left behind (`revision + 1` inside `withPlanWrite`, which hands the block the OLD revision), so a view whose revision equals it shows zero movement.
`baseline_projects (baseline_id INTEGER REFERENCES baselines(id), project_id, program_id, work_stream_id, name, program_name, work_stream_name, rank_position NULL, target_start/target_end DATE NULL, span_start/span_end DATE NULL, PRIMARY KEY (baseline_id, project_id))` and `baseline_milestones (baseline_id REFERENCES baselines(id), milestone_id, project_id, team_id, name, estimate_md NUMERIC(8,2) CHECK >= 0, start_date/end_date DATE NULL, PRIMARY KEY (baseline_id, milestone_id))` with `idx_baseline_milestones_team (baseline_id, team_id)` and `idx_baseline_milestones_project (baseline_id, project_id)`: the FROZEN rows (the soft-delete section's third category). `ck_baseline_*` CHECKs mirror the live tables' (both-or-neither dates, end not before start, `rank_position >= 1`); the `project_id`/`program_id`/`work_stream_id`/`milestone_id`/`team_id` columns are plain `INTEGER` (no FK). Every write runs under the plan lock; the create is one `insertRows` per row table. `BaselineTest` (the caller matrix, names, the cap, the held grant), `BaselineCopyTest` (the copy equals the plan, the trigger for UPDATE and DELETE on both tables, `createdBy`, the loaders) and `MigrationChecksumTest` pin it.

### The Jira sync tables (V21)

`jira_connections (id SERIAL, name VARCHAR(100), site_url VARCHAR(253), email VARCHAR(254), api_token TEXT, auth_scheme VARCHAR(10) CHECK IN ('BASIC','BEARER'), project_keys JSONB CHECK (an array of 1..50), cloud_id VARCHAR(36) NULL, mapping JSONB DEFAULT '{}' CHECK (an object), discovery JSONB NULL, discovered_at BIGINT NULL, mapping_changed_at BIGINT NULL, last_tested_at BIGINT NULL, last_test_ok BOOLEAN NULL, enabled BOOLEAN DEFAULT TRUE, created_at, updated_at, marked_as_deleted)` plus `uq_jira_connections_name_active ON (LOWER(name)) WHERE NOT marked_as_deleted` (`jira/JiraConnectionService.kt`; the registry, ADMIN only). `api_token` is the application's first encrypted-at-rest column (a `FieldCipher` envelope, `enc:v1:...`). `project_keys`, `mapping` and `discovery` are the first `jsonb` columns of Astrolabe (`infra/db/Jsonb.kt` below): the service reads and writes `project_keys` through `infra/json/JsonArrays.kt`'s `stringArrayJson`/`parseStringArray`, and `mappingSet` is `mapping <> '{}'`. The site is a connection's identity: a PUT with another `siteUrl` is a 409, so the cloud id, discovery, mapping and (later) bindings always describe one site.
`jira_bindings (connection_id → jira_connections, level CHECK IN ('PROGRAM','PROJECT','MILESTONE'), program_id/project_id/milestone_id INTEGER NULL → programs/projects/milestones, jira_issue_id VARCHAR(20), jira_issue_key VARCHAR(50), created_by_user_id BIGINT NULL → users, …, marked_as_deleted)`: `ck_jira_bindings_node` (exactly one node column set, and it is the one the level names), `uq_jira_bindings_node_active` and `uq_jira_bindings_issue_active` (1:1 both ways over the ACTIVE rows) and an index per node column. No `ON DELETE` rule: the nodes are only soft-deleted. `jira_observations (binding_id PRIMARY KEY → jira_bindings, observed_at, issue_key, summary, type_*, hierarchy_level, status_name, status_category CHECK IN ('TODO','IN_PROGRESS','DONE','UNKNOWN'), parent_issue_*, start_date/end_date DATE NULL, estimate NUMERIC(12,2) NULL, estimate_unit, team_name, jira_updated_at, gone, gone_reason CHECK IN ('DELETED','OUT_OF_SCOPE','FORBIDDEN'), gone_probed_at BIGINT NULL (V27), CHECK (gone_probed_at IS NULL OR gone))` (`gone_reason` is written `OUT_OF_SCOPE` by the sweep and refined to `DELETED`/`FORBIDDEN` by the run's probe; `gone_probed_at` is the probe's last ANSWER (200, 404 or 403) for the current vanish, NULL until one comes, cleared with `gone`; V27 has no backfill, so a row flagged before 1.10 is probed by the next run; `JiraSchemaTest` pins the column and the CHECK) stores Jira's dates AS OBSERVED, so there is no start/end order CHECK (an end before the start is a deviation to show, not a row to refuse). `sync_runs (kind CHECK IN ('JIRA','FLOW'), connection_id INTEGER (no FK: the kind decides the table), "trigger" CHECK IN ('MANUAL','SCHEDULED'), started_at, finished_at NULL, outcome CHECK IN ('SUCCEEDED','FAILED','ABANDONED'), error_code, error_detail, the counters)` with `uq_sync_runs_running ON (kind, connection_id) WHERE finished_at IS NULL` (the single-writer claim) and `idx_sync_runs_connection`. `jira_connections` has code since 1.1.0 C2, `jira_bindings` + the first `jira_observations` row since C5, and `sync_runs` + the observer's upserts since C6 (`SyncRunServiceTest`, `SyncRunnerTest`, `SyncRunRoutesTest`, `JiraRunTest`, `JiraRunFailureTest`, `JiraRunWireTest`); `JiraSchemaTest` pins every CHECK, the partial indexes and the foreign keys of all four at the database, `JiraConnectionTest` the registry, `JiraBindingTest`/`JiraBindingLifecycleTest`/`JiraBindingRaceTest` the bindings and their locks, `EncryptedAtRestBootTest` the backfill and `MigrationChecksumTest` the bytes.

**V22 (1.3.0, polling and acknowledge).** `jira_connections.poll_interval_minutes INTEGER DEFAULT 15` (`ck_jira_connections_poll_interval`: NULL or 5..1440; NULL = manual only, and the DEFAULT backfills every existing connection with 15) and on `jira_bindings` `ack_fingerprint VARCHAR(64) NULL` (`ck_jira_bindings_ack_fingerprint`: 64 lower-case hex), `ack_at BIGINT NULL`, `ack_by_user_id BIGINT NULL → users` (no `ON DELETE`: users are soft-deleted) and `ck_jira_bindings_ack` (`ack_fingerprint` and `ack_at` are both set or both NULL) and `ck_jira_bindings_ack_by` (`ack_by_user_id` is set only with `ack_at`: an un-acknowledge clears all three columns). No index: the ack columns are read with the binding row and the poll rows are a scan of a handful of connections. `JiraSchemaTest` pins the four CHECKs, the interval DEFAULT and the foreign key.

### The Jira census (V23)

`jira_issues (connection_id INTEGER → jira_connections, issue_id VARCHAR(20) CHECK ~ '^[0-9]{1,20}$', issue_key VARCHAR(50), type_id VARCHAR(20) NULL, hierarchy_level INTEGER, parent_issue_id VARCHAR(20) NULL, summary VARCHAR(255) NULL, status_category CHECK IN ('TODO','IN_PROGRESS','DONE','UNKNOWN'), points NUMERIC(12,2) NULL, jira_updated_at BIGINT NULL, observed_at BIGINT, PRIMARY KEY (connection_id, issue_id))` plus `ix_jira_issues_parent ON (connection_id, parent_issue_id)`, and `jira_connections.census_at BIGINT NULL` (when the child level was last fully censused; NULL for every existing connection, which makes its first 1.4 run a full read). The mirror is the latest observed CENSUS of a connection's scope (the mapped levels plus the child level the roll-ups read): one row per issue, overwritten by every run, pruned by the run's sweeps, hard-deleted with its connection - a second documented hard-delete exception beside `jira_observations`. No soft delete, no revision, no plan lock. The row is built by `CensusIssue.of` (`jira/JiraIssueStore.kt`), which fits every string to its column and clamps the points like an observation's estimate, so a statement cannot fail on a site's odd value; written only by `JiraIssueStore` in `RUN_CHUNK` transactions. `JiraSchemaTest` pins the key, the foreign key, the two CHECKs, the widths of `issue_id`, `issue_key`, `type_id`, `parent_issue_id` and `summary`, the index and the nullable `census_at`; `JiraIssueStoreTest` pins the `FOR SHARE` vs `FOR NO KEY UPDATE` race between a run's census write and the connection delete.

### The milestone pin (V25)

`V25__milestone_pin.sql` adds `milestones.pinned BOOLEAN NOT NULL DEFAULT FALSE` and `ck_milestones_pinned_scheduled CHECK (NOT pinned OR start_date IS NOT NULL)` (a pin needs dates). Existing rows
take `FALSE`, which satisfies the CHECK, so the migration rewrites no data. The pin is advice to the planner: the auto-proposal treats a pinned milestone as FIXED (`planning-model.md` "The auto-proposal"); nothing else
reads it, a baseline does not freeze it (V20 is untouched) and it is not part of `schedule_revision` (a pin never stales a drag). **The writers of `milestones.start_date`/`end_date` are exactly three, and each keeps
the CHECK true:** `MilestoneService.schedule` (the null pair sets `pinned = FALSE` in the same `UPDATE`; a dated write leaves it), `writeSchedules` (`MilestoneScheduleWrite.kt`, the batch accept's and the Jira import's shared
multi-row statement: `pinned = pinned AND v.s IS NOT NULL`) and the insert of a new milestone (`insertMilestoneRow`: dates NULL, `pinned` the default). `MilestoneService.pin` is the only writer that sets the flag
TRUE, under `withPlanWrite` (the lock, ONE bump, `schedule_revision` untouched), with the schedule PUT's guard re-run inside (`TeamService.lockedIsActiveManager`) and the stored dates re-read there. A new writer of
the dates must clear the pin the same way, or the CHECK turns its miss into a 500 (`MilestonePinTest` pins the CHECK itself). A team change keeps the dates and so the pin (the new team's manager inherits both).

### The Flow sync tables (V24)

`flow_connections (id SERIAL, name VARCHAR(100), base_url VARCHAR(255), time_zone VARCHAR(64), api_token TEXT NULL, enabled BOOLEAN DEFAULT TRUE, poll_interval_minutes INTEGER NULL, last_tested_at BIGINT NULL, last_test_ok BOOLEAN NULL, teams_at BIGINT NULL, created_at, updated_at, marked_as_deleted)` plus `uq_flow_connections_name_active ON (LOWER(name)) WHERE NOT marked_as_deleted` (`flow/FlowConnectionService.kt`; ADMIN registry). `base_url` is an exact origin the operator listed (the connection's identity: a PUT never changes it); `time_zone` an IANA id (instants are stored raw, the zone applies at read time); `api_token` the second encrypted-at-rest column (`enc:v1:` envelope; `ck_flow_connections_api_token` refuses plaintext, `_live` allows NULL on a deleted row only); `ck_flow_connections_poll_interval` NULL (manual only) or 5..1440, no column DEFAULT (the registry writes 60 when omitted); `teams_at` the instant the last run replaced the mirror.
The mirror, replaced wholesale per run: `flow_teams (connection_id → flow_connections, flow_team_id INTEGER, name VARCHAR(100), default_capacity_md NUMERIC(8,2) NULL, observed_at BIGINT, PK (connection_id, flow_team_id))`, `flow_sprints (connection_id, flow_team_id, sprint_id BIGINT, source_connection_id INTEGER, name VARCHAR(255), state VARCHAR(10), start_at/end_at/complete_at BIGINT NULL, has_calendar BOOLEAN, capacity_md NUMERIC(10,2) NULL, capacity_source VARCHAR(20) NULL, PK (connection_id, flow_team_id, sprint_id))` with `ix_flow_sprints_team (connection_id, flow_team_id, start_at)` and `flow_members (connection_id, flow_team_id, account_id VARCHAR(128), display_name VARCHAR(255) NULL, valid_from BIGINT, valid_to BIGINT NULL, PK (connection_id, flow_team_id, account_id, valid_from))`. No foreign key between the three (a run replaces them together); `FlowMirrorStore` fits every row to these widths.
`flow_team_bindings (id SERIAL, connection_id → flow_connections, team_id → teams, flow_team_id INTEGER, flow_team_name VARCHAR(100), created_by_user_id BIGINT → users, created_at, updated_at, marked_as_deleted)`: `uq_flow_team_bindings_team_active ON (team_id)` (a team has one Flow team across ALL connections) and `uq_flow_team_bindings_flow_active ON (connection_id, flow_team_id)`, both over ACTIVE rows; no `ON DELETE` rule (all soft-deleted). `team_capacity_periods` gains `source VARCHAR(10) NOT NULL DEFAULT 'MANUAL'` (`ck_team_capacity_periods_source IN ('MANUAL','FLOW')`; every existing row is MANUAL), `flow_sprint_id BIGINT NULL` and `flow_sprint_name VARCHAR(255) NULL` (`ck_team_capacity_periods_flow_sprint` ties them to `source`: MANUAL with both NULL, or FLOW with both set). Tests: `FlowSchemaTest` (every CHECK, the partial indexes, the keys and foreign keys by SQLSTATE), `FlowConnectionServiceTest`, `FlowMirrorStoreTest`, `TeamCapacityTest`, `MigrationChecksumTest`.

### The capacity acknowledgements (V26)

`flow_capacity_acknowledgements (id SERIAL, binding_id INTEGER → flow_team_bindings, sprint_id BIGINT NULL, fingerprint VARCHAR(64), ack_at BIGINT, ack_by_user_id BIGINT → users)` (`flow/CapacityAcknowledgeService.kt`; `flow-sync.md` "Acknowledge (1.9)"). `sprint_id` is Flow's sprint id; **NULL is the binding's `TEAM_GONE` row** (the one deviation a gone team has), so `uq_flow_capacity_acks_key ON (binding_id, sprint_id) NULLS NOT DISTINCT` (Postgres 18, the V15/V21 idiom) makes the team row collide with itself. `ck_flow_capacity_acks_sprint` (NULL or >= 1) and `ck_flow_capacity_acks_fingerprint` (`^[0-9a-f]{64}$`). **Hard rows, no `marked_as_deleted`** (a stamp like `jira_observations`): an un-acknowledge DELETEs, a re-acknowledge rewrites `fingerprint`/`ack_at`/`ack_by_user_id` (1.10's acknowledge-all instead deletes the named keys and re-inserts them in one multi-row statement, so those rows get a new `id`; both under the binding row lock); the stored fingerprint is compared with the row's on every read, so a stale row is simply an open one again. **1.10: a row lives only while its deviation row is listed** - the run's replace, the acknowledge and the connection delete remove the rest (`flow-sync.md` "An acknowledgement does not outlive its row"), so the table is bounded by the listed rows, plus the plan-side residual of D6. Not plan state: no plan lock, no revision.

### Query plans (1.0.0)

`EXPLAIN (ANALYZE, BUFFERS)` of the four statements the timeline views run, hand-transcribed from Exposed and read-only, on the compose database at `d589007` (the sample plan: 1,000 active milestones, 349 links; the tables also held e2e residue, so the small-table scans below read 444 project, 282 program, 241 work stream and 277 team rows): the team view's join (`TeamViewRows`: milestones ⋈ projects ⋈ programs ⋈ work_streams ⟕ roadmap_entries for Platform) planned as a Bitmap Index Scan on `idx_milestones_team` (301 rows) with Seq Scans of the small tables, **0.37 ms** execution (planning 0.99 ms); `milestoneFacts` a Seq Scan of `milestones` (1,000 rows) joined to `teams`, **0.18 ms**; `linkFacts` a Seq Scan of `dependencies` (349 rows), **0.07 ms**; `linksTouching` a Seq Scan of `dependencies` (9 rows kept) with Index Scans on `idx_milestones_project`, **0.08 ms**. Every statement is a sequential or index scan over at most a few hundred to 1,000 rows and none dominates a request (a view costs about 20 ms end to end): **no index is needed at this scale, and none was added (V21 is the Jira sync, not an index)**. Revisit when a table reaches tens of thousands of rows; the figures and the method are in `timeline.md` "Measured figures (1.0.0)".

### The DATE column idiom (`infra/db/LocalDateColumn.kt`)

Dates are Postgres `DATE` (day precision; the planning tables from V12), bound through a repo-local column type because `exposed-r2dbc` 1.6.0 ships no date
module (no `exposed-java-time`, no `exposed-kotlin-datetime` — and none is added). `exposed-core` supplies the abstract
`org.jetbrains.exposed.v1.core.datetime.LocalDateColumnType<T>` (an `IDateColumnType`) and `exposed-r2dbc`'s `DateTimeTypeMapper` recognises such a column.
`JavaLocalDateColumnType` implements the two conversions (`kotlinx.datetime.LocalDate` ⇄ `java.time.LocalDate`) — **and overrides `notNullValueToDB` to
return the `java.time.LocalDate` itself, which is load-bearing**: the 1.6.0 base class is NOT zone-free (it builds `java.sql.Date(atStartOfDayIn(TimeZone.currentSystemDefault()))`,
and the mapper then calls `java.sql.Date.toLocalDate()` before binding), so every write and every WHERE parameter would pass through the JVM default zone and the
Julian/Gregorian cutover (measured against the 1.6.0 bytecode: UTC stored `1500-01-01` as `1499-12-23`; Pacific/Kiritimati stored `1994-12-31` as `1995-01-01`;
`0100-02-27` was a 500; Europe/Warsaw shifted dates up to 1900). The mapper only unwraps `java.sql.Date`/`Time`/`Timestamp`, so a `java.time.LocalDate` reaches
`Statement.bind` unchanged and r2dbc-postgresql's native `LocalDateCodec` encodes the calendar date; `nonNullValueToString` (the literal rendering) is the ISO
`'YYYY-MM-DD'` for the same reason. Reads were never affected. A table declares `val day = localDate("day")` (`Column<java.time.LocalDate>`, `.nullable()` as usual).
The wire format is an ISO `YYYY-MM-DD` string (`type: string, format: date`; DTO fields are `String`) parsed by `infra/validation/Dates.kt`
(`parseIsoDate(value, field)` → 400 "<field> must be a YYYY-MM-DD date" for a bad shape or a non-calendar day, and "<field> year must be between 1900 and 2999"
outside that calendar — a belt on top of the zone-free column, far inside what every zone's historical rules handle; `requireDateOrder(start, end)` → 400 "End must not
be before start", an end equal to the start being a one-day span); a `CHECK (end_date >= start_date)` in the migration is the backstop. `kotlinx-datetime-jvm` is only transitive: it
resolves to 0.7.1 at compile time and 0.8.0 at runtime (a pre-existing skew, in `BACKLOG.md`); the column type touches only `toKotlinLocalDate` / `toJavaLocalDate`,
which both versions carry. **`LocalDateColumnTest` is the proof** (scratch table by raw DDL): insert/select/update/null round-trip for the epoch, both DST-change days,
`2099-12-31` and the historical traps (`1500-01-01`, `0100-02-27`, `1899-12-31`, Kiritimati's skipped `1994-12-31`, Apia's skipped `2011-12-30`); the STORED text
(`::text`, read over raw JDBC) of an insert, an update and a WHERE parameter is the calendar date under EVERY swapped JVM default zone (UTC, Kiritimati, Apia, Pago_Pago,
Warsaw, Sao_Paulo); `greaterEq`/`orderBy` follow date order; and a `CHECK (other >= day)` violation surfaces as SQLSTATE 23514. The first version of the column type
(without the override) passed a narrower spike and was caught by review; had the override not been enough, the fallback was Flow's `VARCHAR(10)` ISO idiom
(the same wire format and validator, `varchar(…, 10)` + a regex `CHECK`).

### The NUMERIC column idiom (milestone estimate, V14)

`milestones.estimate_md` is `NUMERIC(8,2) NOT NULL CHECK (estimate_md >= 0)`, declared in Exposed as `decimal("estimate_md", 8, 2)` (`Column<BigDecimal>`) — **no repo-local column type**: none of `exposed-r2dbc` 1.6.0's type
mappers names `BigDecimal`, so the binding rides the default mapper, and `DecimalColumnTest` (a scratch table by raw DDL, the `LocalDateColumnTest` shape) is the proof: insert/select/update and a WHERE parameter for `0`, `0.1`, `12.25`,
`999999.99`, the stored `::text` over raw JDBC equal to the sent value at scale two (`0.1` is stored `0.10`), and `greaterEq`/`orderBy` in numeric (not text) order. Had it gone red the fallback was a repo-local column type binding the
`BigDecimal` through its plain-text literal (the `JavaLocalDateColumnType` shape) with the same wire format. The wire is a JSON number (`estimateMd: Double`, `type: number, format: double`); the server validates it (finite,
`0 <= x < 1_000_000`, and `BigDecimal(x.toString())` with at most two decimals — `validateMilestoneFields` over `validateManDays`, `planning/Milestone.kt`) so the stored value is EXACTLY the sent one, never a silent rounding; `MilestoneTest` pins the same values over HTTP.

### `infra/db/Jsonb.kt` and canonical JSON

`infra/db/Jsonb.kt` — a repo-local `jsonb` column type, because `exposed-r2dbc` 1.5.0 ships no
JSON column type of its own. It needs no reflection into the raw `io.r2dbc.spi.Statement`: Exposed
already ships a `JsonColumnMarker` interface plus a `PostgresSpecificTypeMapper` that specifically
recognizes any `IColumnType` implementing it (binding a null via `Statement.bindNull(index,
Json::class)`, a `String` via `Statement.bind(index, Json.of(value))` —
`io.r2dbc.postgresql.codec.Json`) — implementing the marker IS the whole binding. Values are the
caller's JSON text verbatim; PostgreSQL's own `jsonb` storage reformats regardless (whitespace, key
order), so "round-trips" means the same VALUES survive, not the same bytes. **The one exception to "same values" is U+0000**:
PostgreSQL `jsonb` and `text` cannot store a NUL (`unsupported Unicode escape sequence`, SQLSTATE 22P05 for jsonb; `22021` for
text). Every payload that goes through `canonicalJson` (`infra/json/CanonicalJson.kt`) therefore has each U+0000 in a string value AND
in an object key replaced with U+FFFD, before the text is hashed, so the stored text and its sha256 agree (U+FFFD marks that something
was there and cannot merge the tokens around it, which dropping the character would). The helper `String.replaceNul()` (same file)
applies the same rule to free text bound for a `text` column that is not a canonical JSON payload (a database exception's message can
quote the offending value). Covered by `JsonbColumnTest` (insert/select/update, null, nested objects/arrays) and `CanonicalJsonTest`.

`infra/json/CanonicalJson.kt` — canonical JSON for anything stored through `Jsonb.kt`: object
keys sorted RECURSIVELY (arrays keep their own order — position is meaning), rendered via
kotlinx.serialization's compact `JsonElement.toString()`, plus a `sha256Hex` digest of the result.
Two payloads that differ ONLY in object key order canonicalize to byte-identical text, so their
digests agree — this is key-order independence, not general structural equality: canonicalization
does not normalize number spelling (`1`, `1.0` and `1e0` stay distinct token text). The output must stay byte-stable, since stored
text and sha256 are compared against stored rows.

**Consumers (V21, `jira_connections`).** `project_keys` (an array, `infra/json/JsonArrays.kt`), `discovery` (the field/issue-type snapshot, `JiraDiscovery.toStoredJson()`) and, since Jira sync step C4, **`mapping`**: the `@Serializable` `JiraMapping` document (`jira/JiraMapping.kt`) encoded with `encodeDefaults` and no nulls, then `canonicalJson` (sorted keys at every level), so two PUTs that differ only in key order or in an omitted default store the same text and the same `sha256Hex` (the `jira.mapping_changed` audit digests). The column is read whole and decoded (`parseStoredMapping`; `{}` = unset), never filtered in SQL. Numbers keep their spelling through `jsonb` (`manDaysPerUnit` 0.5 stays `0.5`), so a re-read digest equals the written one. `JiraMappingTest` pins the round trip and the digests.

### Planned persistence (not yet built)

No table is pending (the capacity acknowledgements, V26, are the last table; the baselines, V20, were the last planning table; the v0.8 auto-proposal added none: a proposal is ephemeral and the batch writes the schedule PUT's columns). The schema list, the soft-delete list and the cross-feature matrix above grow in the same commit as each migration.
