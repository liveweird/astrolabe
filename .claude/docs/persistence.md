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
  value. The range today is **V1–V15**: V1 `users`, V2 `revoked_tokens`, V3 the seed admin, V4 the
  `unaccent` extension, V5 `user_disabled_features` (V1–V5 are Flow's), V6 `teams` (with the optional
  manager), V7 `users.credential_revision`, V8 `password_reset_tokens`, V9 the `ops` telemetry
  schema, V10 `people` (the people directory) with `teams.manager_person_id` replacing `manager_user_id`, V11 `user_permissions` (the per-user permission grants), V12 `plan_state` + `work_streams`/`programs`/`projects` (the plan structure), V13 `roadmap_entries` (the global project rank), V14 `milestones` (the fourth plan level), V15 `dependencies` (links between milestones and projects). (Astrolabe renumbered Flow's history when it was bootstrapped; from V10 on, migrations are
  append-only like any other.)
- **Exposed + R2DBC** (`infra/db/Database.kt` + the feature services) — runtime DB access.
  `Database.kt` connects the `R2dbcDatabase` and is the composition root: it constructs the
  services and publishes them into `Application.attributes` (`UserServiceKey`, `PersonServiceKey`, `TeamServiceKey`, the six planning keys,
  `TokenBlocklistServiceKey`, `PasswordResetServiceKey` today); each service itself lives next to the feature it serves
  (`users/UserService.kt`, `people/PersonService.kt`, `teams/TeamService.kt`, `planning/{WorkStream,Program,Project,Milestone,Dependency,PlanView,Roadmap}Service.kt`, `auth/TokenBlocklistService.kt`, `auth/PasswordResetService.kt`). The Exposed
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

A feature service MAY query — or WRITE — another feature's Exposed table objects directly when the
operation must run **inside its own transaction** (SQL joins, atomic snapshots, a single soft-delete that must also close a
dependent row elsewhere) — the transaction boundary must be explicit rather than relying on an unrelated
service to preserve it. Exposed reuses an enclosing transaction for nested `suspendTransaction`
calls on the same database. Route handlers never touch tables (services only). The reads/writes in
place:

- `TeamService` reads `PersonService.People` for the manager (V10): the active manager's name (one batched lookup per page), the
  manager id check on create AND update (it locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s
  `FOR NO KEY UPDATE`: a delete racing an assignment either commits first and the assignment is a 400, or waits and then sees the
  team and answers 409), and `isActiveManager`'s `Teams` ⋈ `People` ⋈ `Users` join (the team-manager guard: an ACTIVE
  team, an ACTIVE person whose `user_id` is the caller, and that user ACTIVE). `teams.manager_person_id`
  has no `ON DELETE` rule: people are only ever soft-deleted, and `PersonService.delete` refuses (409) while an ACTIVE team names the
  person.
- `planning/` (V12): the node services read `PersonService.People` — `OwnerChains.kt`'s `ownerNames` (the owners' display names, one batched lookup per read, no `active()` filter: an active node's owner is always
  an active person) and `requireActiveOwner` (the owner of a node being written must be ACTIVE, else 400; it locks the person row `FOR SHARE`, which conflicts with `PersonService.delete`'s
  `FOR NO KEY UPDATE`: a delete racing a node write either commits first and the write is a 400, or waits and then sees the node and answers 409 — never an active node owned by a deleted person;
  `PlanStateTest` pins both halves). The services also read each other's tables inside one feature: a delete counts the ACTIVE children (`Programs` from the work stream delete, `Projects` from the program
  delete) and the chain lookups join all three. `work_streams`/`programs`/`projects` hold `owner_person_id → people(id)` with no `ON DELETE` rule: people are only ever soft-deleted and `PersonService.delete`
  refuses (409) while an ACTIVE node names the person. `PlanViewService` reads the three tables (and `people` names) in ONE transaction, the revision first.
- `planning/` (V13): `RoadmapService` reads `ProjectService.Projects`, `ProgramService.Programs`, `WorkStreamService.WorkStreams` (the view's names, the active-id check of a ranking write) and `PersonService.People`
  (owner names, via `OwnerChains.kt`); it owns `roadmap_entries`, and `ProjectService.delete` WRITES it through `removeFromRanking` (same package, same locked transaction — no other feature touches the table).
- `planning/` (V14): `MilestoneService` reads and joins `ProjectService.Projects`/`ProgramService.Programs`/`WorkStreamService.WorkStreams` (`milestoneChain`, beside the other chains in `OwnerChains.kt`) and reads/locks
  `TeamService.Teams`: `requireActiveTeam` (the team of a milestone being created or changed must be ACTIVE, else 400; it locks the team row `FOR SHARE`, which conflicts with `TeamService.delete`'s
  `lockActiveForWrite` — `FOR NO KEY UPDATE`: a delete racing a milestone write either commits first and the write is a 400, or waits and then counts the milestone and answers 409 — never an active milestone on a
  deleted team; `TeamTest` pins both halves) and `teamName` (no `active()` filter: an active milestone's team is always active). `TeamService.delete` READS `Milestones` through `hasActiveMilestones` (the 409 "Team still has
  milestones", ACTIVE rows only, counted under the team row lock) and `ProjectService.delete` WRITES `Milestones` through `deleteMilestonesOf` (the cascade: the project's ACTIVE milestones are soft-deleted in the same plan-locked
  transaction, the count goes to the `project.deleted` audit). `TeamService.lockedIsActiveManager` (the schedule PUT's re-guard under the plan lock) is `isActiveManager`'s join with `FOR SHARE OF teams, people` — Exposed's
  `ForUpdateOption.PostgreSQL.ForShare(null, Teams, People)`, NOT the parameterless `ForShare` companion (which locks every joined row, the USER row included, and would queue a drag behind a password reset): a manager change
  (`TeamService.update`, `FOR NO KEY UPDATE`) or a re-link/delete of the manager's person either commits first (403 under the lock, no bump) or waits. `FOR SHARE` is refused with an aggregate, so the twin reads rows, never `count()`.
  `milestones.project_id → projects(id)` and `team_id → teams(id)` have no `ON DELETE` rule: projects and teams are only soft-deleted.
- `planning/` (V15): `DependencyService` reads `MilestoneService.Milestones`, `ProjectService.Projects`, `ProgramService.Programs`, `WorkStreamService.WorkStreams` and `TeamService.Teams` — `dependencyChain` (the SUCCESSOR's project chain, beside the other chains in `OwnerChains.kt`),
  `isActiveEndpoint` (the chain lookups), `resolveEndpoints` (a milestone's name, project and team, a project's name and the DERIVED span over its scheduled ACTIVE milestones; names read WITHOUT an `active()` filter: an active milestone's project and team are always active)
  and `loadTimePointGraph` (every active milestone's `(id, project_id)` and every active dependency, the cycle check's input) — all under the plan lock on a write. `MilestoneService.delete` and `ProjectService.delete` WRITE `Dependencies` through `deleteDependenciesOf`
  (the cascade: the ACTIVE links with either end at the milestone, or at the project and its milestones, are soft-deleted in the same plan-locked transaction; the counts go to the `milestone.deleted` / `project.deleted` audits; `activeMilestoneIdsOf` supplies the
  project's milestone ids before they are deleted). `dependencies` holds four nullable FKs to `milestones(id)` / `projects(id)` with no `ON DELETE` rule: both are only soft-deleted.
- `planning/` (v0.4.0 C2, no migration): the picker lists. `ProjectService.list` reads `ProjectService.Projects` ⋈ `ProgramService.Programs` ⋈ `WorkStreamService.WorkStreams` (their `name`s for `programName`/`workStreamName`, all three `active()`) and
  `PersonService.People` via `ownerNames`; `MilestoneService.list` reads `MilestoneService.Milestones` ⋈ `Projects` ⋈ `Programs` ⋈ `WorkStreams` (all four `active()`; the project's `name`) and `TeamService.Teams` (`teamName`, no `active()` filter: an active milestone's team is always active). One read transaction per list, count + rows on one predicate, no lock, no revision.
- `planning/` (v0.3.0 C2, no migration): `ProjectViewService` (`GET /views/project/{id}`) reads the project through `projectChainRow` (`OwnerChains.kt`: the ONE project-chain join + active predicate, which `projectChain` also uses; it joins `PersonService.People` for the owner name) and also reads `ProjectService.Projects`, `ProgramService.Programs`, `WorkStreamService.WorkStreams`, `MilestoneService.Milestones` and `TeamService.Teams`
  (the milestones ⋈ teams join for `teamName`, no `active()` filter on the team: an active milestone's team is always active) and `PersonService.People` (owner names, via `ownerNames`) in ONE read transaction, the revision first, no locks.
  `TeamService.activeManagedTeamIds(userId)` (the actor's managed teams for the `can.schedule` flags) READS `PersonService.People` and `UserService.Users` — `isActiveManager`'s join without the team id; a plain read, no lock.
- `PersonService` reads `UserService.Users` (the linked login: the active-user check on create AND update, the login's email on read/list
  through ACTIVE users) and `TeamService.Teams` (the delete 409 while the person manages an ACTIVE team; since V12 `planning/OwnerChains.kt`'s `ownsActivePlanNode` extends it to an ACTIVE work stream, program or project the person owns). `people.user_id` has no `ON DELETE` rule: users are only ever soft-deleted and the link stays INERT while the user is deleted
  (guards resolve the caller's person through `people.user_id = caller AND people.active()`, and a deleted login never passes the access
  verdict); a future hard purge of users must clear it first, and a future user RESTORE must re-audit the link (the person may have been
  re-linked to another login meanwhile — the partial unique index refuses a clash). A PUT from the SPA carries `userId: null` for an inert link (the
  response reads it as unlinked), so a rename from the UI clears a link to a soft-deleted login.
- `auth/TokenBlocklistService.accessVerdict` (the per-request access-token check, `plugins/Security.kt`) READS
  `users/UserService.Users` (`role`, `credential_revision`, `marked_as_deleted`, by primary key) and its own
  `revoked_tokens` (an `EXISTS` on the `jti`) in ONE uncached statement per authenticated request; it writes nothing.
- `auth/PasswordResetService` (V8) READS `users/UserService.Users` (the `active()` / `credential_revision` / `email` predicate
  of a grant's liveness, and `FOR UPDATE` on the user row) and WRITES `users.password_hash` / `password_changed_at` / `credential_revision`
  through `users`' `updatePasswordInTransaction` inside its own transaction (the grant is consumed in the same transaction).
- `plugins/Health.kt` (`GET /api/v1/ready`, the readiness probe) READS `users/UserService.Users` (`id`, `LIMIT 1`), a bounded round trip
  that proves the database answers; it writes nothing and returns no row.
- `telemetry/StorageCollectors.kt` (the storage panel) reads, OUTSIDE the telemetry cluster transaction (the heavy phase: each statement is a short
  transaction of its own, `HeavyCollectors.kt`): the catalogs (`pg_class`, `pg_namespace`, `pg_attribute`, `pg_database_size`, `pg_total_relation_size`) for
  sizes — row COUNTS and sizes only, never a payload; it writes nothing outside `ops`.
- `telemetry/TelemetryRoutes.kt` (the ADMIN read API: `TelemetryReads.kt`, `TelemetryCurrent.kt`, `TelemetryHistory.kt`) READS `ops.telemetry_processes` /
  `ops.telemetry_samples` (its own schema; one SELECT per transaction under `queryTimeout` 5 s, the history grouped per role/metric/label/bucket in SQL).

List each new cross-feature read/write here as it lands — the list IS the permission.

### Schemas

Astrolabe's PostgreSQL database is split across schemas:

- **`public`** — the foundation tables (`users`, `people`, `teams`, `revoked_tokens`, `user_disabled_features`, `password_reset_tokens`) and the planning tables
  (`plan_state`, `work_streams`, `programs`, `projects` since V12, `roadmap_entries` since V13, `milestones` since V14, `dependencies` since V15; `planning-model.md`). Flyway's own history table also stays here — `flyway.schemas` is left at its default.
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

`users`, `people`, `teams`, `work_streams`, `programs`, `projects`, `milestones` and `dependencies` are **soft-deleted** — rows are flagged, never physically removed; every
business entity follows the same convention. Only join/token tables (today: `revoked_tokens`, a
pure token registry, `password_reset_tokens` (V8, expiring single-use credentials, not history), `user_disabled_features`, a pure flag join
whose PUT is a wholesale replace, `user_permissions` (V11, the same shape: a pure grant join rewritten wholesale), `roadmap_entries` (V13, a pure position join: the global rank is rewritten wholesale by `PUT /roadmap/ranking` and compacted when a project is deleted, so a project that leaves the rank has no history worth keeping — the soft-deleted project row stays), and the `ops.telemetry_*` samples (the prune above)) hard-delete — a new
hard-delete table needs a documented justification, exactly like Lettuce's exceptions list. Pure operational history with no reader once
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
over `LOWER("name")`) and `uq_projects_program_name_active` (per program, over `(program_id, LOWER("name"))`) — the 409 wording for all three is in `UNIQUE_CONSTRAINT_DETAILS`. V14 adds `uq_milestones_project_name_active` (per project, over `(project_id, LOWER("name"))`). V15 adds `uq_dependencies_pair_active` over the four endpoint columns with **`NULLS NOT DISTINCT`** (Postgres 15+; the pinned image is 18): each side leaves one of its two id columns NULL, and a default unique index treats NULLs as distinct, so without it two links on the same pair would never collide.

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
`user_disabled_features.user_id`, `password_reset_tokens.user_id` (short inserts only): `UserService.lockedActiveAdminCount`), or for
`SKIP LOCKED` claims. A new `FOR UPDATE` on an FK-referenced row needs that justification in a comment. Flow pinned both halves with `RowLockVersusDeriveTest` (a writer completes while another transaction holds `FOR KEY SHARE` on the row, and a second `FOR NO KEY UPDATE` writer still waits); Astrolabe's planning writes take ONE lock instead, on `plan_state` (below), so the lock-wait barrier tests of `PlanStateTest` (a raw JDBC session holds the lock, the request waits, the release lets it complete) are the descendant of that test. The plan's **count-the-children-then-delete** needs more than a parent-row lock: a child INSERT's FK check takes only `FOR KEY SHARE`, which `lockActiveForWrite`'s `FOR NO KEY UPDATE` does not block, so the count runs under the `plan_state` lock that every child create also holds.

### The plan (V12)

`plan_state` (one row, `CHECK id = 1`: the plan's monotonic `revision` and the lock row), `work_streams`, `programs`, `projects` (`planning/*Service.kt`; DDL, constraints and uniqueness scopes in `planning-model.md`).
Dates are `DATE` through `LocalDateColumn.kt` (`start_date`/`end_date`, `target_start`/`target_end`, each with a `CHECK` backstop); ids are `SERIAL`; every node has `owner_person_id INTEGER NOT NULL REFERENCES people(id)`.
**Every write of these tables (and of `milestones`, V14, and `dependencies`, V15) runs in `withPlanWrite`** (`planning/PlanState.kt`): `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, the block, `UPDATE … revision = revision + 1`. **This is the one deliberate PLAIN
`FOR UPDATE` on a table the code treats as a lock row** — justified by the rule above: nothing references `plan_state` by a foreign key (no FK check can queue behind or in front of it) and its key never changes, so the
`FOR NO KEY UPDATE` refinement buys nothing. Because all plan writers serialize there, the node services take no per-row locks; the plan lock is held across the whole block, which makes the delete's child count race-free
and lets the ranking (V13) compare `expectedRevision` atomically. A block that throws rolls the bump back. Reads (`PlanViewService`, `RoadmapService.view`) read the revision first without the lock. `ProjectService.delete` calls
`removeFromRanking`: the project's `roadmap_entries` row is hard-deleted and the positions above renumbered in the same locked transaction.

### The roadmap rank (V13)

`roadmap_entries (project_id INTEGER PRIMARY KEY REFERENCES projects(id), position INTEGER NOT NULL CHECK (position >= 1), CONSTRAINT uq_roadmap_entries_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED)`
(`planning/RoadmapService.kt`; semantics in `planning-model.md` "The global project rank"). One row per RANKED project; no row = unranked. **Positions are dense 1..n**, kept so by the two writers, both inside
`withPlanWrite`: `replaceRanking` (`DELETE` all, then one `insertRows` with positions 1..n in the given order) and `removeFromRanking` (delete the row, then ONE `UPDATE … SET position = position - 1 WHERE position > ?`).
**`DEFERRABLE INITIALLY DEFERRED` is load-bearing**: an immediate unique constraint is checked row by row, so the sweep (and any reorder that swaps two positions in one statement) can collide with a
not-yet-updated neighbour depending on physical row order; deferred, the check runs once at commit, when the table is dense again. The cost is that a genuine duplicate surfaces at COMMIT, not at the statement
(only a bug can produce one: every writer holds the plan lock). `project_id` has no `ON DELETE` rule: projects are only soft-deleted, and the delete hook removes the entry in the same transaction. A hard-delete
table, justified in "Soft delete (convention)".

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
`0 <= x < 1_000_000`, and `BigDecimal(x.toString())` with at most two decimals — `validateEstimate`, `planning/Milestone.kt`) so the stored value is EXACTLY the sent one, never a silent rounding; `MilestoneTest` pins the same values over HTTP.

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

### Planned persistence (not yet built)

The rest of the planning tables (capacity periods, the team milestone order) arrive with v0.5; their sketch is in `planning-model.md`. The schema list, the soft-delete list and the cross-feature list above grow in the same commit as each migration.
