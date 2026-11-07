### The Jira sync (v1.2.0)

Read before touching `jira/`, `sync/`, `infra/fetch/` or the Jira pages. **What it is:** Astrolabe reads Jira Cloud and compares it with the plan; **nothing is ever written to Jira**
and corrections are made in Astrolabe. 1.1.0 is the connection, the mapping, 1:1 bindings, a manual Refresh and the Deviations page; 1.2.0 adds the import (preview, then apply); 1.3 (in progress) adds polling and acknowledge, and the connection stores its `pollIntervalMinutes` (V22: default 15, 5..1440, `null` = manual only), which the in-process scheduler reads ("Polling (1.3)" below). **It is proven against the built-in Jira stub and
not yet tested against a real Jira site** (the walk-through below is the first real test). Not yet: the status, acknowledge and the timeline markers (1.3), coverage (1.4), Flow (1.5).
Related: schema `persistence.md` "The Jira sync tables (V21)"; outbound guard `security.md` "Outbound HTTP calls"; audit events and the run log lines `observability.md`; per-route guards
`authorization.md`; the web pages `web/CLAUDE.md` "Jira connections" and "Deviations"; the stub's dataset `sample-data/jira/README.md`.

## Who may do what

| Call | Guard |
|---|---|
| `…/integrations/jira/connections` (CRUD), `…/connections/test`, `…/{id}/test`, `…/{id}/discovery`, `…/{id}/mapping`, `…/{id}/peek` | ADMIN, `requireAdmin` BEFORE the body (guard-before-read) |
| `POST /integrations/sync/runs {kind, connectionId}` (Refresh now) | ADMIN; `202` with the unfinished run |
| `POST /integrations/jira/bindings`, `DELETE …/bindings/{id}` | the node's owner chain or ADMIN (`requireOwnerOrAdmin`), read-before-guard; a link writes no dates, so the team-manager rule does not apply |
| `POST`/`DELETE …/bindings/{id}/acknowledge` (1.3) | the node's owner chain or ADMIN, like the bind; the binding's live chain read first (404), the guard again under the binding's row lock; no rate bucket (`## Acknowledge (1.3)`) |
| `POST …/connections/{id}/import-preview` (1.2) | ADMIN, or an owner of every target (`requireOwnerOrAdmin` on the named defaults before the browse, on the resolved targets after it); read-before-guard, a read |
| `POST …/connections/{id}/import` (1.2) | ADMIN, or an owner of EVERY ticked CREATE/BIND row's target, re-run under the plan lock; not the preview's rule (an owner may apply rows on their own targets where a full preview would be a 403); the one Jira write that moves the plan (`### The apply`) |
| `GET …/bindings`, `GET …/sync/runs`, `GET /views/deviations` | any authenticated user |

Rate buckets: `jira-test` 10/min per IP (Test connection, ad hoc or stored, and Peek); `jira-bind` 30/min per user (spent before the guard, so a 403 costs a token too); `jira-import` 5/min per user, shared by the import preview and apply (each browses the whole scope; spent before the guard).

## The transport and the gateway

- Every authenticated call goes to `https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`; only the unauthenticated `GET https://<site>/_edge/tenant_info` goes to the site, and it supplies
  the `cloudId`, validated as a UUID before it is stored or spliced into a path (`HttpJiraClient.resolveCloudId`). A stored site URL can therefore never redirect authenticated traffic
  elsewhere. A site URL that no longer has the genuine tenant shape is refused (`BLOCKED_HOST`) before any client exists.
- `authScheme` per connection: `BASIC` (`base64(email:token)`) or `BEARER`. Which one a given site and token need is NOT verified (see the ledger).
- A scoped token missing a scope answers **401, not 403** (Flow's finding); the probe rows carry the scope hint for that reason.
- One guarded `HttpClient(OkHttp)` for the whole app (`configureJira`), the allow-list being the general tenant-host shape (`infra/outbound/AtlassianSites.kt`), never a stored site. Config
  (`jira.*`, each boot-validated, env `JIRA_*`): `requestTimeoutSeconds` 30 (5..120), `requestDeadlineSeconds` **180** (10..600), `bindPermitWaitMillis` 5000 (100..60000),
  `maxResponseBytes` 4 MiB, `maxConcurrentRequests` 2 (1..8, the permit pool), `maxRetries` 4 (0..8), `pageSize` 100 (1..500), `incrementalOverlapMinutes` 10 (0..1440); `sync.maxRunMinutes` 10 (1..60).
- The transport (`infra/fetch/`, Flow's): retry with jittered backoff on 429/5xx/IO errors, `Retry-After` clamped, a per-tenant pause, `X-RateLimit-NearLimit` = a 1 s sleep, a response byte cap and
  node ceiling (`LIMIT_EXCEEDED`), a page ceiling. Failure codes: `AUTHENTICATION_FAILED FORBIDDEN_SCOPE NOT_FOUND RATE_LIMITED UPSTREAM_UNAVAILABLE TIMEOUT INVALID_RESPONSE LIMIT_EXCEEDED
  BLOCKED_HOST REDIRECT CURSOR_EXPIRED BUSY`. `SourceHttp.kt` is at the 400-line cap: the next edit splits it.
- `search/jql` returns only `id` unless `fields` is named; the run names every field it reads. Timestamps are `yyyy-MM-dd'T'HH:mm:ss.SSS+0000` (`JiraTime`).
- **Development only:** `jira.stubBaseUrl` (`JIRA_STUB_BASE_URL`) reroutes BOTH hosts to the stub; a non-blank value outside development mode refuses boot naming the key.

## Test connection and the probes

`JiraConnector.testConnection` runs the probes in sequence (10 s each, 30 s in all, never throwing; every outcome is a row, **never a 502**). All rows are required; a result passes when every row
is ok. In this order: `tenant_info` (unauthenticated), `myself` (`read:jira-user`), `issuetype` (`read:issue-type:jira`; supplies the type ids the search narrows by), `search`
(`GET /search/jql`, `maxResults=1`, `fields=id`, the JQL = the connection's scope AND `issuetype in (<ids at the mapped milestone level, else Epic level 1, else level 0>)`;
`read:jql:jira`), `field` (`read:field:jira`), `projects` (`GET /project/search?keys=…` with exactly the configured keys; `read:project:jira`), one `project:<KEY>` per key (a key the token cannot
see is a failed row, code `PROJECT_NOT_VISIBLE`), and `issue` (`GET /issue/{id}` on the first id the search returned; `read:issue-details:jira`; **no row at all** when the search returned nothing).
Other typed row codes: `TOKEN_UNREADABLE` (the stored token cannot be decrypted: a wrong or rotated `DATA_ENCRYPTION_KEY`; one `stored_token` row, nothing called), `BLOCKED_HOST`, `TIMEOUT`,
`INVALID_RESPONSE` (a malformed body or an `IllegalArgumentException`).

**When `tenant_info` fails the later rows read `NOT_FOUND`**: there is no gateway to call, so `myself`, `issuetype`, `search`, `field` and `projects` each fail with `NOT_FOUND`
(and no `project:<KEY>` or `issue` rows appear). On a host that is simply down that reads as many separate not-found failures; read the FIRST failed row only (backlog: show them as skipped).

`POST …/connections/test` is ad hoc (carries the token, stores nothing); `POST …/{id}/test` uses the stored token, records `last_tested_at/ok`, `cloud_id` and **the discovery whenever both `field`
and `issuetype` answered, even if another probe failed (D3)** so a failing first test still leaves the report that diagnoses it. A result is recorded only if the row was not edited meanwhile
(`recorded`). Audited `jira.connection_tested` (host, ok, failed probe names, never the token).

## Discovery

`GET …/{id}/discovery` answers the stored snapshot (`409 jira-not-discovered` before the first recorded test): `fieldCount`/`issueTypeCount` as the site reported them, the usable fields (types
`date`, `datetime`, `number`, plus the recognised customs `atlassian-team`, `gh-epic-link`, `jpo-custom-field-parent`; capped at 2,000, markers kept first, `fieldsTruncated` says when it bit),
the issue types (cap 500), `levels[{level, typeNames}]` (non-sub-task types by Jira `hierarchyLevel`) and the **markers** the report prints (a null is an amber "not found" line): `targetStart`/`targetEnd`
(a **date** field named "Target start"/"Target end", else a field whose `schema.custom` contains `jpo-custom-field-baseline-start`/`-end`), `startDate` ("Start date", a date), `dueDate` (`duedate`),
`storyPoints` (the first `number` field whose name contains "story point"), `team` (`schema.custom` contains `atlassian-team`), `legacyEpicLink`, `legacyParentLink`.

## Mapping

One canonical JSONB document per connection (`jira_connections.mapping`): `levels.{program,project,milestone}` = `{hierarchyLevel, fields{start, end, estimate}}` (program and project optional, milestone
required), `estimate{unit POINTS|HOURS|DAYS, manDaysPerUnit|null}`, `teamFieldId`. `PUT …/{id}/mapping` (204) checks the shape before any database read (levels ≥ 0 and strictly decreasing program > project >
milestone, field ids of the Jira shape, factor `0 < x ≤ 1000` with two decimals), then under the row lock against the discovery: every named level has a non-sub-task type, start/end are `date` fields
(a `datetime` is refused: the date depends on a time zone), the estimate is a `number`, the Team field is the site's `atlassian-team` one; `409 jira-not-discovered` with no discovery. `jira.mapping_changed`
audits the before/after SHA-256 on every accepted PUT; a PUT that changes the document sets `mapping_changed_at` (the next run reads in full). `GET` answers `{stored, defaults, effective, discoveredAt, problems[]}`;
`problems[]` lists what a LATER discovery outgrew in a stored mapping (nothing is ever rewritten).

**Defaults** (pure `JiraMappingDefaults.resolve(discovery)`, used until a mapping is saved): milestone = Jira level 1 (Epic) if the site has a non-sub-task type there, else level 0; project = level 2 and
program = level 3 when present; start = "Target start", else "Start date"; end = "Target end", else `duedate` (only `date` fields qualify); estimate = the story-points field **on the milestone only**,
unit `POINTS`, no factor (nothing assumes points convert; the figure is shown beside the plan's, never compared); `teamFieldId` = the `atlassian-team` field.
The bind and the run share one resolution (`resolveEffectiveMapping`): stored-or-defaults, re-validated against the CURRENT discovery; a stale one is `409 jira-mapping-invalid` on a bind/Peek and a `FAILED`
run with `MAPPING_INVALID`; an undecodable document is `MAPPING_UNREADABLE`.

**Peek** (`GET …/{id}/peek?key=ABC-12`, `jira-test` bucket): one `GET /issue/{key}` for the mapped and system fields, answered as `{issue, resolved{level, start, end, estimate, unit, teamName}, raw}` where `raw`
holds only the mapped fields' values. Nothing stored, no audit; the key must be in the connection's project keys; an upstream failure is a `502 jira-upstream` carrying only the code.

## Bindings (1:1)

A binding links ONE plan node (program, project or milestone) to ONE Jira issue (by its numeric id; the key is stored for display and survives a rename). The database holds both directions
(`uq_jira_bindings_node_active`, `uq_jira_bindings_issue_active`); the service makes the checks exact with one **global transaction advisory lock `BIND_LOCK_KEY`** taken first (binds are human clicks).
`POST /integrations/jira/bindings {connectionId, level, nodeId, issueKey}` → `201`, in this order:

1. the body decodes; the node's chain is read (missing = `404`); `requireOwnerOrAdmin` (`403`); then validation (`400`).
2. **One Jira call, outside any transaction** (`observeForBind`): the connection must be active and enabled (`400`), its token readable (`409 jira-token-unreadable`), discovered (`409 jira-not-discovered`),
   its effective mapping valid (`409 jira-mapping-invalid`); the level must be mapped and the key's project in scope (`400`); the issue must exist (`400 "Unknown Jira issue"`) and sit at the hierarchy level
   the mapping gives that plan level (`400` naming both). The call queues for an outbound permit at most `jira.bindPermitWaitMillis`, then answers **`502` with code `BUSY`**, so a burst of binds never holds
   an administrator's Test connection behind it; any other `FetchException` is `502 jira-upstream (CODE)`.
3. The transaction: the advisory lock; the connection row `FOR SHARE` (a delete/edit waits, or has won and this is `400`); the scope re-checked; the node row `FOR SHARE` (`404` if it was deleted); the chain
   re-read and the guard re-run; the node's own active binding → `409 already-bound` ("Project X is already linked to ABC-9"); the issue's active bindings on this connection **or on another active
   connection of the same site (D1)** → `409 already-bound`, unless their node (or an ancestor) is deleted, in which case it is **released** (soft-deleted, audited `jira.binding_released reason=NODE_GONE`).
   Then the binding and its first `jira_observations` row (from the fetched issue) are inserted. No plan lock, no revision bump (a binding is not plan state). Audit `jira.binding_created` after the commit.

`DELETE …/bindings/{id}` soft-deletes (history stays) after the guard on the chain as last stored (a binding whose node is gone is unbound by whoever passes the guard on that chain); `jira.binding_deleted`.
Deleting a connection soft-deletes its bindings in the same transaction (**D2**) and hard-deletes its runs. A program-level binding can only be made on a connection's page (ADMIN), the plan having no program page.

## Observations and the run

`jira_observations` holds the LATEST observed state of a binding (a hard overwrite, one row per binding): summary, type, hierarchy level, status and status category (`new|indeterminate|done` →
`TODO|IN_PROGRESS|DONE`, anything else `UNKNOWN`), parent id/key, start, end, estimate and unit, team name, `gone`. `JiraObservation.of` is pure and clamps every value to its column (a figure
that cannot fit `NUMERIC(12,2)` reads as null) so one odd issue cannot fail a chunk and wedge every later run.

**Refresh now** → `POST /integrations/sync/runs`: `requireRunnable` (the connection is active and enabled, else `400`), `SyncRunService.claim` (abandon any unfinished run of the connection older than
`sync.maxRunMinutes`, prune the finished ones to 50, INSERT the unfinished row; a `23505` on **`uq_sync_runs_running`** is `409 run-in-progress`: the claim IS the unique index, so replicas cannot double-run),
audit `jira.sync_requested`, `202`, and the run executes on the application's background scope (`SyncRunner`). The page polls `GET /integrations/sync/runs?kind=JIRA&connectionId=` (≤ 50, newest first).
Outcomes are `SUCCEEDED|FAILED|ABANDONED`; a run's own deadline is `maxRunMinutes − 1` (never under 30 s) → `FAILED/RUN_DEADLINE`, so a live run is never abandoned under itself.
In order (`JiraObserver.execute`):

1. Read the connection: gone → `CONNECTION_GONE`, disabled → `CONNECTION_DISABLED`. Release bindings whose node (or an ancestor) was deleted (`jira.binding_released`).
2. Token readable (`TOKEN_UNREADABLE`), discovery present (`NOT_DISCOVERED`), mapping usable (`MAPPING_UNREADABLE|MAPPING_INVALID`; also `MAPPING_INVALID` when a mapped level has no usable type id). Take the
   connection's active bindings; **none → the run succeeds having called nothing.**
3. `tenant_info` (persisting `cloud_id` when none is stored), then the read. **Full** (`project in (…) AND issuetype in (<every mapped level's type ids>) ORDER BY id ASC`) when no earlier run
   succeeded, a binding has no observation, or anything that decides what an unchanged issue reads as is newer than the last succeeded run's start (`discovered_at`, `mapping_changed_at`, the connection's
   `updated_at`); otherwise **incremental** (`project in (…) AND updated >= "-Nm" ORDER BY updated ASC`, N = minutes since that start + `incrementalOverlapMinutes`, recomputed from the clock at every
   first-page request, not type-filtered). Every bound issue found is upserted in chunks of 100, one short transaction each, never a transaction across an HTTP call and never the plan lock.
4. The **sweep**: `…issuetype in (…) ORDER BY id ASC` with `fields=id`: a bound id missing from it, and not just read, whose last observed type is among the swept types, is `gone` (`OUT_OF_SCOPE`: a
   deletion, a move out of the keys and a lost permission look the same here); a flagged id seen again is cleared.

Rules inside the read: at most 200 pages **per read** (the read and the sweep each get 200) else `LIMIT_EXCEEDED`; an incremental hitting `LIMIT_EXCEEDED` restarts once as the full read; `CURSOR_EXPIRED`
restarts the query once from its first page, a second expiry fails the run; a `200` that is not a listing (no `issues`, or `isLast: false` with no token) is `INVALID_RESPONSE`, never an empty page; a cycling
`nextPageToken` is refused. **Before every search page the run asks `runnableState`**: a connection deleted or disabled meanwhile ends the run `FAILED` with `CONNECTION_GONE` / `CONNECTION_DISABLED`
(a deleted connection's token is destroyed, so a copy in memory must not authenticate one more read). A run cut by its deadline or a shutdown (`SHUTDOWN`) keeps the counts it had.
**The empty-sweep default:** a genuinely empty listing of a non-empty bound set still flags the bound issues of a swept type that this run did not just read `gone` (a WARN log with counts), because a false flag only warns and heals on the next good sweep,
while failing would wedge a site whose only bound item was really deleted.

## Deviations

`GET /views/deviations` (one `READ ONLY REPEATABLE READ` snapshot, the plan revision first, unpaged, ≤ 2,000 items, `totals` before the cap) applies the pure `JiraDeviationKernels.deviations` to each
binding. Dates compare in WORKING days on the plan's holiday calendar (a start snaps to the next working day, an end to the previous one); a derived span (project, program) is compared, not stored dates.
A `gone` issue raises `GONE` alone. Default: OPEN bindings (deviating and not currently acknowledged, 1.3), warnings first; `all`, `projectId` or `teamId` also list clean and acknowledged ones. A **disabled** connection's bindings stay in the view with their last
observation (they still block their nodes).

| Kind | Levels | Rule | Severity |
|---|---|---|---|
| `GONE` | all | the observation is `gone` | WARNING |
| `LEVEL_MISMATCH` | all | the observed hierarchy level (or none) ≠ the mapping's level | WARNING |
| `PARENT_MISMATCH` | project, milestone | the observed parent issue is bound to a node that is NOT the plan parent (an unbound parent raises nothing) | WARNING |
| `RENAMED` | all | summary ≠ name (trimmed, case-insensitive; a name cut at 100 compares as a prefix) | INFO |
| `START_DIFFERS`, `END_DIFFERS` | all | both dated and the working-day shift ≠ 0 (`days` positive = the plan is later) | WARNING when the plan's END is later than Jira's, else INFO |
| `TARGET_DIFFERS` | project | the target window vs Jira's dates differs in working days | INFO |
| `UNSCHEDULED_IN_PLAN`, `UNSCHEDULED_IN_JIRA` | milestone | Jira dated and the milestone not, or the reverse | INFO |
| `ESTIMATE_DIFFERS` | milestone | comparable (`DAYS`, or a factor) and `|jira × factor − estimateMd| ≥ 0.01` | INFO |
| `ESTIMATE_NOT_COMPARABLE` | milestone | an estimate with no factor, or one read under a different unit than the mapping names now (listed only with `all=true` or `kind=`) | INFO |
| `PROGRESS_MISMATCH` | all | `DONE` while the plan's end is after today; `TODO` while the plan's start is past; `IN_PROGRESS` while it is ahead | INFO |

Without a usable mapping (no discovery, stale, unreadable) neither the level nor the estimate comparison is made and the connection reads `mappingOk: false`.

## Import (1.2): the preview and the apply

`POST …/connections/{id}/import-preview {workStreamId, ownerPersonId, projectKeys?, defaults{programId?, projectId?, teamId?}?, copyDates}` answers what importing the connection's scope into ONE picked work
stream WOULD do, per Jira item: CREATE a program / project / milestone, BIND an existing unbound same-name node, or SKIP. It stores nothing and takes no lock. Work streams are never imported; the
import PICKS one, and an item is created only under it. Checks in order (`authorization.md` has the guards): the `jira-import` bucket, the connection (`404`), the body, the named targets (`404`, then
`403`), the shape (`400`: `projectKeys` a subset, the owner an active person, `defaults.teamId` an active team, the defaults under the stream), the connection enabled (`400`) and its token /
discovery / mapping (`409`, the bind's resolution), then:

1. **One browse, outside any transaction** (`jira/JiraImportBrowse.kt`): `JiraJql.full(keys, sweepTypeIds)` (the run's typed full read) with the run's `fields` (the system fields and every mapped date,
   estimate and Team id), paged by the shared `searchPages` (`jira.pageSize`, at most 200 pages, `CURSOR_EXPIRED` restarted once). It **stops paging at 2,000 issues** (`MAX_IMPORT_ITEMS`): the first
   issue beyond it ends the read with `truncated: true` (a full page exactly at the cap costs one more page to find out); what is kept is the lowest ids. Each issue is read through the mapping at ITS OWN
   plan level, and keeps the issue type of its direct Jira parent (`fields.parent.fields.issuetype`; its level through the discovery by type id when the object omits `hierarchyLevel`, which the stub
   does for ids divisible by 3). **Before every page the connection's liveness is asked** (`runnableState`): deleted meanwhile = `404`, disabled meanwhile = `400`, never a `500`.
   The token is only the client's `Authorization` header: never a URL, log line, exception text or response. The whole browse has a **170 s deadline** (`withTimeoutOrNull`, under the web client's
   180 s abort): past it the answer is `502 jira-upstream (TIMEOUT)`; only the browse's own deadline is turned into that, a cancelled caller stays cancelled.
2. **One snapshot** (`JiraImportService.read`, `READ ONLY REPEATABLE READ`, the plan revision first): the holiday calendar, the picked stream's active tree with each node's owner and whether it carries an
   active binding, ALL active program names (program names are globally unique), the active bindings of the browsed issues AND of their Jira parents on every active connection of the same site (D1: a
   holder is `live` when its node and every ancestor are active), the active teams and the teams the caller manages (ADMIN: every team).
3. **The pure kernel** (`JiraImportKernels.plan`, shared with the apply): rows top-down; a child's parent is the node bound to its direct Jira parent (under the stream), else the batch row of that parent,
   else the level's default parent, else `NO_PARENT`; a child of a skipped parent in the browse is `PARENT_SKIPPED`; names compare case-insensitively (BIND to an unbound same-name sibling, `NAME_TAKEN`
   otherwise; program names against every active program); team by folded name, then `defaults.teamId`, else `NO_TEAM`; estimates convert only with a declared unit or factor (`ESTIMATE_NOT_CONVERTED`);
   a milestone's dates are copied only where the caller may schedule its team (`DATES_NOT_COPIED`) and are valid (`DATES_INVALID`, `NO_WORKING_DAY`).
4. **The resolved targets' guards**, then the redaction for a non-admin (a skipped row other than `ALREADY_BOUND` loses its summary, name and infos, and `unmatchedTeams` counts the created rows only: `authorization.md`), then `200`: `{connectionId, workStreamId, revision, asOf, totals{items, create, bind, skip, truncated}, unmatchedTeams[], items[]}`, unpaged, at most 2,000 rows.
   `truncated` is only reported here; the apply refuses a truncated scope.

Tests: `JiraImportPreviewTest` (the `IMP` tree against the stub), `JiraImportPreviewGuardsTest` and `JiraImportRedactionTest` (the resolved-target guards and the redaction), `JiraImportPreviewSnapshotTest`
(D1 holders: another connection, a deleted one, a dead node, an unbrowsed parent), `JiraImportPreviewErrorsTest` (the order, every status, the cap, the mid-browse stop, the `fields` the request names),
`JiraImportBrowseTest` (the browse over a scripted site, the deadline), `JiraImportKernelsTest`.

**What a user must know about the preview** (the planner's rules, pinned by `JiraImportKernelsTest`):

- **Linking is by name.** An unlinked plan sibling with the same name (compared with `lowercase` only: accents count; the Jira summary is first cleaned by `importName` - control characters become spaces, inner whitespace is collapsed, it is trimmed and cut at 100 characters - while a plan name is not, so a plan name with a double space never matches) is proposed as a BIND; anything else is a CREATE. So **an item renamed in Jira, and not yet linked, does not match its plan
  item and previews as a NEW one**: importing it would add a second node. The user must read the preview (an already linked item is `ALREADY_BOUND` whatever it is called now). Matching renamed items is a backlog item.
- **Only the direct Jira parent counts** (`fields.parent` holds the immediate parent and nothing further, and the browse reads only the mapped levels' types). An item whose direct parent sits on a level the mapping skips (an epic under an unmapped
  initiative under a mapped program) has no parent at its own plan level: it goes under the default parent for its level, else it is skipped `NO_PARENT`. Browsing the unmapped levels too is a backlog item.
- **A non-admin sees less.** A skipped row other than `ALREADY_BOUND` shows no summary, its issue key as its name and no infos, and the unmatched Jira team names come from the rows that would be created only (`JiraImportRedaction.kt`); the web table renders the key.
- **Scope and time.** At most 2,000 items (more is `truncated`: the preview lists the lowest ids, the modal disables Import and the apply is a `400`); the browse has a 170 s deadline and the web client aborts a call at 180 s; `jira-import` allows 5 calls a minute per user, preview and apply together.
- **Who sees the button.** "Import from Jira…" is on the connection page, which is ADMIN's. The API lets an owner of every target import (tested), but no page offers it to an owner yet.

### The apply

`POST …/connections/{id}/import {workStreamId, ownerPersonId, projectKeys?, defaults?, copyDates, items[1..2,000 of {jiraId, expected{action, level, parentJiraId?, nodeId?}, overrides{teamId?}?}]}` writes what the user ticked in the
preview: it creates programs, projects and milestones under the ONE picked work stream, binds each to its Jira item (or binds an existing unbound same-name node), and never updates an existing node. The only Jira write that
moves the plan; nothing is written to Jira. Same rights as the preview (`authorization.md` has the apply's order). It runs the preview's checks and its browse again (the SAME `JiraJql.full` read, matched by id: a static stub cannot answer
`id in (...)`), then:

1. **A truncated browse is a `400`** before any write (a parent cut by the cap cannot be told from an orphan), so is any `overrides.teamId` that is not an active team.
2. **ONE `withPlanWrite`** (`JiraImportService.apply`, `LockedApply.run`; the lock order is in `persistence.md`): plan lock, then the bind's advisory lock, the connection row, the caller's person, and everything re-read and
   re-guarded under them. The kernel runs over the rows read under the lock with the client's ticks: a ticked row that is no longer exactly what the preview showed (`expected`: action, level, Jira parent, BIND node, and for a CREATE the previewed LANDING `parent{kind, nodeId?}` - a row is never silently re-homed, e.g. under the default parent because its Jira parent was bound elsewhere; for a milestone also the previewed `teamId`, before any override - a Jira Team edited meanwhile cannot move it to another team unseen; an `overrides.teamId` applies on top and is not compared) is skipped `CHANGED` (a BIND target that was bound meanwhile is `NAME_TAKEN`, one that was deleted turns the row into a CREATE: `CHANGED`),
   an item the re-browse no longer finds is `CHANGED` without a key, a child of a row the client left out or whose own row was skipped is `PARENT_SKIPPED`, and a name taken meanwhile is `NAME_TAKEN` - decided in Kotlin under the lock,
   never by catching a `23505`. A caller who may not schedule a milestone's team (decided with `lockedIsActiveManager` under the lock) gets it created unscheduled.
3. **Inserts top-down** (a child's parent id is the one just returned), the dates for the scheduled milestones through `writeSchedules` at `revision + 1` (the milestone was inserted at the same value), then a binding and its first
   observation per written row through `insertBoundLocked`; a dead-node holder of the issue (this connection or another of the site, D1) is released. **Exactly one revision bump**, also when every item was skipped (a re-import answers
   `skipped[] = ALREADY_BOUND` and still moves the revision by one).
4. After the commit: `jira.binding_released` per released holder, then ONE `jira.import_applied` line (`observability.md`). The answer is `{revision, created[{jiraId, issueKey, kind, id, bindingId, name, scheduled}], bound[…], skipped[{jiraId,
   issueKey?, reason}]}`: ids, keys and reasons only.

The plan lock is held about 1 s for the plan's whole scale (20 / 100 / 1,000) and about 2 s at the 2,000-item cap (`build-times.md`); the browse, at most 170 s, happens before it. Under the lock the connection's project keys, `mapping_changed_at` AND `discovered_at` are compared with what the browse used (the effective mapping depends on both): keys `400`, mapping or discovery `409`. The dead holders to release are locked in one `ORDER BY id FOR NO KEY UPDATE` before the first bind (the run's sweep updates in id order). Tests: `JiraImportApplyTest` (the `IMP` tree, bindings and
observations, the revision, the audit line, the schedule PUT's stamp, a re-import, owners and scheduling, BIND and `NAME_TAKEN`), `JiraImportApplyChangesTest` (`CHANGED`, `PARENT_SKIPPED`, a released holder), `JiraImportApplyGuardsTest` (the landing, the team override, a re-import by a node owner), `JiraImportApplyRecheckTest` (every check repeated under the lock), `JiraImportApplyErrorsTest`
(every status), `JiraImportApplyRaceTest` (revocation while waiting, a plan write ahead, a connection deleted meanwhile, the bind race), `JiraImportScaleTest` (the measured hold).

## Polling (1.3)

An in-process scheduler (`sync/SyncScheduler.kt`, `observability.md` "Sync runs") claims a run per connection every `pollIntervalMinutes` (5..1440; **omitted = 15, an explicit `null` = manual only**, "Refresh now" still works). It starts nothing the manual route would refuse and reads no secret: its only Jira-side read is `JiraConnectionService.pollRows()` (`jira/JiraConnectionPolling.kt`, seven columns of the ACTIVE rows: id, name, enabled, interval, `discovered_at`, `mapping_changed_at`, `updated_at` - never the token, never the discovery), and the run it starts is the ordinary `JiraObserver.run`, which decrypts the token through `readForBind` exactly as a manual run does.

- **Who is polled:** enabled, tested (a stored discovery: an untested connection could only fail `NOT_DISCOVERED` and back off, so it is never polled) and with an interval. A disabled connection is never polled; its bindings stay visible on the Deviations page with their last observation.
- **When:** the pure `decide` (`sync/SchedulePolicy.kt`) over the newest 50 `sync_runs` of the connection: no run = due at once (a freshly tested connection polls at the next tick, at most `sync.tickSeconds` = 60 s); otherwise newest finish + the interval, doubled per further consecutive failure (`ABANDONED` counts) up to six hours, a success resets; **an edit to the connection, a real mapping change or a new discovery makes it due at once** (an administrator who fixes a token is not left waiting out a back-off); a run in flight (younger than `sync.maxRunMinutes`) is waited for, one older is a crash and the claim abandons it. A manual refresh is simply the newest run, so it resets the cadence by itself. A PUT that changes ONLY the interval also moves `updated_at` and so costs one full read (accepted).
- **A poll of a connection with no bindings** succeeds having called nothing: one database read per interval.
- **Concurrency:** a scheduled run and a manual one are the same claim (the loser of the unique index is a `409` on the route, a "claimed elsewhere" INFO in the scheduler); a poll never takes the plan lock and is independent of an import (they meet only on binding rows, in id order). Outbound permits (2) are shared with binds: a bind during a poll may queue up to `jira.bindPermitWaitMillis` and then answer `502 BUSY`.
- **Scheduled runs** are ordinary rows of the run list with `trigger` `SCHEDULED` and `requestedByUserId` null, and write no `jira.sync_requested` audit line.
- **Proven by** `SchedulePolicyTest` (the table), `SyncSchedulerTest` (a real registry, a fake connector, an injected clock, two instances, a throwing connector, the tick budget, the shutdown), `SyncBootTest` and `JiraRunTest` "a scheduled run observes the bound issues like a refresh" (the stub). The e2e harness and the compose demo: the API-seeded e2e connections are manual-only (`pollIntervalMinutes: null`); the one the SPA modal creates in "admin creates a Jira connection, tests it…" (`jira-sync.spec.ts`) is polled until C6 makes the form send the member (the modal omits it, so the server stores 15) - it has no bindings, so its run calls nothing; the compose stack polls its demo connection every 15 minutes.

## Status (1.3)

Every connection answers a derived `status` (`SyncStatus`, `sync/SyncStatus.kt`; the rule and its three readers are in `observability.md` "Sync runs"): `state` NEVER_SYNCED | CURRENT | STALE | FAILED | DISABLED, `lastRun`, `lastSucceededAt`, `consecutiveFailures`, `nextPollAt`. Nothing is stored: `JiraConnectionService.read`/`list` compute it inside their own transaction from the connection row and `SyncRunService.recentRunsInTransaction` (the rows go through `toConnectorConnection`/`statusesInTransaction` in `jira/JiraConnectionPolling.kt`), and `GET /views/deviations` computes `connections[].status` from the snapshot's own reads (`DeviationViewRows.loadConnections` carries the poll facts, `DeviationViewService` derives against the view's clock). The top-level `lastRun` of both is `status.lastRun` (kept for existing readers).

- **FAILED** is the newest FINISHED run failing or being abandoned, with its machine `errorCode` on `lastRun` (never the detail); a run in flight on top does not clear it. An INTERRUPTED newest row (unfinished, older than `sync.maxRunMinutes`, no claim has abandoned it yet - a crash on a manual-only connection stays that way) counts like an abandonment: FAILED, one more in `consecutiveFailures`, `lastRun` showing it with `running` false and `finishedAt` null; `nextPollAt` is still `decide`'s (due for a polled connection, null for a manual-only one). It recovers by the next success, and an edit that makes the connection due at once (a fixed token) lets that happen without waiting out the back-off.
- **`nextPollAt`** is the scheduler's `decide` verbatim, so a failed connection shows the doubling wait (one interval after the first failure, two after the second, six hours at most) and a freshly tested one "now". An untested connection has none (it is never polled); the SPA's hint "Test the connection first" comes from `discoveredAt == null`.
- **`lastSucceededAt`** is the START of the newest successful run (the incremental watermark: the data is as of then), which is also what STALE measures.
- **Proven by** `SyncStatusKernelsTest` (every state, STALE at exactly 3 intervals, manual-only, the streak, `nextPollAt` equal to `decide`), `JiraConnectionStatusTest` (a real run against the stub NEVER_SYNCED to CURRENT, FAILED with its code and the doubling wait, DISABLED after a PUT, STALE with rows and with the injected clock), `DeviationViewScopeTest` (the view's block and clock) and `TelemetryRoutesTest` (the telemetry block).

## Acknowledge (1.3)

A planner who has seen a deviation and accepts it acknowledges the BINDING's deviation list, once ("until changed"); it then stops counting as open. `POST /integrations/jira/bindings/{id}/acknowledge {fingerprint}` and `DELETE …/{id}/acknowledge` (`jira/JiraAcknowledgeRoutes.kt`, `JiraAcknowledgeService.kt`; the order and the guard are the `authorization.md` rows, the locks `persistence.md`, the audit `observability.md`).

- **What it keys on.** `fingerprintOf` (`jira/DeviationCompute.kt`): the SHA-256 of the canonical JSON of the binding's FULL kernel list (`[{kind, severity, detail}]`, `ESTIMATE_NOT_COMPARABLE` included even where the item hides it, so the value does not depend on the filter or the caller). It is rendered with a pinned `Json` that writes neither nulls nor defaults, so a later additive nullable member of a deviation changes no hash (a null still differs from a value); `DeviationFingerprintTest` pins a literal digest. Any change on either side that alters a deviation - the plan date moved further, Jira's end moved, a new or vanished kind, a different count of days - gives another fingerprint, and the stored acknowledgement reads `current = false`: acknowledged on D by X, **changed since**, and the item is OPEN again. A change that alters no deviation (a plan field the kernel does not compare) keeps it. Per binding, not per deviation: one click, one meaning. `PROGRESS_MISMATCH`'s detail is the contradicting plan date, so the fingerprint is stable day to day and a boundary crossed raises a NEW deviation, which correctly reopens the item. **A later release that changes a kernel rule changes every fingerprint and so un-acknowledges everything: by design, stated in that release's notes.**
- **The write.** ONE short transaction, no plan lock: the binding row locked, the node's chain re-read and the guard run again, the deviations of THIS binding recomputed with `DeviationViewService.computeBindingInTransaction` (the same `computeInTransaction` the view runs, scoped by `DeviationScope(bindingId)`; a parent issue's own binding is looked up so `PARENT_MISMATCH` equals the view's), then the fingerprint compared: different, or an empty list, is `409 urn:astrolabe:problem:stale-deviations` and nothing is written. The stored `ack_by_user_id`, `ack_at` and fingerprint are the only effect; acknowledging the same state again restamps who and when.
- **What the view does with it.** The default `GET /views/deviations` lists OPEN items (deviating, not currently acknowledged); `acknowledged=true|false` narrows; `all` and the chips' implied `all` keep every state, with `acknowledgement.current` telling them apart. `warnings`, `infos`, `gone` and `acknowledged` share one basis - the items matching every filter but the acknowledgement state - and count its OPEN items and its currently acknowledged ones (so "N open" survives `acknowledged=true`); `bindings` is the number the list answers. An item whose only deviation is `ESTIMATE_NOT_COMPARABLE` is open, and counted, exactly where that kind is listed (`kind=ESTIMATE_NOT_COMPARABLE` or `all=true`); the default never lists it, so it is not open there. It can be acknowledged from such a listing; the timeline fold ignores that kind.
- **Who.** The owner chain of the node or ADMIN (Q4a); a milestone's team manager as such may not (a backlog item). `can.acknowledge` carries the verdict per item.
- **Proven by** `JiraAcknowledgeTest`, `JiraAcknowledgeRaceTest`, `JiraAcknowledgeRunTest` (a real `jira-day2` run reopens an acknowledged item), `DeviationViewAckTest`, `DeviationFingerprintTest`.

## Timeline flags (1.3)

The four timeline views (roadmap, programs, project, team) carry the Jira links and flags of the rows they answer (`planning-model.md` "Jira flags and links" is the contract, `timeline.md` "The Jira markers (1.3)" the document shape and the measured cost). **How it is built.** `planning` declares the seam (`planning/ExternalFlags.kt`: `ExternalFlagSource`, `ExternalFlagRequest`, `ExternalFlags`, `JiraLink`, `JiraSite`; the deviation vocabulary `Deviation`, `DeviationKind`, `DeviationSeverity`, `DeviationDetail` moved to `planning/Deviations.kt` with unchanged serialized names, so a stored fingerprint and the spec schemas did not move) and names no `jira` type; `jira/JiraFlagSource.kt` implements it over `DeviationViewService.computeInTransaction(scope)` and `infra/db/Database.kt` wires it into the four view services. The source runs INSIDE each view's `READ ONLY REPEATABLE READ` snapshot, after the calendar, with the calendar the view read and "today" from the deviations service's own clock, so a flag equals what the Deviations page lists as open for the same state.

- **What raises a flag.** An OPEN binding (a non-empty kernel list, no CURRENT acknowledgement) of an ENABLED connection, one `JIRA_DEVIATION` per deviation at the deviation's severity, except `ESTIMATE_NOT_COMPARABLE` (the kernel's "a figure exists and cannot be compared" is a Deviations-page note, not a timeline warning). A stale acknowledgement (`current = false`) is open again. A project also gets ONE `JIRA_MILESTONES` roll-up over its milestones that raised a flag (`count`, the worst severity).
- **What does not.** A DISABLED connection (Q8: its rows answer `jira: null`, no flag, no bar, no site; its bindings still list on the Deviations page and still block their node), an acknowledged binding (it keeps its `jira` link so the bar stays), a clean binding, an unobserved one (link with null dates). A `gone` item raises `GONE` alone with null dates. Program and work-stream bindings are not folded in 1.3 (the programs tree rolls up the projects' flags).
- **The scope.** `DeviationScope` gained `levels` (the whole-plan ask reads project and milestone bindings only); a named node list matches a binding on ANY named node, a named EMPTY list names nothing. The roadmap and programs views ask for the whole plan, the project view for the project and ALL its milestones, the team view for no project and the team's milestones. The scoped computation equals the full one (`DeviationScopeNodesTest` pins it, including a parent issue bound outside the scope).
- **Cost.** About 45 us a binding in service time (the roadmap over 1,100 bindings: +50 ms; the team view over 301: +16 ms); numbers and a profile in `timeline.md` "Measured figures (1.3)"; the lean projection is a backlog item.
- **Proven by** `JiraFlagSourceTest` (the table: each kind, the roll-up, acknowledged, stale, disabled, noise, gone, the request shapes), `DeviationScopeNodesTest`, `TimelineJiraFlagsTest` (the four views through HTTP on one bound world, the overlay's additivity, the always-present members), `JiraFlagsScaleTest` (the sizes and the gates).

## The token's life

Encrypted at write (`FieldCipher`, `enc:v1:` envelope, a fresh nonce), write-only on the wire (`hasApiToken`), masked in every `toString` (`SecretToStringTest`) and absent from audit lines, logs and run
rows (`error_detail` is clamped and URL-stripped). It is decrypted in memory only by four readers in `JiraConnectionService` (Test connection, Peek, the bind and the run, the last two through `readForBind`). A `PUT` with a
token rotates it, and a changed token, email, auth scheme or project-key set clears `last_tested_at/ok` (the last test judged the old ones); a blank token keeps the stored one; the site cannot be changed (`409`). At boot `EncryptedAtRest` wraps any legacy plaintext, and with
`DATA_ENCRYPTION_KEY_PREVIOUS` set re-encrypts every row (soft-deleted ones too; NULLs skipped), audited `crypto.reencrypted`. `docker compose up` and `:server:run` use different keys over one Postgres, so a
row may be unreadable: that is `TOKEN_UNREADABLE`, never a 500. **Deleting a connection sets the column to NULL** (the V21 CHECK allows that on a deleted row only).

## The stub on each stack

One WireMock image (`sample-data/jira-stub`, `FROM wiremock/wiremock:3.13.2`, 1,612 mappings) serves compose (`127.0.0.1:8096`, `JIRA_STUB_BASE_URL=http://jira-stub:8080` on `app`) and the OrbStack
overlay (`k8s/local/jira-stub.yaml`, Service `jira-stub:8080`, a NetworkPolicy pair); the server suite starts the same files in-JVM (`JiraStubServer`, warmed in a `@BeforeClass`). Production has neither the
service nor the variable. **Cloud id** `b3f1a2c4-5d6e-4f7a-8b9c-0d1e2f3a4b5c`; connect with site `https://sample.atlassian.net`, any email, any token except `wrong-token` (that one gets `401` everywhere:
`auth-wrong-token-401`).

- **Projects** (`expected.json`): `CE PF CG DI OE` (the five work streams: 20 Programs, 100 Initiatives, 1,000 Epics, parents following the plan), `E2E` (10 issues in 2044, only the e2e spec binds it),
  `IMP` (the import's project, 9 issues in 2045, untouched by day 2; only the import e2e spec imports it) and `OUT` (no issues; where day 2 moves five epics). **Working scopes** are exactly: `E2E`; `CE PF CG DI OE`; those five plus `E2E`; `IMP` (any key order, quoted or not);
  plus the five single keys `CE`, `PF`, `CG`, `DI`, `OE` for the typed full read ONLY (the import's browse of one key; no connection is scoped to one key). Hierarchy levels: Sub-task −1,
  Story/Task/Bug 0, Epic 1, Initiative 2, Program 3. Dates are absolute for the **anchor Monday 2026-10-26** (statuses are relative to it, so they age).
- **A request outside a mapped shape falls to the `401` catch-all, and that is misleading on purpose** (it mirrors a real site's id-only default): a `401` on `search` with a good token usually means the
  JQL scope or the `fields` string matched no mapping, not an authentication problem. Adding a shape is an edit in `sample-data/jira/mappings.mjs` plus a regenerate (`scripts/gates.sh` checks the
  committed files against a fresh run).
- **`jira-day2`**: `PUT http://localhost:8096/__admin/scenarios/jira-day2/state` with `{"state":"day2"}` deletes 12 epics, moves 5 to `OUT` and deletes `E2E-6`; back with `{"state":"Started"}`.
- **Do not import the five work-stream projects into their real streams on a stack that holds your data.** Importing `CE` into the loaded sample plan's Customer Experience stream previewed 10 create, 212 link and 2 skipped (measured 2026-11-07): the stub's deliberately renamed items ("Documentation (renamed)") match no plan name and would be created. Use `IMP` and a throwaway work stream, or stop after the preview.
- The stub does not filter `fields` (documents carry a superset), so the server tests assert the REQUESTED `fields` string; a missed field would pass here and read null on a real site.
- **`expected.json` is holiday-free** (Mon–Fri): the planted working-day shifts and counts match only on a plan WITHOUT the Polish holiday preset. With the preset loaded (the compose sample plan may have it)
  figures that span a public holiday differ by the holidays between the dates.

## First real-site walk-through

Do this when a real site and token arrive. Use an account and a scoped or classic API token with read access to a handful of projects.

1. **Connect.** Administration → Jira → New connection: the real site URL (`https://<name>.atlassian.net`), the account email, the token, auth scheme `BASIC` first (`BEARER` if the site demands it), a few project
   keys (≤ 50). **Test connection** and read the rows top to bottom; the FIRST failed row is the cause.
   - `tenant_info` failed (everything after reads `NOT_FOUND`): the site URL is wrong, or `BLOCKED_HOST` (not a tenant host), or a network/DNS block (`outbound.blocked` audit event).
   - `myself` 401: the token or the auth scheme. `myself` ok but another row 401: a missing scope; the row's hint names it (a missing scope is a 401, not a 403).
   - `search` 400 or `INVALID_RESPONSE`: **A3** (issue-type ids in JQL); `projects` 400: **A8** (50 `keys`). These two are the likeliest surprises; both are one-line client changes.
   - `project:<KEY>` `PROJECT_NOT_VISIBLE`: the token cannot see that project. No `issue` row: the search returned nothing.
2. **Read the discovery report** (the Mapping section; it exists only once a Test connection has been RECORDED, so a stored-connection test comes first, and mapping, Peek and bind all answer `409` until then): the counts, which field matched "Target start"/"Target end" and with what `schema.custom` (**A1**), whether a legacy Parent Link exists (**A2**), the
   Team and Story-points fields (**A7** if `fieldsTruncated`). Every "not found" is a decision for the mapping.
3. **Check the mapping defaults and save them** (or pick fields by hand); the levels list shows the type names per Jira level on this site. A site without Jira levels 2 and 3 (Initiative, Program need Premium) leaves the project and program levels unmapped by default: then only milestones can be linked until an admin maps them to levels that exist.
4. **Peek** one real epic (and, where the site has them, an initiative): the type, hierarchy level, parent key, the dates as plain `YYYY-MM-DD` (**A5**: a datetime field is refused), the estimate, the Team name. `raw` shows what the site sent.
5. **Bind** one node per mapped level to known issues: "Link to Jira…" on the project page for a project or a milestone (an owner or ADMIN), "Link a node…" in the connection page's Bindings section for a program (ADMIN). A wrong level reads `400` naming both levels. Then **Refresh now** (ADMIN) and read the run row: `observed`, `calls`, the error code; `rateLimited` and `backoffMs` are in `GET /integrations/sync/runs` and in the INFO log line, not in the table.
   Compare the Deviations page with the Jira UI for those items.
6. **Import** (only after steps 1 to 5 read right). A real import creates real plan rows, and nothing undoes it in one step (each node is deleted by hand), and program names are globally unique, so:
   - **Use a throwaway work stream** the first time (create one, with a throwaway owner), and a connection scoped to a small project (`projectKeys` narrows a larger connection); never a work stream with real data.
   - **Review the mapping first** (step 3): the import reads exactly the mapped levels, fields, unit and Team field, and a wrong level or no declared factor (a unit other than `DAYS` with no man-days per unit) shows up in the preview (rows skipped, a milestone's `ESTIMATE_NOT_CONVERTED`).
   - Administration → Jira → the connection → Bindings → **Import from Jira…**; pick the stream, an owner and, say, a default team; then **Preview** and read it before anything else: the totals, which rows are CREATE, BIND and SKIP and why. Expect renamed items to preview as new (above).
     Tick only what you want. **Assert the totals against what you expect** (how many Jira items at each level) before pressing Import; do not import on a hunch.
   - A lot of `NO_PARENT` rows: either the items have no parent at the level above (give a default program or project) or the site's `search/jql` entries do not carry `parent.fields.issuetype` (**A10**); a preview that takes minutes is the browse itself (pages of `jira.pageSize`, retries on 429; it stops at 170 s).
   - After **Import**, read the outcome (created, linked, skipped with reasons), open the project page (milestones dated, or created unscheduled where you do not manage the team), run **Refresh now** and compare the Deviations page. A second import must create nothing when everything was imported (`ALREADY_BOUND`; items left out, or whose plan item was deleted since, are offered again).
7. **When something fails:** the run row's `errorCode` (`FORBIDDEN_SCOPE`, `INVALID_RESPONSE`, `LIMIT_EXCEEDED`, `MAPPING_INVALID`, `TOKEN_UNREADABLE`, …); the `ch.nokillswit.sync` log lines (counts and codes
   only); the `jira.connection_tested` / `jira.sync_requested` audit events; `502 BUSY` on a bind means the permit pool was occupied (retry, or raise `JIRA_MAX_CONCURRENT_REQUESTS`).

## Assumptions ledger

"Stub-only" means NOT verified on a real site. Flow's own findings are marked; they were seen on Flow's tenant, not on this one.

| # | Assumption | Status | Where it shows |
|---|---|---|---|
| A1 | Jira Plans names its date fields exactly "Target start"/"Target end" (customs `jpo-custom-field-baseline-start/-end`) | stub-only; Flow knows only the "target start" fragment. The name match is case-insensitive with a `schema.custom` fallback | discovery report, mapping defaults |
| A2 | Plans' legacy Parent Link is folded into the `parent` field on current sites; the sync reads `parent` only | stub-only | the report lists a legacy Parent Link if present |
| A3 | JQL accepts issue-type ids in `issuetype in (10001,10002)` | stub-only; Atlassian documents "name or ID", Flow never used it | the `search` probe sends exactly that clause |
| A4 | `search/jql` with `fields=id` could allow a bigger page (up to 5,000) | not exercised: 100 a page is Flow's verified figure | backlog (raise it after measuring) |
| A5 | Mapped date fields are `schema.type == date`; a datetime is refused | design rule; time-zone edges unverified | mapping validation, Peek |
| A6 | `fields.status.statusCategory.key` is `new|indeterminate|done` | the object form on issues is Flow-verified; the key values are stub-only here | observations, `PROGRESS_MISMATCH` |
| A7 | The site's usable fields (≤ 2,000) and issue types (≤ 500) fit the snapshot | stub-only (Flow's tenant had 1,344 fields before the date/number/custom filter) | `fieldsTruncated` |
| A8 | `project/search` accepts up to 50 repeated `keys` | **from memory of Atlassian's docs, not verified anywhere** | the `projects` probe |
| A9 | The Team field's value is an object with a `name`, or plain text on some sites (`teamNameOf`) | stub-only; Atlassian Team is the object form, the plain-text form is defensive | Peek `teamName`, `raw` |
| A10 | A `search/jql` entry carries its direct parent's `fields.issuetype` (the import needs it only for a parent outside the browsed set; absent = the parent's level is unknown = the item is an orphan) | stub-only; the stub's parent type object even omits `hierarchyLevel` for some ids, which the planner resolves through the discovery by type id | import preview: items read `NO_PARENT` that have a parent in Jira |

Also unverified until a real site: the gateway with a scoped token and which auth scheme it needs, `hierarchyLevel` on issue documents (the client falls back to the `/issuetype` index), this tenant's
page sizes and rate-limit behaviour.

## Decisions on the overnight defaults

Proposed on 2026-11-06 and **kept by the user on 2026-11-07**; each is a one-place change if overturned: **D1** one Jira issue stays 1:1 across connections of the same site (the V21 index is per
connection, and a unique site index would collide on the shared stub host); **D2** deleting a connection soft-deletes its bindings in the same transaction (the node index has no connection column, so they
would block their nodes for good); **D3** the discovery is stored whenever `field` and `issuetype` both answered, even if another probe failed; **the empty-sweep default** (an empty listing flags the
bound items gone with a WARN log, and the next good run clears them); **a disabled connection's bindings stay visible** on the Deviations page. A8 above is not a decision but an unverified assumption.
