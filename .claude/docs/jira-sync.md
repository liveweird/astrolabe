### The Jira sync (v1.1.0)

Read before touching `jira/`, `sync/`, `infra/fetch/` or the Jira pages. **What it is:** Astrolabe reads Jira Cloud and compares it with the plan; **nothing is ever written to Jira**
and corrections are made in Astrolabe. 1.1.0 is the connection, the mapping, 1:1 bindings, a manual Refresh and the Deviations page. **It is proven against the built-in Jira stub and
not yet tested against a real Jira site** (the walk-through below is the first real test). Not in 1.1: polling and acknowledge (1.3), import (1.2), coverage (1.4), Flow (1.5).
Related: schema `persistence.md` "The Jira sync tables (V21)"; outbound guard `security.md` "Outbound HTTP calls"; audit events and the run log lines `observability.md`; per-route guards
`authorization.md`; the web pages `web/CLAUDE.md` "Jira connections" and "Deviations"; the stub's dataset `sample-data/jira/README.md`.

## Who may do what

| Call | Guard |
|---|---|
| `…/integrations/jira/connections` (CRUD), `…/connections/test`, `…/{id}/test`, `…/{id}/discovery`, `…/{id}/mapping`, `…/{id}/peek` | ADMIN, `requireAdmin` BEFORE the body (guard-before-read) |
| `POST /integrations/sync/runs {kind, connectionId}` (Refresh now) | ADMIN; `202` with the unfinished run |
| `POST /integrations/jira/bindings`, `DELETE …/bindings/{id}` | the node's owner chain or ADMIN (`requireOwnerOrAdmin`), read-before-guard; a link writes no dates, so the team-manager rule does not apply |
| `GET …/bindings`, `GET …/sync/runs`, `GET /views/deviations` | any authenticated user |

Rate buckets: `jira-test` 10/min per IP (Test connection, ad hoc or stored, and Peek); `jira-bind` 30/min per user (spent before the guard, so a 403 costs a token too).

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
A `gone` issue raises `GONE` alone. Default: deviating bindings, warnings first; `all`, `projectId` or `teamId` also list clean ones. A **disabled** connection's bindings stay in the view with their last
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
6. **When something fails:** the run row's `errorCode` (`FORBIDDEN_SCOPE`, `INVALID_RESPONSE`, `LIMIT_EXCEEDED`, `MAPPING_INVALID`, `TOKEN_UNREADABLE`, …); the `ch.nokillswit.sync` log lines (counts and codes
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

Also unverified until a real site: the gateway with a scoped token and which auth scheme it needs, `hierarchyLevel` on issue documents (the client falls back to the `/issuetype` index), this tenant's
page sizes and rate-limit behaviour.

## Decisions on the overnight defaults

Proposed on 2026-11-06 and **kept by the user on 2026-11-07**; each is a one-place change if overturned: **D1** one Jira issue stays 1:1 across connections of the same site (the V21 index is per
connection, and a unique site index would collide on the shared stub host); **D2** deleting a connection soft-deletes its bindings in the same transaction (the node index has no connection column, so they
would block their nodes for good); **D3** the discovery is stored whenever `field` and `issuetype` both answered, even if another probe failed; **the empty-sweep default** (an empty listing flags the
bound items gone with a WARN log, and the next good run clears them); **a disabled connection's bindings stay visible** on the Deviations page. A8 above is not a decision but an unverified assumption.
