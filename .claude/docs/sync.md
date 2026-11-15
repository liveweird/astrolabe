# Sync

Owns: the connector-agnostic machinery of `sync/`: the run registry and its claim, the runner, the poll scheduler, a connection's derived status, the sync failure codes, the acknowledge vocabulary both connectors share, and how a stored token lives. Not here: what a connector reads and stores (`jira-sync.md`, `flow-sync.md`), the guards of the routes (`authorization.md`), the audit events and the rest of the logging (`observability.md`), the `sync_runs` DDL (`persistence.md`), the stub ports (`ci.md`).

## Rules

The rules that bind every change in this area. The sections below hold the mechanics and the pinning tests.

- `sync/` is the connector-agnostic run registry (`SyncRunService`, V21 `sync_runs`) and its background executor (`SyncRunner`); it names no connector. The request rules both connection registries share (the poll bound, the credential's presence) are `sync/ConnectionRules.kt`. `jira/JiraObserver` is the first connector and `flow/FlowObserver.kt` the second, each registered by its own module (`configureJira`, `configureFlow`) before `configureSync`.
- A run starts from a manual request (claims the run, answers `202`) or from the scheduler; either way it executes on an application-scoped `SupervisorJob` scope.
- The claim IS the unique index: the partial unique index `uq_sync_runs_running` (one unfinished row per kind and connection) is the lock, not the process. There is no leader and no advisory lock, and a run is never cancelled across replicas, only abandoned by age.
- Every way a run ends writes its row or leaves it to the age-based abandonment ("The runner").
- A run never holds a database transaction across an upstream call, never takes the plan lock, and rethrows cancellation untouched (its deadline and the shutdown both arrive that way).
- The schedule and the status are never stored. Both derive from the connection's rows and its newest 50 `sync_runs`, so a restart, a second replica and a manual refresh (it becomes the newest run) agree without coordination; `nextPollAt` is the scheduler's own `decide`, never a second copy of the back-off.
- A run's outcome is deliberately not an audit event: it is the `sync_runs` row and a log line on `ch.nokillswit.sync` (operational, like the telemetry sampler). The one audit event of the sync is the manual request.
- A run's error text is built URL-free by the connector (`{Jira|Flow} fetch failed: {code} ({status})`, never the exception message, which quotes the endpoint); `clampErrorDetail` is only the backstop.
- No log line of the sync carries a URL with a query, a credential or an issue summary; the unexpected-failure ERROR logs the exception CLASS chain and its first frames, never its message (an R2DBC or Exposed message can quote a statement or a stored value).
- A failure code that has been stored is never renamed or removed; a new code is one constant in its object and one value of the spec's `SyncFailureCode`, in one commit ("Failure codes").

## The run registry and the claim

Files: `sync/SyncRunService.kt`, `SyncRun.kt`, `ConnectionRegistry.kt`, `Connector.kt`.

- The registry writes ONLY its own table and reads no other, except the connection row lock a claim takes through the connector. The rows are operational history, pruned at claim time to the newest 50 per (kind, connection) (`MAX_LISTED_RUNS`, one list never answers more).
- **The claim** (`SyncRunService.claim`, every production claim, the manual route and the scheduler alike) is ONE transaction. It locks the connection's row `FOR SHARE` through `Connector.lockActiveInTransaction` (a connection that is unknown or deleted is a `400` and nothing is written); finishes any unfinished run of the (kind, connection) older than `sync.maxRunMinutes` as `ABANDONED`; prunes the finished ones to leave room; INSERTs the unfinished row. A `23505` on `uq_sync_runs_running` is `409 run-in-progress`, and the abandon and the prune roll back with it, harmlessly.
- A claim racing a connection delete either lands before it (the delete hard-deletes the connection's runs) or is refused `400` after it, so no run is left for a connection that is gone (`sync_runs` has no foreign key, nothing else would prune the row).
- **Running** has one rule, `isRunLive`: the row is unfinished and was claimed less than `sync.maxRunMinutes` before the reading's clock. An older unfinished row was interrupted (a crash leaves it unfinished until the next claim abandons it), so no client judges a run's age by its own clock.
- `finish` touches only an unfinished row, so the late finish of an abandoned run is a no-op and can never rewrite what the abandonment recorded. It clamps `error_detail` to 500 characters with every URL replaced by `[url]`, any `?query` dropped and any `Basic|Bearer` value redacted (`clampErrorDetail`).
- **Replicas.** With two replicas BOTH tick and both decide a connection is due; both claim, exactly one INSERT lands and the other gets the `409`, which the scheduler turns into one INFO line "claimed elsewhere". A manual refresh meeting a poll is the same race, and the manual route answers `409 run-in-progress`. A second pod is safe and merely redundant; `k8s/app-deployment.yaml` stays `replicas: 1` with `Recreate`.

## The runner

Files: `sync/SyncRunner.kt`, `RunEnvelope.kt`, `Sync.kt`.

The executor runs claimed runs in the background, after the request that claimed them has answered `202`. Its scope has the shape of `telemetry/Telemetry.kt`: a `SupervisorJob`, so one run's failure never touches another, cancelled on `ApplicationStopping` with a bounded join of 5 s, before the pool is disposed.

**Every way a run ends writes its row or leaves it to the abandonment:**

| The run | The row |
|---|---|
| the connector returns a `SyncResult` | stored as it is; a `FetchException` keeps its code, a connector's typed problem (`RunProblem`) its own ("Failure codes") |
| an unexpected exception | `FAILED` / `INTERNAL`, the exception CLASS only |
| it outlives its deadline | `FAILED` / `RUN_DEADLINE` |
| the scope is cancelled (shutdown) | `FAILED` / `SHUTDOWN`, written inside `NonCancellable` with the cancellation rethrown |
| the process died, or the finish could not be written | the row stays unfinished; the next claim after `sync.maxRunMinutes` finishes it `ABANDONED` |

- The deadline is `sync.maxRunMinutes` - 1 minute, never under 30 s, so a live run never outlives its claim. A run cut by its deadline or a shutdown keeps the calls, rate-limited count and backoff it had published to its `RunMeter`, not zeros.
- The finish is written under a 10 s bound (a stuck database cannot hold the process); a finish that fails or times out leaves the row to the abandonment and says so in the log.
- **The envelope.** Both connectors' runs go through `sync/RunEnvelope.kt` (`runWithTally`): the tally, the counters (`RunProgress`), the typed `RunProblem` and the failure text `"<Jira|Flow> fetch failed: CODE (status)"` (`fetchFailureDetail`) are defined once there.
- What a Jira run and a Flow run read and write: `jira-sync.md` "Observations and the run" (the full and incremental reads, the sweep, the gone probe, the census cadence), `flow-sync.md` "The run".
- **Transport settings.** The five transport settings (`requestTimeoutSeconds`, `requestDeadlineSeconds`, `maxResponseBytes`, `maxConcurrentRequests`, `maxRetries`) are read by `infra/fetch/TransportConfig.kt` `readTransportConfig(config, prefix, bounds)`; each connector keeps its own bounds.

### Log lines

All on the `ch.nokillswit.sync` logger.

- INFO `Sync run {id} ({kind} connection {id}) succeeded: observed=, gone=, calls=, rateLimited=, backoffMs=`.
- WARN `Sync run {id} ({kind} connection {id}) failed: {code} observed=, gone=, calls=` (the code, never the detail).
- WARN `Abandoned {n} unfinished {kind} run(s) of {connection} older than {n} min` (the claim found a crashed run).
- WARN `Sync run {id} was not finished in time; the next claim will abandon it`; WARN `Sync run {id} was already finished (abandoned) or removed (its connection was deleted) when it ended as {outcome}`.
- ERROR `Sync run {id} ({kind} {id}) failed unexpectedly` with the exception class chain and its first frames (an `INTERNAL` run).
- ERROR `Sync run {id} ({kind} {id}) could not be finished: {exception class}` (the finish itself failed; the row stays unfinished), followed by WARN `Sync run {id} stays unfinished; the next claim after the claim's lifetime will abandon it`.

The Jira run:

- INFO `Sync run {id} released {n} binding(s) of deleted plan nodes`.
- WARN `Sync run {id} probe of issue {issueId} failed: {code}`: the per-issue probe of a gone binding (not yet answered for, or a readable one asked again: every Refresh now, a scheduled run a `jira.censusHours` after its last answer) failed with a code that says nothing about the issue. The row keeps what it had, the run still succeeds and a later run probes it again.
  WARN only in the streak's first failing run, for a newly flagged binding, or on a Refresh now, DEBUG otherwise (the damper below), so a rotation through many stuck bindings never spreads WARNs over many runs. The issue id and the code only; each probe counts in `calls=`.
- WARN `Sync run {id} probe stopped after 3 failures in a row: {n} binding(s) left unprobed`: the probe's circuit breaker, once per run (WARN in the streak's first failing run, DEBUG in the later ones, a Refresh now's included). `{n}` counts the rest of this run's queue (newly flagged first, then the retries), not the whole backlog; the rest stay unanswered for the next run, the run still succeeds. Counts only.
- WARN `Sync run {id} (connection {id}) gone probe got no answer in 3 runs in a row ({code}): retried once every {n} h and on Refresh now`, from the gone-probe damper (`GoneProbeDamper`: in memory per connection, a restart starts it over). Once per streak, at the run that is the third in a row to send reads and get no answer;
  from then a scheduled run asks only the newly flagged bindings until `jira.censusHours` after the last retry, and a Refresh now asks everything but, when it gets no answer, neither counts toward the streak nor restarts that clock. The connection id, counts, the last transport code and the interval only.
- INFO `Sync run {id} (connection {id}) gone probe answers again`: the first run after a TRIPPED streak in which Jira answered (a 200, 404 or 403) ends it, a Refresh now that gets an answer too; after one or two failing runs an answer ends the streak silently. The damper is forgotten on a connection edit (a config change) or by a run that finds the connection deleted or with nothing bound; a connection deleted between runs keeps its small record until a restart, bounded and never read again.
- INFO `Sync run {id} census: issues={n} children={n} pruned={n} childPass=FULL|SWEEP|NONE`: the census mirror rows this run wrote at the mapped levels and at the child level, the rows its sweeps pruned, and how the child level was listed. Counts only.
- WARN `Sync run {id} children census truncated at {n} pages after {n} child issue(s) (a listing or response ceiling): roll-ups may be incomplete`: the child listing hit the 200-page or the response ceiling; kept, nothing pruned, stamped. Counts only.
- WARN `Sync run {id} children census failed: {code} (roll-ups may be incomplete, retried by the next run)`: any other typed failure of the children pass; the run still SUCCEEDS, nothing pruned or stamped. The code only.
- WARN `Sync run {id} (connection {id}) census cannot converge after 3 runs in a row: {reason}; roll-ups may be incomplete`: the loop guard (`jira-sync.md` "Coverage and roll-ups"), for a census that healed (cleared `census_at`) or whose children pass failed more than 3 runs in a row. One WARN per streak, re-armed when the streak ends, DEBUG while it repeats; the connection id and a fixed reason only, never an issue key or summary.
- WARN `Sync run {id} sweep listed no issue at all for {n} bound issue(s): {n} flagged gone`: a genuine `issues: []` listing of a non-empty bound set. It still flags, since a false flag heals on the next good sweep and warns only, while failing would wedge a site whose only bound item was really deleted. Counts and no issue data.

The Flow run:

- WARN `Sync run {id} Flow document truncated at 2000 sprints: the mirror keeps what Flow sent`.
- WARN `Sync run {id} Flow document truncated at 1000 teams: the mirror keeps the teams it already had, none is counted gone`. Counts only; both runs still SUCCEED.
- WARN `Capacity acknowledgements of binding {id} kept: not computable ({cause class})`: the prune could not compute one binding's rows (a non-database failure); that binding's acknowledgements are kept and the run goes on. A database failure fails the run instead.
- INFO `Sync run {id} cleared {n} capacity acknowledgement(s) whose row left the list`, when the run's mirror replace pruned any. The count only; the per-binding detail is the audit event `flow.capacity_acknowledgements_cleared`.

## The scheduler

Files: `sync/SyncScheduler.kt`, `SchedulePolicy.kt`.

`SyncScheduler` is ONE coroutine launched on `ApplicationStarted` on the runner's own scope (`SyncRunner.launch`), so `runner.shutdown()` on `ApplicationStopping` ends the loop together with the runs: no second scope, no second hook. The stop joins the runner (bounded at 5 s) before the pool is disposed on `ApplicationStopped`.

- **The interval.** A connection's `pollIntervalMinutes` is 5..1440 (`requirePollInterval`, `sync/ConnectionRules.kt`) or null for manual only (Refresh now still works); an omitted member is 15 for Jira and 60 for Flow.
- **Config.** `sync.scheduler.enabled` (`SYNC_SCHEDULER_ENABLED`, default true, strict boolean; false starts no loop and publishes no `SyncSchedulerKey`) and `sync.tickSeconds` (`SYNC_TICK_SECONDS`, default 60, 15..600, validated on every boot, the scheduler enabled or not). The first tick lands 10 s after start. `sync.maxRunMinutes` (`SYNC_MAX_RUN_MINUTES`, default 10, 1..60, boot-validated) is the claim's lifetime.
- **A tick** runs under half a tick of budget (`withTimeoutOrNull`). Per connector it reads the poll rows (`Connector.connections()`: never a token or the discovery snapshot), the pollable connections' newest 50 runs in one transaction (`SyncRunService.recentRuns`), and decides with the pure `decide` (`sync/SchedulePolicy.kt`), which stores nothing.
- **The due rule.** Never for a disabled, not ready or manual-only (`pollIntervalMinutes` null) connection. Ready is Jira: a discovery; Flow: a passing test (`last_test_ok`) OR a mirrored document (`teams_at`), sticky, so a token or zone `PUT` or a Test that hit an outage never stops a connection that has run.
  While the newest run is unfinished and younger than `sync.maxRunMinutes` it is running (skipped); older, it is a crash and the connection is due (the claim abandons the row). No run at all is due. A change after the newest run started (`changedAt`: Jira's `GREATEST(updated_at, mapping_changed_at, discovered_at)`, Flow's later of `updated_at` and `last_tested_at`) is due at once, so a fixed token is not left waiting out a back-off.
- Otherwise the connection is due when `now` reaches the newest run's finish + `max(interval, min(interval x 2^(n-1), 6 h))` for `n` consecutive trailing failed or abandoned runs (the first retry waits one interval, then doubling, capped at six hours; a success resets; an interval longer than the cap is never shortened), plus, after a failure only, a deterministic per-connection jitter.
- **Jitter after an outage.** After a shared outage every connection fails in the same tick and would retry in the same tick, on the shared outbound permits. The wait therefore grows by `fraction x min(backoff / 2, interval / 2, 1 h)` (`failureJitterMillis`), in practice up to half an interval. The fraction is NOT a random draw but a hash of the connection id and the newest run's id (`failureJitterFraction`, the splitmix64 finalizer):
  the schedule is never stored, so a draw per read would make `nextPollAt` flicker and two replicas disagree. The same two ids always give the same offset, so the scheduler, every replica and the status agree to the millisecond; the next failure (a new run id) draws a new offset. A success is never jittered, and a change to the connection stays "due at once". Not covered: connections that merely come due DURING a database outage (nothing failed, so nothing is spread) all claim on the first tick after it, and the shared permits queue them.
- **Before the claim** the scheduler asks the connector's `requireRunnable` (what the manual route asks) and re-reads the poll row and the runs through the same rule, so a connection deleted, disabled, made manual-only or claimed meanwhile is skipped. The claim (`SCHEDULED`, no requesting user) and `runner.start` then run together in `NonCancellable`, so a claimed row always gets its run and is never left for the abandonment by the tick's budget or a shutdown.
- A run the scheduler starts is an ordinary row of the run list with trigger `SCHEDULED` and no requesting user, and audits nothing; its row is the record. The e2e world's API-seeded connections are manual-only; `jira-polling.spec.ts` owns the one polled connection. `SyncScheduler.lastTickAt` / `lastTickOk` are in-process liveness figures; the telemetry `sync` block reports only whether the scheduler runs and its tick, not these.

Scheduler log lines, on `ch.nokillswit.sync`:

- INFO `Scheduler started run {id} for {kind} connection {id}`.
- INFO `Scheduler: {kind} connection {id} is claimed elsewhere (another instance or a refresh), skipped`.
- INFO `Scheduler: {kind} connection {id} is no longer runnable, skipped`.
- INFO `Scheduler: {kind} connection {id} was deleted before the claim, skipped` (the claim's own row lock found it gone after the last look; nothing was written).
- Per unit of failure (`FailureLog`, shared with the telemetry sampler): WARN `Scheduler {JIRA | JIRA connection {id} | tick} failed: {exception class}` once, DEBUG while it repeats, INFO `... recovered` at the first success.

The failure text is the exception CLASS only (a database error can quote a statement), and the scheduler never sees a credential, so no line can carry one (`SyncSchedulerTest` asserts it with `LogCapture`). A connector that throws fails only its own section, a connection that throws only itself, a tick that outruns its budget is cut and logged `tick`, and none of them stops the next tick.

## Connection status

Files: `sync/SyncStatus.kt`.

A connection's sync state is DERIVED per read from `enabled` and its newest 50 `sync_runs`, never stored (`SyncStatusKernels.derive`, pure). In order:

| Condition | `state` |
|---|---|
| not `enabled` | `DISABLED` |
| the newest FINISHED run `FAILED` or `ABANDONED`, or an INTERRUPTED newest row (unfinished and older than `sync.maxRunMinutes`, not yet abandoned by a claim: a crash on a manual-only connection, which no claim ever cleans up) | `FAILED` |
| no `SUCCEEDED` run | `NEVER_SYNCED` |
| a polling interval and a last success that STARTED more than `3 x interval` ago (strictly) | `STALE` |
| otherwise (a manual-only connection stays `CURRENT` after any success: its staleness is the administrator's choice, `lastSucceededAt` shows it) | `CURRENT` |

- Beside the state: `lastRun` (the newest row, running or not; `running` is `isRunLive`, judged against the reading's own clock), `lastSucceededAt` (the START of the newest success), `consecutiveFailures` (`trailingFailures`, plus one for an interrupted newest row) and `nextPollAt` from the scheduler's own `decide` (`Wait.until`, "now" when due, null for a disabled, untested, manual-only or running connection). `SyncStatusKernelsTest` pins the equality with `decide`.
- **Five readers** share it: the connection registries (`status` on the response and the list), the Deviations view (`connections[].status`), the Flow capacity-deviation view (`connections[].status`), the telemetry `sync` block and the timeline views' Jira fold (`jiraSites[].state`, `DeviationViewService.siteStatesInTransaction`, through the Deviations service's own derive step).
- All but telemetry compute it inside their own transaction: the registries and the capacity-deviation view through `SyncRunService.statusesInTransaction(kind, connections)` (`sync/SyncStatus.kt`, one copy for both connectors), the Deviations view through `recentRunsInTransaction` directly.
- A run in flight on top of a failure does not clear `FAILED`; the failure recovers by the next success, and an edit that makes the connection due at once (a fixed token) lets that happen without waiting out the back-off. `lastRun` carries the machine `errorCode`, never the detail; an interrupted newest row shows `running` false and `finishedAt` null.
- `nextPollAt` of a failed connection is the doubling wait plus its jitter; a connection never tested has none (the web's "Test the connection first" hint reads `discoveredAt == null`).
- `status` is operational and secret-free, the `lastRun` disclosure class (`authorization.md`): no error text, no counters.

## Failure codes

The codes of runs and of test rows are ONE declared list: the spec's `SyncFailureCode` (nullable; 25 values), `$ref`'d by `SyncRun.errorCode`, `SyncLastRun.errorCode`, `JiraTestRow.code` and `FlowTestRow.code`. Four Kotlin objects hold the values and add up to that enum:

| Object | Raised by | Codes |
|---|---|---|
| `infra/fetch/FetchCodes` (12) | the transport and the probes | `AUTHENTICATION_FAILED`, `FORBIDDEN_SCOPE`, `NOT_FOUND`, `REDIRECT`, `INVALID_RESPONSE`, `LIMIT_EXCEEDED`, `BUSY`, `TIMEOUT`, `RATE_LIMITED`, `BLOCKED_HOST`, `UPSTREAM_UNAVAILABLE`, `SKIPPED` |
| `sync/SyncErrorCodes` (7) | the runner and both connectors | `RUN_DEADLINE`, `SHUTDOWN`, `INTERNAL`, `ABANDONED`, `CONNECTION_GONE`, `CONNECTION_DISABLED`, `TOKEN_UNREADABLE` |
| `jira/JiraRunCodes` (5) | the Jira connector | `NOT_DISCOVERED`, `MAPPING_UNREADABLE`, `MAPPING_INVALID`, `PROJECT_NOT_VISIBLE`, `CURSOR_EXPIRED` |
| `flow/FlowRunCodes` (1) | the Flow connector | `TIME_ZONE_INVALID` |

What each means:

| Code | Meaning |
|---|---|
| `AUTHENTICATION_FAILED` | the upstream answered 401 (Jira: a bad or expired token; a scoped token missing a scope also answers 401, so one failing probe while `myself` passes means a missing scope. Flow: its one uniform 401, the token is revoked, expired or wrong) |
| `FORBIDDEN_SCOPE` | the upstream answered 403 |
| `NOT_FOUND` | the upstream answered 404 (Flow: a Flow older than 1.57.0) |
| `REDIRECT` | the upstream answered a 3xx; redirects are never followed |
| `INVALID_RESPONSE` | the answer could not be read, had an unexpected shape or status, or carried a page token the guard refused |
| `LIMIT_EXCEEDED` | a response, an answer or a run passed one of its size or page ceilings; never retried by `SourceHttp` |
| `BUSY` | no outbound slot was free within an interactive request's wait |
| `TIMEOUT` | the call, the probe, its budget or a browse passed its deadline |
| `RATE_LIMITED` | the upstream answered 429, or a `Retry-After` crossed the request's budget |
| `BLOCKED_HOST` | the origin is not allowed (Jira: not a genuine site of the tenant; Flow: no longer on the operator's list of origins) |
| `UPSTREAM_UNAVAILABLE` | the upstream could not be reached or answered 5xx (Flow: an outage) |
| `SKIPPED` | a test row only: the probe did not run because the first probe (`tenant_info` for Jira, `me` for Flow) failed, so `ok` is false with no `status` and no `scopeHint`; read the first failed row |
| `RUN_DEADLINE` | the run was cut at its deadline |
| `SHUTDOWN` | the application stopped while the run was in flight |
| `INTERNAL` | an unexpected exception; `errorDetail` names its class only |
| `ABANDONED` | written by a later claim for a run that never finished (its outcome is `ABANDONED`) |
| `CONNECTION_GONE` / `CONNECTION_DISABLED` | the connection was deleted / disabled before or during the run |
| `TOKEN_UNREADABLE` | the stored token cannot be decrypted; a run, or the `stored_token` test row (enter it again) |
| `NOT_DISCOVERED` | the Jira connection has not been tested yet, so there is no discovery snapshot |
| `MAPPING_UNREADABLE` / `MAPPING_INVALID` | the stored mapping cannot be read by this version / no longer fits the site |
| `PROJECT_NOT_VISIBLE` | a test row only: a configured project key the token cannot see |
| `CURSOR_EXPIRED` | a search page's token expired and the one restart failed the same way |
| `TIME_ZONE_INVALID` | the Flow connection's time zone is not known to this server |

- A run's code is stored in `sync_runs.error_code` (`VARCHAR(40)`), so a value is never renamed or removed. A test row's code is wire-only (a connection stores only whether its last test passed).
- A new code is one constant in its object and one value of `SyncFailureCode`, in one commit. `SyncFailureCodeTest` adds the four objects up against the enum, forbids a code literal at a call site, and serves a stored row of every code through the conformance client.
- The read is tolerant: nothing validates a code on read, an unknown stored code is served as it is, and a client treats an unknown value as unknown (a newer server may write a code an older client's list lacks, and a rolled-back server may serve one a newer version stored).
- Which probe raises which row code: `jira-sync.md` "Test connection and the probes", `flow-sync.md` "Test connection and the probes".

## The acknowledge vocabulary

Files: `sync/Acknowledge.kt`, `sync/Bindings.kt`.

`sync/` names no connector; `jira/` and `flow/` import these.

- ONE `409` problem type for an acknowledge, `urn:astrolabe:problem:stale-deviations` (`STALE_DEVIATIONS_PROBLEM`): the fingerprint the client saw is not the one of the deviation now, or there is nothing to acknowledge. The client re-reads the view and decides again, and the web has ONE `isStaleDeviations` predicate.
- ONE shape rule for the fingerprint a client echoes (`requireFingerprintShape`): 64 lower-case hexadecimal characters, a `400` otherwise, shared by Jira's per-binding acknowledge and Flow's per-sprint capacity acknowledge. The fingerprint itself is `infra/json`'s `fingerprintOf`.
- ONE `409` problem type for a bind that finds its target taken, `urn:astrolabe:problem:already-bound` (`ALREADY_BOUND_PROBLEM`, `Bindings.kt`): Jira's node already carries a binding, or the issue is already bound to another node or through another connection of the site; Flow's Astrolabe team already has a Flow team, or the Flow team is already linked to a live team.
- The run claim's `409` is `urn:astrolabe:problem:run-in-progress` (`RUN_IN_PROGRESS_PROBLEM`).
- What each connector acknowledges and how: `jira-sync.md` "Acknowledge", `flow-sync.md` "Deviations".

## A stored token's life

- A connection's token is encrypted at write (`FieldCipher`, `enc:v1:` envelope), write-only on the wire (`hasApiToken`), masked in every `toString` (`SecretToStringTest`) and absent from audit lines, logs and run rows. A connection delete sets the column to NULL.
- It is decrypted in memory only by the connector's few readers (Jira: `readForTest`, `readForPeek`, `readForBind`, and the run through `readForBind`; Flow: `readForTest` and `readForRun`). The decrypt-or-null rule is ONE function, `infra/crypto/UnreadableToken.kt` (`FieldCipher.decryptOrNull`): an envelope that cannot be opened reads as null, never as an exception, with one WARN naming the connection id and the exception class (`UnreadableTokenTest`).
- An unreadable token is `TOKEN_UNREADABLE` on a run and the `stored_token` row of a test, never a `500`. `docker compose up` and `:server:run` use different keys over one Postgres, so a row may be unreadable.
- At boot `EncryptedAtRest` wraps any legacy plaintext and, with `DATA_ENCRYPTION_KEY_PREVIOUS` set, re-encrypts every row (soft-deleted ones too; NULLs skipped), audited `crypto.reencrypted` (`observability.md`).
- A `PUT` with a token rotates it; a changed token clears the last test verdict (the last test judged the old one); a blank or omitted token keeps the stored one.
- **Jira.** The three readers are `JiraConnectionService.readForTest` (Test connection), `readForPeek` (Peek) and `readForBind` (the bind; the two import routes and the run are further callers of it, not further readers). `JiraTestRecorder` and `JiraMappingStore` (the Test result and the mapping document) never select or see the token. A changed token, email, auth scheme or project-key set clears `last_tested_at/ok`; the site cannot be changed (`409`).
- **Flow.** A changed token or zone clears `last_tested_at/ok`; a connection delete also soft-deletes its bindings and removes its runs, mirror and the bindings' capacity acknowledgements in one transaction.

## Pinned by

`SyncRunServiceTest` (the claim, the abandonment, the prune, the clamp), `SyncClaimDeleteRaceTest` and `SyncClaimDeletedConnectionTest` (a claim against a connection delete), `SyncRunnerTest` (every way a run ends, the shutdown), `SyncRunRoutesTest` (the manual route, the audit event, the token never in a log), `SyncRunBucketTest` (the per-user `sync-run` bucket), `SchedulePolicyTest` (the due table, the jitter bounds and spread), `SyncSchedulerTest` (real registry, fake connector, injected clock, two instances,
throwing connector, tick budget, shutdown, no credential in a line), `SyncBootTest` (the boot config and the scheduler lifecycle), `SyncStatusKernelsTest` (every state, STALE at exactly 3 intervals, manual-only, the streak, `nextPollAt` equal to `decide`), `SyncFailureCodeTest` (the four objects against the enum, no literal), `GoneProbeDamperTest`, `JiraRunTest` and `FlowRunTest` (the runs against the stubs), `JiraConnectionStatusTest` and `FlowConnectionStatusTest` (the status on a connection),
`TelemetryRoutesTest` (the telemetry `sync` block), `UnreadableTokenTest` and `SecretToStringTest` (the token).
