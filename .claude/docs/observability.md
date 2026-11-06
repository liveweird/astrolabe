### Observability

`plugins/OpenTelemetry.kt` installs `KtorServerTelemetry` and obtains the SDK via
`getOpenTelemetry("astrolabe")` from the `core` module. `plugins/Monitoring.kt` separately installs
Dropwizard metrics (dumped to the `metrics` logger by a `Slf4jReporter` every `monitoring.reporterIntervalSeconds`, env
`METRICS_REPORT_INTERVAL_SECONDS`: default **300**, `0` = reporter off with the meters still collected, otherwise 30..3600, anything
else fails startup via `requireConfigInt`; it was a fixed 10 s in Flow, a main source of idle allocation and
log volume, since each dump formats the whole registry into dozens of lines the console logs exporter re-emits; nothing in the repo —
docs, e2e, tests — reads those lines, they are a look-back aid; pinned by `MonitoringReporterConfigTest`; the registry is a `TelemetryRegistry` — timers on a true sliding window of `telemetry.sampleIntervalSeconds`, capped at 300 s (the reservoir keeps ~16 bytes per timer update until it ages out of the window, so the cap bounds the memory cost per request) — published as `MetricRegistryKey`, and Ktor's JVM metric sets are OFF (`registerJvmMetricSets = false`: its thread-states gauge dumped every thread on each reporter run; the telemetry sampler reads the MXBeans itself), see "Telemetry") and the `CallId` plugin using `X-Request-Id`
(client-supplied ids are honored only when ≤64 URL-safe chars — they reach logs and OTel
attributes, so junk is ignored rather than propagated). The SDK is also wired for **logs**: a
Logback `OpenTelemetryAppender` (`server/src/main/resources/logback.xml`, the sole root appender
— re-adding STDOUT would double every line, since the interim `console` logs exporter already
prints to System.out) bridges every SLF4J log into the OTel logs SDK, and
`configureOpenTelemetry` (`plugins/OpenTelemetry.kt`) installs the appender (flushing the
pre-install boot-log buffer) while `getOpenTelemetry` (`core/.../OpenTelemetry.kt`) sets the
interim exporter to `console`. Defaults are set via `addPropertiesSupplier` (the lowest-precedence
config tier) **on purpose**, so the sink can be redirected to a collector by env alone with no
code change — set `OTEL_LOGS_EXPORTER=otlp` + `OTEL_EXPORTER_OTLP_ENDPOINT` (the
`opentelemetry-exporter-otlp` dep is already on the classpath); `OTEL_TRACES_EXPORTER` likewise.
Metrics and traces exporters default to `none` (`otel.metrics.exporter`/`otel.traces.exporter`).
**Shutdown ordering (the SDK closes LAST).** JVM shutdown hooks run concurrently and unordered. The
OpenTelemetry autoconfigure SDK registers its own hook (flush + close the logs pipeline) and Ktor's
`start(wait = true)` registers another (it fires `ApplicationStopping`, where a component may audit a final event); with both live, the SDK often closed first and every audit line
emitted during Ktor's stop was silently dropped (the DB release still happened — only the log line
vanished). So `getOpenTelemetry` (`core`) calls `disableShutdownHook()` and `configureOpenTelemetry`
registers `TelemetryShutdown`'s hook instead: it waits (bounded, 20 s) for `ApplicationStopped` — the end of
Ktor's stop — and only then closes the SDK. Ktor raises an event's handlers in subscription order, so the
latch handler is subscribed from inside the `ApplicationStarted` handler (after every module has subscribed its
own `ApplicationStopped` work — the pool dispose) and therefore runs last. The 20 s sits
in a budget: Ktor grace + timeout ≈ 11 s by default, and 20 s + the SDK's ≤10 s `close()`
is exactly the Kubernetes default `terminationGracePeriodSeconds` (30 s), so `k8s/app-deployment.yaml` sets 45 s
(`JvmMemoryFlagsTest` asserts it is at least `STOP_WAIT_SECONDS` + 10 s + 15 s; compose's `app` sets `stop_grace_period: 45s` against the same bound, its 10 s default would SIGKILL mid-flush) — raising Ktor's shutdown timeout or
lowering the pod's grace must revisit `STOP_WAIT_SECONDS`; if the application never finished starting (a boot failure)
there is no Ktor stop to wait for and it flushes at once, so the failure's own lines still export. Anything
that must log during a stop belongs in an `ApplicationStopping`/`ApplicationStopped` handler, never in its
own JVM hook (it would race the SDK again). Pinned by `ShutdownAuditTest`: a forked child JVM (a real Netty
server + the real `configureOpenTelemetry`) gets `kill -TERM` and its stdout must hold the line its
`ApplicationStopping` handler audited (not `Process.destroy()`, which closes the child's pipes first).

**Convention for non-fatal "this should never happen" events:** emit a WARN with the
`SHOULD_NEVER_HAPPEN` marker (`MarkerFactory.getMarker`) plus key/value attributes — they flow
through the appender to OTel. Reserve it for branches that are genuinely unreachable by ordinary
requests (no current usage — Lettuce's history shows how easily an "unreachable" branch turns out
to be a routine denial path).

**Database connection guards (WARN logs, no audit event; `persistence.md` "Connection pool").** Logger
`ch.nokillswit.infra.db.LeakedSocketGuard`: `closed the socket of a broken database connection the driver had left open (backend pid
<pid>; its transaction rolls back)` each time the guard disposes a socket r2dbc-postgresql gave up on without closing (the r2dbc-postgresql
1.1.3 driver bug; it follows the driver's own `Connection Error` ERROR, e.g. "Response queue is full"); `leaked-socket guard disabled:
r2dbc-postgresql internals not found` once at boot (pool setup), if a driver upgrade renamed the internals it reads. A pooled session
the server ends under `idle_in_transaction_session_timeout` surfaces in Astrolabe only as a generic connection-closed error on its next
statement (in its own request or job); the `FATAL 25P03` naming the idle timeout is in the PostgreSQL log alone.

**Audit trail.** Security-relevant events are structured INFO logs on the dedicated
`ch.nokillswit.audit` logger with the `AUDIT` marker, emitted via `audit("area.event", "key" to value, …)`
(`audit/Audit.kt`) — they ride the same Logback→OTel pipeline, so shipping them to a
collector/SIEM is env-only. Fields travel as SLF4J key/values, not in the message text (assert
with `hasKeyValue` from `TestEnvironment.kt`). Emitted today:

- `login.success` / `login.failure` (with `reason`: unknown_email/wrong_password) /
  `login.lockout` (the throttle tripping) / `login.rejected_locked` (an attempt against a locked
  account) / `login.capacity_rejected` (an unseen identity cannot be admitted into the full
  throttle); login audits use `email` for ordinary identities and a fixed-size `emailDigest` for
  oversized submissions,
- `login.mfa_challenge` (email/userId/`evicted` — correct credentials, second factor pending; `evicted` = this account's older challenges displaced, a count) /
  `login.mfa_success` / `login.mfa_failure` (with `reason`:
  unknown_challenge/expired/wrong_code/too_many_attempts/user_gone/credential_changed) /
  `login.mfa_unavailable` (MFA enabled on a mail-less deployment → 503) /
  `login.mfa_capacity_rejected` (the pending challenge store is full → 429, no code sent) /
  `login.mfa_send_failed` (email/errorType),
- `logout`,
- `password_reset.requested` (email) / `password_reset.unknown_email` (email) / `password_reset.throttled` (email) /
  `password_reset.capacity_rejected` (email - new identity at the full cooldown store, no async task started) /
  `password_reset.link_sent` (userId/email) / `password_reset.capped` (userId - the account already holds the maximum of 5
  unexpired links: nothing minted, nothing sent, the request still answered 202) / `password_reset.stale_account` (userId - the
  account changed between the async task's lookup and the grant insert: nothing minted, nothing sent) / `password_reset.send_failed` (email/errorType - the link never left; its grant is
  revoked) / `password_reset.rejected` (no fields - a confirm against an invalid, expired, used or stale grant, uniform) /
  `password_reset.completed` (userId - the confirm) / `password_reset.notification_failed` (userId/errorType - the post-reset
  notice; the reset stands) - the self-service reset trail, none of it carrying a token or a password; the async task's events
  double as test barriers,
- `refresh.rejected` (with `reason`: invalid_or_expired/wrong_token_type/revoked/malformed/
  user_gone/credential_changed/replayed — `replayed` is a rotated refresh token presented again after the replay grace,
  `revoked` a logout-revoked one or a rotation this instance no longer remembers),
- `access.rejected` (with `reason`: user_gone/revoked/credential_changed/roles_changed/malformed, `userId` - the
  token's claim, null when absent OR out of range - and `suppressed`; `plugins/Security.kt`) - the per-request access check (`TokenBlocklistService.accessVerdict`)
  refused an otherwise valid signed access token: the account was deleted, the token was logged out, the password was
  changed, the role was changed, or the token lacks a claim the check needs (a pre-deploy token). **Coalesced** like `rate_limit.exceeded` (its own `RateLimitAuditThrottle`): at most ONE event per user and reason per 60 s, `suppressed`
  counting the rejections folded into it since the previous one (0 on the first), so a stale token replayed on every request writes a line a minute;
  the keys are bounded by the accounts that ever held a signed token. Junk, expired, wrong-audience/`typ` and jti-less tokens never reach the check and emit nothing. Never the token,
- `refresh.replay_grace` (userId — a rotated refresh token presented again inside the grace
  (`security.refresh.replayGraceSeconds`) and answered with a fresh pair, at most twice per token; a lost response or a racing tab, or a replay),
- `password.changed` (targetUserId/byUserId/selfChange) / `password.change_denied` (wrong or
  missing current password; per attempt, bounded by the lock itself: at most `security.lockout.threshold` per window per account),
  `password.change_locked` (targetUserId — the self change's lock tripped, once per lock),
  `password.change_rejected_locked` (targetUserId/`suppressed` — an attempt answered 429 while locked; coalesced to one per account per
  60 s, `suppressed` = rejections folded in since the previous), `password.change_capacity_rejected` (targetUserId — the
  throttle store is full and the account untracked; 429),
- `user.features_changed` (byUserId/targetUserId/featuresFrom/featuresTo — only on an actual
  change),
- `user.permissions_changed` (byUserId/targetUserId/permissionsFrom/permissionsTo — comma-joined sorted `Permission` names, "" = none; only on an
  actual change, so an idempotent same-set re-PUT emits nothing; a permission is a rights path — `ROADMAP_EDITOR` ranks the projects and sets target
  windows — so it is its own trail line, the `user.features_changed` precedent; `PUT /users/{id}/permissions`, `users/UserRoutes.kt`),
- `user.language_changed` (the per-user language — byUserId/targetUserId + `from`/`to` codes;
  emitted only on an actual change; `user.created` additionally carries `language` when
  non-default),
- `user.created` (byUserId/newUserId/email/roles — roles as STORED, i.e. the folded
  additional-roles set) / `user.updated` (name/email deltas, only when changed) /
  `user.roles_changed` (rolesFrom/rolesTo, both as stored) / `user.deleted`
  (byUserId/targetUserId) — the user events (`/api/v1/users`),
- `person.created` (byUserId/personId/name/userId, nullable) / `person.updated` (byUserId/personId/name) / `person.link_changed`
  (byUserId/personId/userFrom/userTo, nullable user ids as STORED — only when a PUT actually changes the login link; a login link is a
  rights path, so it is its own trail line, the `team.manager_changed` precedent; it also transfers every team-manager grant — and, from V12, the ownership — the person holds to the new login) / `person.deleted` (byUserId/personId) — every
  person mutation; a rejected save emits nothing,
- `team.created` (byUserId/teamId/name/managerPersonId, nullable) / `team.updated`
  (byUserId/teamId/name) / `team.manager_changed` (byUserId/teamId/managerFrom/managerTo, nullable PERSON ids as STORED —
  only when a PUT actually changes the manager; a manager assignment grants the team-scoped planning rights, so it is its own
  trail line, the `user.roles_changed` precedent) / `team.deleted` (byUserId/teamId/capacityPeriodCount — the ACTIVE capacity periods the delete cascaded, 0 for none) — every team mutation; a rejected save
  emits nothing,
- `team.capacity_period_created` (byUserId/teamId/periodId/effectiveFrom — ISO date/mdPerWeek — the Double as validated/wipLimit — the integer, `none` when the period has no limit; `POST /teams/{id}/capacity`) /
  `team.capacity_period_updated` (byUserId/teamId/periodId/effectiveFromFrom/effectiveFromTo/mdPerWeekFrom/mdPerWeekTo/wipLimitFrom/wipLimitTo — the values as STORED before and as written, `none` = no limit; only on an actual change: a same-values PUT is a 204 and emits nothing, and a PUT without
  `wipLimit` that clears one audits `wipLimitTo=none`; `PUT /capacity-periods/{id}`) / `team.capacity_period_deleted` (byUserId/teamId/periodId; `DELETE /capacity-periods/{id}`) — every capacity mutation (`teams/TeamCapacityRoutes.kt`, the team manager's or ADMIN's write); a rejected one
  (403/404/409/400) emits nothing of its own (a 403 is the central `authz.denied`),
- `team.milestone_order_changed` (byUserId/teamId/revisionFrom/revisionTo/orderFrom/orderTo — the plan revisions around the write and the team's LISTED milestone ids before and after as comma-joined text, "" = none listed, i.e. the default order; on EVERY accepted `PUT /teams/{id}/milestone-order`, a no-op list and a reset (`[]`) included, since each bumps the
  plan revision and the team's order revision; the server cannot tell a menu move from a drag, both are the same PUT; a stale 409 or a 400 emits nothing, a 403 is the central `authz.denied`; `planning/TeamOrderRoutes.kt`). The removals that keep the positions dense (a milestone's team change or delete, its project's delete) are audited by `milestone.updated`/`milestone.team_changed`/`milestone.deleted`/`project.deleted` only,
- `team.schedule_batch_applied` (byUserId/teamId/revisionTo/acceptedCount/skippedCount/acceptedIds/skippedIds — the plan revision the batch left behind, the counts, and the ids as ASCENDING comma-joined text, "" = none; ONE per accepted `POST /teams/{id}/milestone-schedules`, an all-skipped batch included since it bumps the revision like any plan write) — plus `milestone.scheduled` per ACCEPTED item whose dates actually changed, with the single PUT's fields verbatim (byUserId/milestoneId/teamId/startFrom/endFrom/startTo/endTo/revisionTo, `revisionTo` the batch's one revision), so the trail reads the same whether a bar moved by drag or by batch; an item equal to its stored span audits no `milestone.scheduled`. A 400/404/409 (the `stale-revision` and the `stale-scope` refusals alike) emits nothing of its own, a 403 is the central `authz.denied` (`planning/TeamScheduleRoutes.kt`),
- **No event: `POST /teams/{id}/schedule-proposal`** (v0.8.0 C2, `planning/TeamScheduleRoutes.kt`) is a computation - nothing is created, written or stored, no lock is taken and the plan revision does not move - so, like the view GETs, a proposal emits no audit event on success (`ScheduleProposalTest` pins it); a 403 is the central `authz.denied`, a 400/404 emits nothing. The audited step is the accept (`team.schedule_batch_applied` above),
- `work_stream.created` (byUserId/workStreamId/name/ownerPersonId) / `work_stream.updated` (byUserId/workStreamId/name) / `work_stream.owner_changed`
  (byUserId/workStreamId/ownerFrom/ownerTo — person ids as STORED, only when a PUT actually changes the owner: the new owner gains the whole subtree, so it is its own trail line) /
  `work_stream.closed` (…/endDate) / `work_stream.reopened` (…/endFrom) (an end date appearing / disappearing on a PUT) / `work_stream.deleted` (byUserId/workStreamId),
- `program.created` (byUserId/programId/workStreamId/name/ownerPersonId) / `program.updated` (byUserId/programId/name) / `program.owner_changed` (byUserId/programId/ownerFrom/ownerTo) /
  `program.moved` (byUserId/programId/workStreamFrom/workStreamTo — the work stream ids as STORED under the plan lock; `POST /programs/{id}/move`; a move to the current work stream emits nothing) / `program.deleted` (byUserId/programId),
- `project.created` (byUserId/projectId/programId/name/ownerPersonId) / `project.updated` (byUserId/projectId/name) / `project.owner_changed` (byUserId/projectId/ownerFrom/ownerTo) /
  `project.target_window_changed` (byUserId/projectId/startFrom/endFrom/startTo/endTo — ISO dates as STORED, null = no window; only when the window actually changes; `PUT /projects/{id}/target-window`) /
  `project.moved` (byUserId/projectId/programFrom/programTo — the program ids as STORED under the plan lock; `POST /projects/{id}/move`; a move to the current program is a no-op and emits nothing) /
  `project.deleted` (byUserId/projectId/milestoneCount/dependencyCount/dependencyIds/successorProjectIds — the number of ACTIVE milestones and of ACTIVE dependencies (either end, the project's own and its milestones') the delete cascaded, 0 for none; `dependencyIds` the cascaded link ids and `successorProjectIds` the distinct projects of those links' successors — the plans that lost a constraint, the deleted project included when it was a successor — both ascending and comma-joined, "" = none) — every plan-node mutation (`planning/*Routes.kt`); a rejected save (403/404/409/400) emits nothing of its own (a 403 is the central `authz.denied`),
- `milestone.created` (byUserId/milestoneId/projectId/name/teamId/estimateMd — the estimate as the Double the client sent) / `milestone.updated` (byUserId/milestoneId/name/estimateMd) / `milestone.team_changed` (byUserId/milestoneId/teamFrom/teamTo — team ids as
  STORED, only when a PUT actually changes the team: it changes WHO may schedule the milestone and where the bar sits in the team view, so it is its own trail line, the `team.manager_changed` precedent; the dates stay) /
  `milestone.scheduled` (byUserId/milestoneId/teamId/startFrom/endFrom/startTo/endTo/revisionTo — ISO dates as STORED, null = unscheduled; only when the dates actually change — a no-op PUT still bumps the plan revision but emits nothing;
  `PUT /milestones/{id}/schedule`, the manager's/ADMIN's write, `teamId` the stored team the guard checked, `revisionTo` the plan revision it left behind) / `milestone.deleted` (byUserId/milestoneId/projectId/dependencyCount/dependencyIds/successorProjectIds — the ACTIVE dependencies at either end the delete cascaded, 0 for none, their ids and the distinct projects of their successors, ascending and comma-joined, "" = none) — every milestone
  mutation (`planning/MilestoneRoutes.kt`, the create in `ProjectRoutes.kt`); a rejected one (403/404/409/400, a stale 409 included) emits nothing of its own (a 403 is the central `authz.denied`). A project delete's cascade is
  audited as `project.deleted` (with `milestoneCount` and `dependencyCount`) only; `GET /views/project/{id}` (like the other view GETs, `GET /views/team/{id}`, `GET /views/roadmap` and `GET /views/programs` included) is a read and emits no event,
- `dependency.created` (byUserId/dependencyId/projectId — the SUCCESSOR's project, the path project/predKind/predId/succKind/succId — `MILESTONE` or `PROJECT` and the id/type — FS, SS, FF or SF/lagDays — working days, negative = a lead; `POST /projects/{id}/dependencies`) /
  `dependency.updated` (byUserId/dependencyId/predKind/predId/succKind/succId — the ends as STORED under the plan lock/typeFrom/typeTo/lagFrom/lagTo — the type and lag before and after; `PUT /dependencies/{id}`; emitted ONLY when the type or lag actually changes — a no-op PUT bumps the plan revision but writes no row and emits nothing, like `milestone.scheduled`) /
  `dependency.deleted` (byUserId/dependencyId/predKind/predId/succKind/succId — the ends as STORED under the plan lock; `DELETE /dependencies/{id}`) — every dependency mutation (`planning/ProjectRoutes.kt`, `DependencyRoutes.kt`); a rejected one (403/404/409 duplicate or cycle/400)
  emits nothing of its own (a 403 is the central `authz.denied`); the cascade of a milestone or project delete is audited by `milestone.deleted` / `project.deleted` (their `dependencyCount`, `dependencyIds` and `successorProjectIds`) only — the cascade emits no `dependency.deleted` per link,
- `roadmap.ranked` (byUserId/revisionFrom/revisionTo/orderFrom/orderTo — the revisions are the PLAN revision around the write, and `revisionTo` is also the ranking's new revision (V18); the ranked project ids before and after as comma-joined text, "" = empty; on EVERY accepted `PUT /roadmap/ranking`, even one that keeps the
  order, since it bumps the plan revision, and the revision pair ties the line to the plan history; a stale 409 or a 400 emits nothing, a 403 is the central `authz.denied`; `planning/RoadmapRoutes.kt`). A project
  delete that compacts the rank is audited as `project.deleted` only,
- `public_holiday.created` (byUserId/holidayId/date/name/revisionTo — the ISO date and the trimmed name as stored, `revisionTo` the plan revision the write left behind; `POST /public-holidays`) / `public_holiday.deleted` (byUserId/holidayId/date/name/revisionTo — the removed row as STORED; `DELETE /public-holidays/{id}`) /
  `public_holiday.preset_applied` (byUserId/preset/year/addedCount/addedDates/revisionTo — `addedDates` the comma-joined ISO dates, "" with `addedCount` 0 when the year was already present: the write still bumps the plan revision, the conservative rule; `POST /public-holidays/apply-preset`) — every holiday mutation
  (`planning/PublicHolidayRoutes.kt`, ADMIN only); a rejected one (403/404/409/400) emits nothing of its own (a 403 is the central `authz.denied`). Each is a plan write, so `revisionTo` ties the line to the plan history (`planning-model.md` "The calendar (V19)"),
- `baseline.created` (byUserId/baselineId/name/revisionTo/milestoneCount/projectCount — `revisionTo` the plan revision the create left behind, which the baseline equals, and the counts the rows it froze; `POST /baselines`) / `baseline.updated` (byUserId/baselineId/nameFrom/nameTo/descriptionChanged/revisionTo; `PUT /baselines/{id}`, emitted ONLY when the name or description actually changes — a no-op PUT still bumps the plan revision but emits nothing, like `milestone.scheduled`) / `baseline.deleted` (byUserId/baselineId/name/revisionTo — the name as STORED; `DELETE /baselines/{id}`, the soft delete) — every baseline mutation (`planning/BaselineRoutes.kt`, ADMIN or `ROADMAP_EDITOR`); each is a plan write, so `revisionTo` ties the line to the plan history. A rejected one (400/404/409 name or cap) emits nothing of its own (a 403 is the central `authz.denied`); the reads (`GET /baselines`, `GET /baselines/{id}`, the views' `?baseline=` overlays and `GET /views/baseline/{id}`) emit none - a `400` `unknown-baseline` or a `404` is an answer, not a security event,
- `bootstrap.admin_password_rotated` (userId/email — the fixed seed-admin email, never the password or
  its hash; `infra/db/Bootstrap.kt`, only when `ADMIN_INITIAL_PASSWORD` actually replaced the seed
  hash, so an idempotent re-boot emits nothing) — the boot-time credential event, so an admin-password reset leaves a trail beyond a log line
  (`crypto.reencrypted`, below, is the other boot-time event),
- `jira.connection_created` (byUserId/connectionId/name/host — the connection's name and the site's HOST only, e.g. `sample.atlassian.net`; never the token, the account email or the project keys; `POST /integrations/jira/connections`) / `jira.connection_updated` (byUserId/connectionId/name/host/`tokenRotated` — a boolean, `true` only when the PUT carried a token; the token is never a field; `PUT …/{id}`, emitted on every accepted PUT) / `jira.connection_deleted` (byUserId/connectionId/name/host — the row as STORED; `DELETE …/{id}`, the soft delete) — every connection mutation (`jira/JiraConnectionRoutes.kt`, ADMIN only); a rejected one (400/404/409 name or site) emits nothing of its own (a 403 is the central `authz.denied`), and the reads emit none. `JiraConnectionTest` also asserts that no audit line and no log line of the whole interaction contains the token,
- `crypto.reencrypted` (rows/label/rotating — the boot-time encryption-at-rest backfill, `infra/db/Bootstrap.kt`: `rows` the rows wrapped or, with `rotating` true, re-encrypted under the current key, `label` the owning service's noun (`Jira API token`); emitted only when a pass touched rows, so an idempotent re-boot emits nothing; counts and a noun, never a value; `security.md` "Encryption at rest"),
- `authz.denied` (every 403, from the `ForbiddenException` handler in `plugins/ErrorHandling.kt`,
  with method/path/byUserId/detail — `path` is the request path only, never the query string),
- `rate_limit.exceeded` (bucket/method/path/suppressed, plus `byUserId` on the per-USER `telemetry` bucket — a token bucket (`plugins/RateLimits.kt`: per-IP login, refresh,
  password-reset, password-reset-confirm, mfa, ready; per-user telemetry) rejected the request with a 429, emitted from the 429 status handler in
  `plugins/ErrorHandling.kt`; `bucket` is stamped by the bucket's own `requestKey`. **Coalesced**
  (`RateLimitAuditThrottle`): at most ONE event per bucket per 60 s, `suppressed` counting the rejections folded into it
  since the previous event (0 on the first), so an unauthenticated flood writes a line a minute per bucket instead of one
  per request; keyed by bucket only (per-IP buckets), so memory is bounded whoever floods. The per-USER `telemetry` bucket is keyed by
  `telemetry:<userId>` instead and carries `byUserId` -- the server-minted claim of a verified token, never client text; only a signed-in
  account reaches that key, so the key space is the account count. The client address is deliberately NOT a field
  (it is `X-Forwarded-For`-derived behind a proxy, i.e. attacker-chosen text; the ingress log has it), and neither is the
  query string. The per-account lockout's 429s are their own `login.lockout`/`login.rejected_locked` events and do not
  emit this),
- `outbound.blocked` (scheme/host ONLY — never the full URL) — a rejection by `infra/outbound/OutboundGuard.kt`'s host
  allow-list or address-range check ONLY, emitted by `GuardedDns` on a guarded client's every outbound call (no consumer in v0.1.0; `security.md` "Outbound HTTP calls"). A DNS failure (the resolver throwing, or an empty answer, for an allow-listed host) is
  not a rejection and emits no audit event: `GuardedDns` logs a WARN per attempt, `DNS resolution failed for allow-listed outbound host
  <host>` (logger `ch.nokillswit.outbound`, host only) and the call is retried like any other IO failure.

Field-naming convention: the acting caller is `byUserId` everywhere except the auth lifecycle
events (`login.*`, `logout`, `refresh.rejected`, `access.rejected`, `password_reset.*`), where `userId` identifies the account being
authenticated.

Never log secrets (passwords, tokens); emails/ids are fine. When adding a security-relevant
mutation or denial path, emit an `audit(...)` event alongside it and extend this list in the same
change (Toadie's one sanctioned exception was a per-user view-state PUT written on every drag —
pure view state may stay unaudited, with a documented justification) — the catalog grows with every planning mutation
(work stream, program, project, milestone, schedule, dependency, rank, capacity: each gets its `area.event` names here in the commit that adds the route). Tested in
`AuditTest` via a Logback `ListAppender` on the audit logger (the shared `LogCapture` helper in
`TestEnvironment.kt`).

**Health probes** (`plugins/Health.kt`): `GET /api/v1/health` answers `{status: ok}` whenever the
process serves requests (the image's `HEALTHCHECK`, the compose healthcheck and the k8s liveness
probe); `GET /api/v1/ready` additionally round-trips the database (one `SELECT` on `users`, 3 s
budget) and answers a `503` problem while it fails (the k8s readiness probe and the e2e global
setup wait on it). Both are public and unaudited — they are called every few seconds and disclose
nothing. `/ready` alone rides a per-IP bucket (`ready`, 60/min, security.md; the kubelet needs 12/min), so an over-limit caller gets a `429` (the generic `rate_limit.exceeded` audit, bucket `ready`); `/health` does no I/O and is unbucketed. Tests: `HealthTest` (the `ReadinessProbeKey` seam swaps the database probe for a failing
one).

### Telemetry

`telemetry/` (the `ops` schema, `persistence.md` "Telemetry (V9)") is how Astrolabe measures itself: **the process samples itself into
Postgres, and the ADMIN read API ("Read API" below) and the panel read the rows.** Astrolabe is ONE process (no worker; the process `role` is the constant `app`), but the
design is multi-process-safe (two replicas, a rolling deploy) and kept that way on purpose. `configureTelemetry` runs after the database and monitoring seams (`application.yaml`); `telemetry.enabled` (env
`TELEMETRY_ENABLED`, default true) switches the sampler off, the suite sets it false (`TestEnvironment.configureApp`). The
`telemetry.*` block is validated on every boot, enabled or not: `sampleIntervalSeconds` 60..1800 and a divisor of 3600 (default 300; it is the stored raw `resolution`; validated by
`plugins/Monitoring.kt`, which needs it for the timers' window) and `storageIntervalSeconds` 900..86400 (3600), the cadence of the storage collector below; env `TELEMETRY_*` (README).

- **Per process, every tick** (`TelemetrySampler`, a `SupervisorJob` scope on `Dispatchers.IO`; the first tick 5 s after
  `ApplicationStarted`, then aligned to the interval; cancelled on `ApplicationStopping`, before the pool is disposed): `JvmProbe` —
  heap used/committed, the old generation's peak since the previous tick (`MemoryPoolMXBean` peak, reset after each read), non-heap, direct
  buffers, process CPU as a fraction of the available processors (CPU-time delta over wall delta), `ThreadMXBean.threadCount` (never a
  thread dump), GC count and time per collector as deltas; `CgroupProbe` — `/proc/self/status` `VmRSS`, and the memory of the process's OWN cgroup (from `/proc/self/cgroup`, joined under
  the mount root, falling back to the root itself; v2 `memory.current`, `memory.stat` `anon` and `inactive_file`, `memory.peak` — a LIFETIME peak, unlike the per-interval `mem.old_gen_peak` — `memory.max`; v1 fallback; "working set" =
  current − inactive_file, the figure the kubelet evicts on); the connection pool (`PoolStatsKey`: acquired, idle, pending, allocated); and `LatencyCollector` (below). A missing
  file (macOS, no memory controller, an old kernel without `memory.peak`) is a null figure and no row, never an error. The metric
  registry (names ≤ 48 chars, kind GAUGE|DELTA|PERCENTILE, unit, group) is `TelemetryMetrics.kt` — a new metric needs no migration.
- **Cluster section, one process per interval.** After its own samples a tick tries `pg_try_advisory_xact_lock(TELEMETRY_LOCK_KEY)`
  (`persistence.md`); the holder runs the cluster collectors in ONE transaction, each in a savepoint (a
  failing collector is undone alone and the rest still run), and commits their readings with a `telemetry.cluster_ms` marker row. A process that
  loses the try-lock, or finds the marker already at this interval's bucket, skips — so two replicas do the work
  once. The cluster collectors (`ClusterCollector`; per-process ones are `ProcessCollector`): **retention** (the hourly rollup, below, and the prune); the storage collector is the heavy one.
- **Requests (`LatencyCollector.kt`, `LatencyCollectorTest`).** Every tick it reads Ktor's Dropwizard TIMERS and status METERS from the registry (`MetricRegistryKey`;
  never its gauges) and writes, per normalised route (label `/api/v1/users/{id}`) and for `*` (every `/api/` route except `/api/v1/telemetry` and the `/api/v1/health` / `/api/v1/ready` probes),
  `http.count` (delta of the timer count against the value kept in memory; the first tick counts since process start), `http.p50`/`http.p95` (ms; the windowed snapshots of the
  timers that saw a request, merged into one set of observations per label, so `*` is a real percentile) and `http.5xx`/`http.429` (deltas of the per-status meters). A label has
  rows only in an interval it saw something (a 5xx/429 row only when non-zero). Series names are `ktor.calls.<route>.timer|meter|<status>` with `<route>` the whole selector chain
  (`/(authenticate "default")/api/v1/users/{id}/(method:GET)`); `normaliseRoute` strips every parenthesised selector (pinned by a test against the
  names Ktor 3.6 writes). Only ROUTED series are read: a `.<status>` meter counts when its route also has a `.timer` (the timer is stopped in the same hook that marks the
  status meter; the all-status `.meter` is marked earlier, when the routed call starts, and is not used), and a name containing `?` (Ktor's fallback name for a
  response it did not route: the URI, query included) is ignored. **Ktor marks a response each time the response pipeline runs**, and `ErrorHandling`'s `status(429)`
  handler answers the RateLimit plugin's bodiless 429 a second time: on a route with wrapping selectors that second mark lands under the URI-named fallback (ignored), on
  a bare route it lands twice in the `429` meter, so the surplus of a route's status meters over its timer delta is taken off its 429 count (a thrown exception is
  counted once; a 5xx needs no correction). `previous` keeps only the names seen in the latest tick.
- **Heavy collector: storage (cluster, outside the lock transaction).** The cluster transaction does only the cheap work
  (retention) and DECIDES whether the heavy collector is due (its marker, `telemetry.storage_ms`, is at least its interval older than the
  current bucket); a due one is CLAIMED by a marker row of value 0 committed with the cheap readings, so a heavy run is attempted at most once per interval whatever its
  outcome (a failure is not retried before the next interval, a rollback of the light phase claims nothing). After that commit the heavy phase runs under
  its own budget (`TelemetryConfig.heavyBudgetMillis` = 2/5 of the interval, so light + heavy fit in an interval), every statement in a SHORT transaction of its own
  (`HeavyReader`; `queryTimeout` 30 s, at most 3/4 of the heavy budget - 18 s at a 60 s interval), the readings inserted in one more transaction, and the marker set to the run's
  duration in milliseconds (at least 1; a marker still at 0 is a claim that did not complete). A failure is one WARN per collector then "recovered"; the heavy phase
  overrunning its budget is the collector `heavy`. No lock or long transaction spans the scans, so a deploy's `ALTER` is never queued behind them.
  **Storage** (every `storageIntervalSeconds`): `db.size` (`pg_database_size`) and `db.schema.size` per `public`/`ops` (and every schema a later migration adds): the sum of
  `pg_total_relation_size` (heap + TOAST + indexes) over relations of kind r/m. Catalog reads only. `StorageReadingsTest`.

- **Resolution and retention.** A raw sample (`resolution` = the sample interval in seconds, so any value below 3600) is `(ts = the interval bucket, process, metric, label, n = 1, avg = max =
  value)`, written with `ON CONFLICT DO NOTHING` (a repeated tick in a bucket adds nothing). Once an hour ended at least `max(10 minutes, interval / 2)` ago, the
  next cluster section folds every complete hour after the newest hourly row into hourly rows (`resolution` 3600: `n` = sum of the samples,
  `avg` = their n-weighted mean, `max` = the largest max, so a 5-minute peak survives; for a DELTA metric `avg * n` is the hour's total) — one idempotent
  `INSERT … SELECT … GROUP BY … ON CONFLICT DO NOTHING`. Raw rows are deleted after 7 days, hourly rows after 90, and a process unseen for 90 days
  with its samples (`ON DELETE CASCADE`). The prune runs only after a rollup that INSERTED rows (about once an hour); a rollup that fails throws before it, so raw rows are never pruned while the rollup keeps failing.
- **Failure isolation (it must never be the reason something else is slow or down).** Every collector runs in `catchingFailures` and is
  independent of the others; the whole tick runs under `withTimeoutOrNull(interval / 2)`; every statement under the transaction's
  `queryTimeout` (a quarter of the interval, 15..60 s; the only way a statement timeout may be set). Per collector, the FIRST failure is one WARN
  (`Telemetry collector <name> failed: <exception toString>`, no stack), repeats are DEBUG, and the first success afterwards one INFO
  `Telemetry collector <name> recovered` (logger `ch.nokillswit.telemetry.TelemetrySampler`; the tick budget is the collector `tick`). It touches neither
  `/ready` nor any other probe, and no audit event: it records no user action. Pinned by `TelemetrySamplerTest`.
- **Never recorded:** JVM arguments, environment variables, system properties, request paths with identifiers, any project data. A process
  row holds the role, the instance (`HOSTNAME`, else the resolver's host name, ≤ 100 chars), the JVM start, the build version and commit
  (the image's `ASTROLABE_BUILD_VERSION`/`ASTROLABE_BUILD_COMMIT`, stamped with `--build-arg`; null outside the image), the available processors,
  the heap maximum and the container memory limit. The `ops` tables hold only numbers and these labels.
- **Seams** (lower layers publish, `telemetry/` reads; nothing imports it — `PackageBoundaryTest`): `plugins/Monitoring.kt`'s `MetricRegistryKey`
  and `infra/db/Database.kt`'s `PoolStatsKey` (pinned present for r2dbc-pool 1.0.2 by `PoolStatsTest`); the test seams are
  `TelemetryOverridesKey` (clock, probes, identity, first-tick delay) and `TelemetrySamplerKey` (the running sampler).
- **Read API (ADMIN; `TelemetryRoutes.kt`, `TelemetryReads.kt`, `TelemetryCurrent.kt`, `TelemetryHistory.kt`, `TelemetryWire.kt`; `authorization.md`).** Two GETs, registered with the feature
  routes, every statement under a 5 s `queryTimeout`. `GET /api/v1/telemetry/current` answers `{generatedAt, sampleIntervalSeconds, processes[], storage, requests}`:
  `processes` = every process seen in the last 24 h that is live, every stale one seen within the last hour (a wedged replica, a just-replaced pod), plus per role the newest older stale one when none is alive (`stale` = no tick, or no sample, for more than 3 sample intervals: `last_seen` or the newest sample's bucket that old, or no sample at all for a process older than that), each with the figures of ITS newest raw
  bucket (a figure that bucket did not write is null, never carried over): the `memory` block (heap used/committed/max, old-gen peak, non-heap, direct, rss, cgroup current/anon/working set/peak,
  `containerLimitBytes`, `percentOfLimit` = working set / limit in percent, one decimal, null without a limit) and the `jvm` block (cpu ratio, threads, GC count/time summed over collectors, the four pool figures);
  `storage` = the newest `db.size` / `db.schema.size` measurement; `requests` = the newest bucket of the live processes (counts and errors add up, p50 weighted by the requests of the processes that wrote one, p95 the largest): the `*` total and the 15 busiest routes; `windowSeconds` is the counts' window (the sample interval), `percentileWindowSeconds` the p50/p95 window (the interval capped at 300 s, the timers' reservoir). `GET /api/v1/telemetry/history?group=memory|storage|requests|jvm&range=24h|7d|90d`
  (both required, a `400` otherwise) answers `{group, range, bucketSeconds, from, to, historyFrom, truncated, series[{key, metric, label, role, connectionId, unit, kind, points[{t, avg, max}]}]}`.
  Buckets: 24h = the sample interval (widened to a whole multiple of it only if 24 h would exceed 400 points, i.e. an interval under 216 s), 7d = 3600 s (hourly rows PLUS the raw rows after the newest hourly row, so the
  current hours are never missing and nothing is counted twice), 90d = 21600 s (hourly rows grouped to six hours in SQL). Per-process groups (memory, jvm, requests) merge the processes of one `role` into one series
  (`key` = `<role>:<metric>[:<label>]`) so a trend survives a restart; `requests` series merge ALL serving roles per route (`key` = `<metric>:<route>`, `role` null); storage is cluster-wide (`role` null). A GAUGE/PERCENTILE point is the n-weighted mean and the largest sample; a DELTA point's `avg` is the bucket's
  TOTAL and `max` the largest single interval. `requests` keeps `*` (all five metrics) and the ten busiest routes of the range (count, p50, p95 only: the series cap).
  At most 400 points per series and 40 series (`truncated` when more matched, in registry then label order). `historyFrom` = the oldest instant the range can hold, clipped to the range: the first process start. Both reads ride the per-user `telemetry` bucket (30/min, security.md). Pinned by `TelemetryRoutesTest` (clock pinned through `TelemetryOverridesKey`).
- **Registry bound:** the `TelemetryRegistry` never registers a `ktor.calls.` name containing `?` and registers at most 2,000 `ktor.calls.` names (security.md "Telemetry"); the Slf4jReporter filters `?` names.
- **Tests:** `CgroupProbeTest`, `JvmProbeTest`, `TelemetryConfigTest`, `TelemetryStoreTest` (insert, rollup, prune boundaries, cascade, the lock),
  `LatencyCollectorTest`, `StorageReadingsTest`, `TelemetrySamplerTest`, `TelemetryRoutesTest` (the read API), `PoolStatsTest`, `TelemetryRegistryTest` (the sliding window, no JVM gauge sets).

### Not yet ported

Flow's sync-job and data-source audit events (`data_source.*`, `sync_job.*`, `outbound.blocked` from the Jira/GitLab clients, `metrics_*`, `team.jira_membership_*`,
`team.capacity_*`, `team.work_category_targets_updated`) were dropped with their features; if the Jira/Flow deviation sync is built it re-ports the
job-lifecycle pattern (a per-stream progress counter is an operational signal, NOT an audit event). New planning events are added above in the commit that adds the route.
