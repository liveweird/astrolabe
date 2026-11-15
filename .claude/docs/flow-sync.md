# Flow sync

Owns: the Flow connector: transport and origins, contract, Test connection, the run and mirror, team bindings and roster panel, the capacity import, the capacity deviation with its acknowledge and flags, the stub. Not here: runs, scheduler, status, failure codes, token life (`sync.md`); guard orders (`authorization.md`); audit events (`observability.md`); tables (`persistence.md` "The Flow sync tables"); the outbound guard (`security.md` "The Flow consumer"); Jira (`jira-sync.md`); the pages (`web-internals.md`);
the stub's data (`sample-data/flow/README.md`).

## Rules

- **Nothing is ever written to Flow.** Astrolabe reads Flow (the sibling app) through its read-only service token and mirrors ONE document, every team with its dated members and its sprints, into typed tables (V24). The run is the mirror's only writer; Test connection never writes it; the bind, the preview and the apply read the mirror and call Flow never.
- **Origins are operator configuration, never an admin's.** A connection's `baseUrl` is exactly one listed origin, in its canonical form only, and is the connection's identity; the guard judges every call (`security.md` "The Flow consumer").
- **The registry is ADMIN only on every operation, reads included, `requireAdmin` first.** The token is write-only (`sync.md` "A stored token's life"). Test connection never answers 502: every outcome is a row of a `200`.
- **The contract is written in two places that must agree** (`contract.mjs`, `FlowDocument.kt`: "The contract and drift"). The stub proves the code against the contract as written; the walk-through proves the contract.
- **A run observes.** No plan lock, no revision, nothing sent to Flow beyond the one GET, no database transaction open across it. The mirror is replaced wholesale in one transaction that re-reads the connection under its row lock; a truncated document never marks a team gone.
- **A binding is 1:1 both ways** over the ACTIVE rows (a team has one Flow team across ALL connections) and is not plan state. Reads are any authenticated user's; writes the TEAM's active manager or ADMIN.
- **Disclosure.** Every login reads a team's roster (display names and dates) and the Flow team names, counts and sync status of the ACTIVE connections. Flow's per-sprint `flowMd`/`flowTotalMd` and the connection's zone are visible to every login on `GET /views/capacity-deviations` (an accepted disclosure; the preview that shows them is the manager's). Never a base URL, token, account id or email.
- **The import owns only the periods it wrote.** A hand-entered period is NEVER changed or removed by the import (only `source = FLOW` periods are updated or offered for removal). The apply re-plans under the team row lock and writes an item only when the plan still equals what the preview showed (`CHANGED` otherwise). A removal is never preselected.
- **Preview, apply and deviation share ONE plan** (`CapacityImportKernels.plan`): they can never disagree about a sprint's window, held days or figure.
- **Deviations only warn.** Nothing is stored but the acknowledgements, nothing moves, nothing is written to Flow. The unit is a sprint; an acknowledgement is per (binding, sprint) and lives only while its row is listed.
- **One lock order for every write of a binding's acknowledgement rows:** the connection row, the binding row, the team row, the manager and person rows, the acknowledgement rows. Nobody takes a team row and then THAT team's binding row ("Acknowledge").
- **Guards and their order are `authorization.md`'s.** The poll bound and the credential's presence are `sync/ConnectionRules.kt` (`requirePollInterval`, `requireSecret`), shared with Jira.
- **`flow/` and `jira/` name nothing of each other; `sync/`, `planning/` and `teams/` name nothing of `flow/`** (the flag seam and the capacity-write listeners; `PackageBoundaryTest`).

## Who may do what

Guards and their order: `authorization.md`. Rate buckets: `flow-test` 10/min per IP (`FLOW_TEST_RATE_LIMIT_PER_MINUTE`, 1..100; the e2e stacks pin 30), Test connection only (a Flow test never spends a Jira bucket); the manual Refresh rides the per-USER `sync-run` bucket (10/min, shared with Jira's). A scheduled run, the bind, the preview and the apply ride none.

| Calls | Who | `authorization.md` section |
|---|---|---|
| `…/integrations/flow/connections` (CRUD), `…/connections/test`, `…/{id}/test`, `GET …/flow/origins`, `POST …/connections/{id}/team-bindings/match` | ADMIN, `requireAdmin` BEFORE the body | "Flow connections, teams and bindings" |
| `POST /integrations/sync/runs {kind: FLOW, connectionId}` (Refresh now) | ADMIN; `202` with the unfinished run; audited `flow.sync_requested` | "Sync runs" |
| `GET /integrations/sync/runs?kind=FLOW&connectionId=` | any authenticated user | "Sync runs" |
| `GET …/flow/teams?connectionId=`, `GET /teams/{id}/flow` | any authenticated user | "Flow connections, teams and bindings" |
| `POST …/flow/team-bindings`, `DELETE …/team-bindings/{id}` | the TEAM's active manager or ADMIN | "Flow connections, teams and bindings" |
| `POST …/team-bindings/{id}/capacity-preview`, `…/capacity-import`, `…/acknowledge`, `…/acknowledge-all`, `…/unacknowledge-all`; `DELETE …/acknowledge?sprintId=` | the binding's TEAM's active manager or ADMIN (binding `404` → `403` → body `400`; the guard again under the lock) | "Flow capacity import and acknowledge" |
| `GET /views/capacity-deviations` | any authenticated user, a read (no audit, no lock, no revision) | "The deviation views" |

## The transport and origins

Files: `flow/Flow.kt`, `FlowHttp.kt`, `FlowClient.kt`, `infra/outbound/FlowOrigins.kt`, `infra/fetch/`.

Flow is reached over `GET /api/v1/integration/me` and `GET /api/v1/integration/teams?sprintsSince=YYYY-MM-DD` with `Authorization: Bearer flow_int_<43 base64url>`. Failure codes are `FetchCodes` (`sync.md` "Failure codes"): Flow's `401` is one uniform answer (revoked, expired or wrong), `NOT_FOUND` is a Flow older than 1.57.0.

- **Config** (`flow.*`, env `FLOW_*`, every key boot-validated; the first five via `infra/fetch/TransportConfig.kt`): `requestTimeoutSeconds` 30 (5..120), `requestDeadlineSeconds` 60 (10..600), `maxResponseBytes` 1 MiB (64 KiB..1 MiB), `maxConcurrentRequests` 1 (1..2), `maxRetries` 2 (0..8), `sprintsSinceDays` 365 (30..1095). The 1 MiB and 2 ceilings keep Flow inside the heap reserve without a second heap-fit check (`security.md`).
- **TLS Flow:** `FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE` (https to a listed `host[:port]`, a private range only for a listed host inside a CIDR, an extra CA beside the JVM defaults, no skip-TLS switch).
- **Plain http:** `FLOW_INSECURE_ORIGINS` (exact `http://host[:port]` origins) carries the stub and a plain-http Flow on OrbStack, in development mode ONLY (a non-blank value elsewhere refuses boot). An insecure host may resolve to a loopback, private or docker address and **never** to a link-local (the metadata address), any-local, multicast, `0.0.0.0/8`, `::/96`, `::ffff:0:0:0/96`, 6to4 or Teredo one.
- **The base URL** is exactly one listed origin in its **canonical form** (`FlowOrigins.baseUrlVerdict`): lowercase scheme and host, the scheme's default port OMITTED (`https://flow.example`, never `:443`, no leading zeros in a port), no path, trailing slash, query or credentials.
- **The verdict is `NOT_CANONICAL` (a spelling problem) or `NOT_LISTED` (a well-formed origin nobody listed; the message points at `GET …/flow/origins` and the operator's keys)** (`FlowBaseUrlVerdict`): the `400` says WHICH refused, never quoting the value. A port is never the reason a base URL is refused: only an unlisted origin is.
- **`GET …/integrations/flow/origins`** (ADMIN, a read, no audit): `{items}` from `FlowOrigins.allowedOrigins()`, the listed TLS hosts as `https://host[:port]` (443 omitted) plus, in development only, the insecure ones as `http://host[:port]` (80 omitted), distinct and sorted; a bounded operator-curated set, so the plain `{items}` wrapper. It feeds the create form's hint and widens nothing.
- A stored URL the operator has since delisted is refused on every call (`BLOCKED_HOST`, audited once, no retry); a `PUT` never asks the list (an admin can still disable or re-token it).

## The contract and drift

| Document | Fields (`?` = nullable, and omitted by Flow when null) |
|---|---|
| `GET /integration/me` | `tokenId, name, createdAt, expiresAt?, lastUsedAt?` |
| `GET /integration/teams?sprintsSince=YYYY-MM-DD` | `asOf, sprintsSince, teamsTruncated, sprintsTruncated, items[]` |
| a team | `id, name, managerName?, defaultCapacityMd?, members[], sprints[]` |
| a member | `accountId, displayName?, validFrom, validTo?` (a HALF-OPEN interval `[validFrom, validTo)` in epoch ms; `validTo` null = still a member) |
| a sprint | `sprintId, connectionId, name, state, startAt?, endAt?, completeAt?, hasCalendar, capacityMd?, capacitySource?` (epoch ms; `capacityMd` is a TOTAL for the sprint whatever its source; `capacitySource` is `CALENDAR`, `TEAM_DEFAULT`, `DEFAULT` or null and kept as text, as is `state`) |

- The caps are 1,000 teams (`teamsTruncated`) and 2,000 sprints (`sprintsTruncated`). Every error is Flow's uniform `application/problem+json`; only the status is used.
- **The drift rule.** The stub's documents are produced only by `sample-data/flow/contract.mjs`; the server decodes only through `flow/FlowDocument.kt` (`@Serializable`, `ignoreUnknownKeys`; strict on lists and flags, lenient on nullable scalars: ledger F1); `FlowStubFixtureTest` and `FlowClientTest` replay the stub's documents into the decoder against `expected.json`.
  If a real Flow ships a different field or path, the fix is two files and one test: edit `contract.mjs` and `FlowDocument.kt`, regenerate (`node sample-data/flow/generate.mjs`), and those tests prove them aligned.

## Test connection and the probes

`FlowConnector.testConnection` runs two required probes in sequence (10 s each, 30 s in all, never throwing; every outcome is a row, **never a 502**):

1. `me`: the token is live; `NOT_FOUND` carries the hint "Flow 1.57.0 or later".
2. `teams`: the document decodes; the result adds "N teams, M sprints" and `truncated`; `SKIPPED` when `me` failed.

- One `stored_token` row (`SyncErrorCodes.TOKEN_UNREADABLE`) when the stored token cannot be decrypted; nothing is called.
- `POST …/{id}/test` records `last_tested_at/ok` unless the row was edited meanwhile (`recorded`) and audits `flow.connection_tested`; `POST …/connections/test` is ad hoc and stores nothing. A passing test is what makes the connection pollable, so the first run follows within a tick.
- **Test connection never writes the mirror:** the run is its single writer. The row codes are `sync.md` "Failure codes".

Pinned by: `FlowConnectionTest`, `FlowTestConnectionTest`.

## The run

Files: `flow/FlowObserver.kt`, `FlowMirrorStore.kt`, `FlowMirror.kt`. The shared mechanics (claim, deadline, tally, the failure text) are `sync.md` "The runner"; the polling and the status are `sync.md` "The scheduler" and "Connection status".

`FlowObserver` (the `Connector` of kind `FLOW`, registered by `configureFlow`) does, per claimed run:

1. Reads the connection and its token in one short transaction (`FlowConnectionService.readForRun`, the second of the two decrypting readers); then NO database transaction is open until the call has returned.
2. ONE `GET /integration/teams?sprintsSince=`, `sprintsSince` being today in the CONNECTION's zone minus `flow.sprintsSinceDays`.
3. `FlowMirrorStore.replace` in one transaction. It re-reads the connection under its row lock (`FOR NO KEY UPDATE`, taken at its final strength because the same transaction stamps `teams_at` and an upgrade is deadlock-prone) and writes nothing when the connection was deleted (`GONE`) or disabled (`DISABLED`) meanwhile.
4. The same transaction prunes the capacity acknowledgements whose row left the list (a `sprintsTruncated` document judges no sprint key: "Acknowledge").

| Situation | Run | Mirror |
|---|---|---|
| a document | `SUCCEEDED`; `observed` = teams, `gone` = ACTIVE bindings whose Flow team the document lacks, `calls` = 1 | replaced wholesale, `teams_at` stamped |
| `401` | `FAILED` `AUTHENTICATION_FAILED` (rotate the token with a `PUT`: that makes the connection due at once) | keeps its last document |
| `5xx` / `429` | `FAILED` `UPSTREAM_UNAVAILABLE` / `RATE_LIMITED`, then the registry's doubling back-off plus the deterministic jitter | keeps its last document |
| a body that is not the contract | `FAILED` `INVALID_RESPONSE` | keeps its last document |
| unreadable token / unknown zone | `FAILED` `SyncErrorCodes.TOKEN_UNREADABLE` / `FlowRunCodes.TIME_ZONE_INVALID`, no call | untouched |
| connection deleted / disabled while the call was in flight (judged under the row lock: `FlowMirrorWrite.GONE` / `DISABLED`) | `FAILED` `CONNECTION_GONE` / `CONNECTION_DISABLED` | nothing written (a disabled one keeps its last document and `teams_at`) |
| `sprintsTruncated` | `SUCCEEDED` + a WARN (counts only) | the document Flow sent is kept |
| `teamsTruncated` | `SUCCEEDED` + a WARN; `gone` is **0** | the teams it carries are replaced, **every other mirrored team is kept whole** |

- **The `teamsTruncated` rule.** A team absent from a truncated document was merely not sent, so it is neither deleted from the mirror nor counted `gone` (the panel and `TEAM_GONE` never see it vanish); the next complete document is authoritative. The cost: a team really removed from Flow stays mirrored while Flow keeps truncating.
- **The token never appears** in a log line, an audit, a run row or a problem body: the run's error text is fixed (`sync.md` "The runner"), `clampErrorDetail` is only the backstop.
- Polling and `ready` (a passing test OR a mirrored document, sticky): `sync.md` "The scheduler".

Pinned by: `FlowRunTest` (against the stub), `FlowRunWireTest` (MockEngine: the three-document `teamsTruncated` case, the root `LogCapture` token check), `FlowConnectionStatusTest`.

## Bindings

A binding links ONE Astrolabe team to ONE Flow team of a connection (V24 `flow_team_bindings`; 1:1 both ways over the ACTIVE rows). It feeds the team's roster panel and the capacity import. The link and the unlink read the mirror, call Flow never and ride no rate bucket. A binding follows the Flow team's **id**; `flow_team_name` is display text frozen at link time (a rename in Flow changes nothing).

**Match by name** (`FlowTeamMatchKernels`, pure):

- A Flow team is *suggested* to an Astrolabe team when the folded names are equal (trim, collapse every run of whitespace to one space, lowercase; **accents count**: "Płatności" is not "Platnosci", a wrong automatic link is worse than a missing one) and the Astrolabe team is the ONLY unbound active team with that folded name.
- The rule is symmetric: two Flow teams that fold to one name are suggested nothing (so "Link all suggested" can never ask for one team twice). A bound team is never re-suggested, nor is a bound Flow team.
- `GET /integrations/flow/teams` shows the suggestion per Flow team; `POST …/connections/{id}/team-bindings/match` (ADMIN) links every current suggestion in ONE transaction and reports `bound[{bindingId, teamId, flowTeamId}]` and `skipped[{flowTeamId, reason}]` (`ALREADY_BOUND`, `NO_MATCH`).

**`GET /integrations/flow/teams?connectionId=` is unpaged, by decision** (`list-endpoints.md`): `{connectionId, teamsAt, items[≤ 1,000]}`, the mirror of ONE Flow document, which Flow caps at 1,000 teams, and the suggestion needs every unbound team at once. Items come by name then id. It serves the connection page (ADMIN) and the manager's link dialog.

**The link** (`FlowTeamBindingService.bind`) is one transaction: a global advisory lock first (`FLOW_BIND_LOCK_KEY`: links are human clicks, and the two uniqueness checks are exact over rows that may not exist yet), then the connection row `FOR SHARE` (a delete or a run's mirror replace waits), the Flow team read from the mirror as it is now, the team row `FOR SHARE`, the guard again, the checks and the insert.

**A soft-deleted team keeps its ACTIVE binding** (`teams/` may not name `flow/`). The link and the match RELEASE a dead team's holder of the Flow team (soft-delete, audited `flow.team_unbound` reason `TEAM_GONE`, the Jira bind's dead-node idiom), and `bindingsOf`, the match, the list, the panel and the unlink's lookup all filter on ACTIVE teams: a Flow team once linked to a deleted team can be linked again, and a dead team's binding is invisible (`404` to unlink). A connection delete soft-deletes its bindings in its own transaction.

**The panel** (`GET /teams/{id}/flow`, `FlowTeamService.panel`, its own read, not a member of the team view):

- `binding` (connection NAME, enabled flag, the connection's `SyncStatus`, `observedAt`, `gone`), `roster` and `sprints{count, nextStart}`: all null for an unlinked team; `roster` and `sprints` also null when the Flow team is **gone**. `gone` is derived at read time and never stored: the connection HAS mirrored a document (`teams_at` set) and the Flow team is not in it (consistent with the run's `gone` count, which skips a truncated document).
- `can{link, unlink, importCapacity}` is ADMIN or the team's active manager (one verdict, three flags).
- **`connections[{id, name, enabled}]`** is always present, whoever asks: every ACTIVE connection (enabled or not) by name then id, cut at 100 (`MAX_PANEL_CONNECTIONS`), so a manager, who cannot read the ADMIN-only registry, finds the connection for the link dialog; never a base URL, token, zone, interval or test detail.
- **The roster** (every signed-in user: one predicate, `rosterVisibleTo`, the constant `ROSTER_AUDIENCE` in `FlowTeamService.kt` flips it to manager-and-ADMIN-only). Memberships are half-open instant intervals `[validFrom, validTo)`: *current* when `validFrom <= now < validTo` (an open end never ends), *former* when `validTo <= now`; one that has not started is in neither list. Dates are the instants in the connection's time zone (a zone this JVM no longer knows reads as UTC; the run reports it).
  A null display name reads **"Unknown account"** (server-side text); a person with two intervals appears once per interval.
- `nextStart` is the first mirrored sprint start that is today (in the zone) or later.

Pinned by: `FlowTeamMatchKernelsTest`, `FlowTeamBindingTest`, `FlowTeamMatchTest`, `FlowTeamPanelTest`, `AuditTest`.

## The capacity import

Files: `flow/CapacityImportKernels.kt`, `CapacityApplyKernels.kt`, `CapacityImportService.kt`, `CapacityImportRoutes.kt`.

**The rule:** a sprint's man-days from Flow are spread over the sprint's WORKING days (Astrolabe's calendar: Monday-Friday minus the public-holiday dictionary), so the weekly capacity over the sprint adds up to what Flow says, within rounding; a holiday inside the sprint raises the figure instead of losing man-days.
`mdPerWeek = round2(5 x flowMd / workingDays)` (BigDecimal, `HALF_UP`), one capacity period per sprint (a period holds until the next one, so a gap between sprints keeps the previous figure; the weeks before a team's first imported sprint stay "no capacity"). Example: 40 MD over 10 working days is 20.00 a week; over 9 (one holiday) 22.22, and `weekCapacity` over those weeks sums back to 40.00.

**A hand-entered period is NEVER changed or removed by the import.** A sprint whose `effectiveFrom` already holds a manual period is `MANUAL_PERIOD` (left alone, shown with the figure it would have had); a manual period that starts INSIDE a sprint adds the info `MANUAL_PERIOD_INSIDE(date)`: the figure will not hold from that date. Only periods the import wrote (V24 `source = FLOW`) are updated or removed; a manual `PUT` on one makes it manual.

### The span and the days a sprint holds

The span and the days are Flow's own (`metrics.md` A42; `DeriveSprintStep`, `resolveSprintWindow`).

- `spanEndOf` is the ONE place the span rule lives: `spanEnd = endAt ?: completeAt`, the **planned end first**, a completion only for a missing planned end, so a sprint completed early keeps its planned days. `end = dayOf(max(startAt, spanEnd - 1 ms))` in the connection's zone: an end at local midnight adds no day, a zero-length sprint is one day.
- A sprint with a start and neither end, or an end BEFORE the start, is `NO_DATES` (Flow falls back to one day: a deliberate difference), yet it still HOLDS its start day (`sprintSpan`: `end ?: complete ?: start`).
- **A day belongs to the first sprint holding it:** the sprints within the 60-day cap first (lower start, then lower id), then the long ones. Every sprint with a start holds at least its start day; one with a usable end holds `[start, end]`, whatever its capacity or skip reason. A later in-cap sprint takes only the days no earlier sprint holds: `effectiveFrom = max(start, claimedEnd + 1 day)`, `claimedEnd` the latest day an earlier sprint holds, which may be a Saturday (a period may start on any date).
  In start order the days earlier sprints hold inside a sprint are a prefix of it, so `[effectiveFrom, end]` IS the set of days no earlier sprint holds.
- A Monday-to-Monday series has W = 11 for the first sprint and 10 for each next; two sprints that merely overlap both count. Only a sprint WHOLLY inside earlier ones (`effectiveFrom > end`) counts no day: `OVERLAPS`, as in Flow, and it advances nothing.
- **A sprint over Flow's 60-day calendar cap** (`FLOW_MAX_CALENDAR_DAYS`, more than 60 calendar days start to end) **claims LAST** (ledger F11). It gets no calendar, is listed with the info `LONG_WINDOW` (check its dates in Jira), is never ticked and never advances `claimedEnd`, so every sprint within the cap is planned as if it were absent.
- Its own claim is the days of `[start, end]` that no in-cap sprint and no earlier long-window sprint holds: not a prefix, so the kernel computes the gaps between the held intervals (`longClaims`). `effectiveFrom` is the first such day (possibly a weekend day), `workingDays` counts the working ones; no leftover day is `OVERLAPS`, no leftover working day `NO_WORKING_DAY`.
  **Its figure is partial:** `mdPerWeek` spreads Flow's total over ALL the leftover runs, but the row becomes ONE period that holds only until the next period starts, so once applied the weekly capacity does not sum to Flow's total; the row's info says so.
- The working days, the existing-period lookup, `MANUAL_PERIOD_INSIDE` and every removal rule use `effectiveFrom`, never the raw start.

### The plan

`CapacityImportKernels.plan(sprints, zone, calendar, today, existingPeriods, from, includeClosed)` is pure. Dates are the mirror's raw instants in the CONNECTION's zone, so a zone `PUT` takes effect at once. Per sprint, in start order (undated last), the first rule that fires:

| Step | Outcome |
|---|---|
| no start, no `endAt`/`completeAt`, or an end before the start | `SKIP` `NO_DATES` (asked first) |
| `capacityMd` null (Flow has none) | `SKIP` `NO_CAPACITY` |
| `effectiveFrom > end` (wholly inside earlier sprints: Flow counts no day for it) | `SKIP` `OVERLAPS` |
| no working day from `effectiveFrom` to `end` | `SKIP` `NO_WORKING_DAY` |
| figure beyond the man-day bounds of a period (`validateManDays`) | `SKIP` `OUT_OF_RANGE` |
| no ACTIVE period starts on `effectiveFrom` | `CREATE` |
| a `FLOW` period does, with another figure, sprint id or name | `UPDATE` (the WIP limit is kept: Flow has none) |
| a `FLOW` period does, equal | `UNCHANGED` |
| a `MANUAL` period does | `MANUAL_PERIOD` |

- Every sprint HOLDS its days for the sprints after it, whatever rule refused it (`NO_DATES`: only its start day; `OVERLAPS`: nothing; a long window: nothing for the in-cap sprints).
- **The figure's divisor is the days the sprint holds, except for a `TEAM_DEFAULT` or legacy `CONFIGURED` sprint** (Flow's `capacitySource` for the team's default figure, a fixed per-sprint total that claims do not reduce, ledger F12). Its `mdPerWeek = round2(5 x capacityMd / workingDays of its OWN window [start, end])`, while the period still starts at `effectiveFrom` and the row's `workingDays` still counts the days it holds.
  When the window has more working days than the row holds, the row carries the info `FIXED_FIGURE` with `days` = the window's working days (an optional nullable `days` on `CapacityInfo`).
- **A sprint with 0 man-days** (Flow's DEFAULT is 0 for a team without members) is planned like any other but never ticked, with the info `ZERO_CAPACITY`.
- The `ticked` flag: not closed, not zero-capacity, not a long window, and a CREATE or an UPDATE.

### Closed sprints and removals

- `from` (default: today in the connection's zone) is the first day the import is about. A sprint whose `end` is before it is closed: listed only with `includeClosed`, never ticked; overlaps are decided before the toggle hides anything.
- **`removals[]`** are the team's `FLOW` periods that no listed sprint reuses and that (a) belong to a sprint missing from the mirror's document and lie in the window (`date >= from`, or any date with `includeClosed`; a sprint older than `flow.sprintsSinceDays` leaves Flow's document and its history must not be offered for deletion), or (b) start inside `(effectiveFrom, end]` of a sprint the import covers (not closed, **not a long window**;
  CREATE, UPDATE or UNCHANGED), where they would cut the figure short (a re-dated sprint), or (c) belong to a LISTED sprint (closed or not, whatever its action or skip reason) without being the period its item reuses (a sprint moved, or one that now holds no day: its old period is stale).
- **A refused row keeps its own period:** a listed sprint that is `SKIP` but still holds days (`NO_CAPACITY`, `OUT_OF_RANGE`, `NO_WORKING_DAY`, `NO_DATES`) keeps the FLOW period at its own `effectiveFrom` (for `NO_DATES`, the one carrying its sprint id at its start day): Astrolabe keeps the last good figure rather than inviting its deletion when it cannot compute a new one. Its OTHER old FLOW periods are still offered. An `OVERLAPS` row (or any wholly-inside one) keeps nothing.
- A closed sprint hidden by the toggle is history: its periods are not offered; a MANUAL period never is. **A removal is never preselected** by a client.
- A Flow team that is not in the mirror (gone, or never mirrored) previews an EMPTY plan with `observedAt` null: nothing is removed on the strength of an absence. A disabled connection still previews (it reads the mirror, never Flow). A closed sprint, or a team's first import, leaves the weeks before it untouched; the last sprint's figure stays in force until the next import.

### The preview

`POST /integrations/flow/team-bindings/{id}/capacity-preview {from?, includeClosed?}` (`CapacityImportService.preview`) is ONE `READ ONLY REPEATABLE READ` snapshot of the binding and its connection's zone, the holiday calendar, the Flow team's mirrored sprints and the team's ACTIVE periods (`TeamCapacityService.importRowsOf`); the clock is injectable (`now`). It stores, locks, audits and sends NOTHING.

- Response: `{bindingId, teamId, observedAt, zone, from, includeClosed, totals{create, update, unchanged, skip, removals}, items[…], removals[…]}`. `from` is the RESOLVED date and `includeClosed` an echo, so the apply can send both back and re-run the kernel identically. `skip` counts `SKIP` and `MANUAL_PERIOD`; `mdPerWeek` is a number with at most two decimals; an item carries `start`, `end`, `effectiveFrom`, a removal its `flowSprintId`.
- The apply's UPDATE also rewrites `flow_sprint_id` (a period reused for another sprint).

### The apply

`POST …/team-bindings/{id}/capacity-import {from?, includeClosed, items[{sprintId, expected{action, effectiveFrom, mdPerWeek}}], removals[periodId]}` (`CapacityImportService.apply` → `TeamCapacityService.applyImport`; `CapacityApplyKernels` is the pure decision). The client sends what the person ticked, with the preview's echoed `from` and `includeClosed`.
The guard order is the preview's (binding `404` → `403` → body `400`); the body is bounded: ≤ 2,000 `items` and `removals`, each sprint and period at most once, `expected.action` only `CREATE` or `UPDATE`, a valid date and man-day figure. Then ONE transaction, team data, no plan lock, no revision:

1. `Teams.lockActiveForWrite` (the team is gone: `404`), then the guard AGAIN under the lock (`lockedIsActiveManager`: a manager cleared while the request waited is `403` and nothing is written).
2. The team's ACTIVE periods are re-read under the lock; the binding is re-read (a plain read, the row is not locked: an unlink committed before it is `404`, one committed after is not noticed); the Flow team and its sprints are read NOW in ONE statement (`FlowMirrorStore.teamSprintsOf`; a team no longer in the mirror re-plans as EMPTY: every row skipped).
3. `CapacityImportKernels.plan` runs again over those rows with the echoed `from` and `includeClosed` (today in the connection's zone when `from` is absent).
4. **Each requested item is written only when the re-computed plan lists its sprint as `CREATE` or `UPDATE` with the SAME `action`, `effectiveFrom` and `mdPerWeek` as `expected`**; otherwise it is skipped `CHANGED`. That covers a figure that moved in Flow, a sprint re-dated or gone, a row never in the plan and, the dangerous one, a start date a person took over meanwhile (`MANUAL_PERIOD`). An UPDATE rewrites the plan's `existing` period, never an id from the request.
5. **A removal is applied only when its period is one of the re-computed plan's `removals`** (a Flow-sourced period); a MANUAL period, a period deleted meanwhile and an unknown id are skipped `CHANGED`.
6. **A MANUAL period is never written by any path:** not as an item (a forged `CREATE`/`UPDATE` for the sprint whose start it holds is `CHANGED`), not as a removal; `applyImport` re-checks every write against the locked rows and in each statement's `WHERE` (`persistence.md`).
7. Writes, in this order: removals (soft delete), updates (`md_per_week`, `flow_sprint_id`, `flow_sprint_name`, `updated_at`; the WIP limit is KEPT), creates (`insertRows`, `source = FLOW`).

- **What `expected` does not cover:** a MANUAL period entered INSIDE a sprint's span after the preview. The CREATE or UPDATE still applies and the manual period cuts the figure short from its date, as `MANUAL_PERIOD_INSIDE` warned.
- Response `200 {created[{periodId, sprintId}], updated[{periodId, sprintId}], deleted[periodId], skipped[{sprintId|null, periodId|null, reason}]}`: a skipped row is data; the only reason is `CHANGED`. The same body sent twice writes once; a re-import right after is all `UNCHANGED`.
- Audits (`observability.md`): ONE `team.capacity_imported` plus `team.capacity_period_created/updated/deleted` per period with `sourceTo`/`sourceFrom` = `FLOW`. A manual `PUT` on a `FLOW` period makes it `MANUAL` and clears the sprint fields (V24).

Pinned by: `CapacityImportKernelsTest` (hand-counted vectors; `spanEndOf` has one per rule), `CapacityImportPreviewTest` (the stub's E2E Flow Team equals `expected.json`: 20/18/22/20/19/21 MD a week; a holiday inside a sprint gives 9 working days and 22.22), `CapacityImportApplyTest`, `CapacityImportApplyRaceTest`, `TeamViewTest`.

## Deviations

Per bound team and per current-or-future sprint, where the plan's capacity differs from what Flow would make it carry. Nothing is stored (but acknowledgements) and nothing is written to Flow. Files: `flow/CapacityDeviation.kt`, `CapacityDeviationKernels.kt`, `CapacityDeviationService.kt`, `CapacityDeviationRoutes.kt`, `FlowFlagSource.kt`.

The vocabulary is `flow/`'s own (a Jira deviation is a binding on a plan node, `jira/DeviationView.kt`, and `jira/` and `flow/` may not name each other). Only `planning.DeviationSeverity`, `CapacityPeriod` and `capacityOn` (the team view's capacity-in-force rule, so the deviation compares what the team view shows) are imported from `planning` (`PackageBoundaryTest`).

### The kinds

| Kind | Rule | Severity | Silent |
|---|---|---|---|
| `CAPACITY_DIFFERS` | `abs(planMd - flowMd) >= 0.50` on the two figures rounded to two decimals (`CAPACITY_DEVIATION_THRESHOLD_MD`), over the days the sprint holds | WARNING when the plan has MORE (`gapMd > 0`), INFO when less | a gap below 0.50 |
| `CAPACITY_MISSING` | no period in force on ANY working day of the sprint's held days (`planMd` and `gapMd` null) | INFO | when Flow's figure is 0 too; a partly covered sprint is a `CAPACITY_DIFFERS` (uncovered days count 0, as in the team view) |
| `TEAM_GONE` | the bound Flow team is no longer in the document (`gone` as the panel derives it); the ONLY row of the team, every detail member null | WARNING | a never-mirrored connection, a truncated document |

**Which sprints.** The kernel takes the import's own plan (`CapacityImportKernels.plan(..., from = null, includeClosed = false)`): windows, held days and figures are the import's. Current or future = `end >= today` in the connection's zone.

- **Silent:** every `SKIP` row (`NO_DATES`, `NO_CAPACITY`, `OVERLAPS`, `NO_WORKING_DAY`, `OUT_OF_RANGE`: no comparable figure; the preview lists the reason) and every `LONG_WINDOW` row (a partial figure the import never ticks).
- **Compared like any other:** `MANUAL_PERIOD` rows (the point of the feature) and `ZERO_CAPACITY` ones (plan 20 a week against Flow's 0 is a WARNING; a plan on hold at 0 is nothing).

**The arithmetic (like with like).** Over the days the sprint holds, `[effectiveFrom, end]`, `W` being its working days:

- `flowMd = round2(mdPerWeek x W / 5)` (HALF_UP): what the import would make the plan carry over those days. For a CALENDAR or DEFAULT sprint it is Flow's own `capacityMd` within 0.06. For a `TEAM_DEFAULT` sprint sharing a day (`FIXED_FIGURE`, `W_own > W`) it is the pro-rated share, exactly what the import writes; the raw total would raise a false INFO on every such sprint (ledger F12). `flowTotalMd` carries Flow's raw `capacityMd` beside it.
- `planMd` is the team view's arithmetic over the same days (`weekCapacity`, `planning/LoadKernels.kt`): each held working day contributes `capacityOn(day) / 5` at scale 6 (a day before the first period contributes 0), the sum rounded ONCE to two decimals, HALF_UP. `gapMd = planMd - flowMd`; both sides are rounded before the comparison, so what is shown is what is flagged. The result is ordered by `effectiveFrom`, then sprint id.
- Both sides read the same calendar, so a holiday never raises a deviation by itself. A holiday ADDED after an import lowers `planMd` while `flowMd` re-spreads: an INFO that a re-import clears; a holiday removed is the mirror image (a WARNING).

Pinned by: `CapacityDeviationKernelsTest` (hand-counted vectors), `CapacityDeviationFingerprintTest`.

### The view

`GET /views/capacity-deviations`, any authenticated user. `CapacityDeviationService.view(filter)` reads ONE `READ ONLY REPEATABLE READ` snapshot (the preview's protocol; no lock, write or audit, **no `revision`**: capacity periods are team data), in this order: the holiday calendar (`loadWorkingCalendar`); every ACTIVE Flow connection (the scheduler's eight poll columns plus `time_zone`, by lowercase name then id, at most `MAX_PANEL_CONNECTIONS` = 100) with its status from `SyncRunService.statusesInTransaction`;
the ACTIVE bindings of ACTIVE teams (`activeBindingsWithTeams`); the periods of every bound team (`importRowsOfTeams`); per binding the Flow team and its sprints (`FlowMirrorStore.teamSprintsOf`, one statement).

- Absent from the mirror: the connection's `teamsAt` null = never mirrored, no item; else `TEAM_GONE`. Otherwise `today` is the injected clock in the CONNECTION's zone and the kernel decides; `asOf` is the UTC date of the same instant.
- The document is `{asOf, connections[], totals{warnings, infos, gone, acknowledged, teams}, items[], truncated}`. Each item: `bindingId, connectionId, team{id, name}, flowTeam{id, name}`, `observedAt` (null when gone), `zone` (the connection's IANA id: the only registry detail on the wire), `can{acknowledge}`, `deviations[]`. Man-day figures are JSON numbers (two decimals).
- **Filters** `connectionId`, `teamId`, `severity`, `kind`, `acknowledged`, `all` (`optionalUInt`/`optionalEnum`/`optionalBoolean`: a repeated or malformed key is a `400`). **`severity` and `kind` narrow the ROWS of a team, not only the team** (the unit is a sprint). `connectionId` narrows the connections too, `teamId` does not. Order: a team with an OPEN WARNING first, then team name (lowercase), then binding id.
- **The listing rule is the Jira deviations view's, over rows** (`jira-sync.md` "Acknowledge"): the default lists the OPEN rows (no CURRENT acknowledgement), so a team whose rows are all acknowledged is not listed; `acknowledged=true` / `false` lists the acknowledged / open rows; `all=true`, or `teamId` (unless `all=false`), lists both, `acknowledgement.current` telling them apart. There are no "clean" rows: a sprint in line is no deviation.
- **`totals` are on the Jira basis, before the cap:** `warnings`/`infos`/`gone` count the OPEN rows and `acknowledged` the CURRENT ones, over every row matching `connectionId`/`teamId`/`severity`/`kind` but NOT the acknowledgement state (so "N open" survives `acknowledged=true`); `teams` is the number of teams the list answers (it can exceed `items.length`). The cap is `MAX_CAPACITY_DEVIATION_ITEMS` = 1,000 teams with `truncated`.
- A DISABLED connection's teams are listed; a FAILED or STALE one's are computed from its last mirrored document and the status qualifies them.
- **No validator:** no `ETag`/`304`, for the same reason as `GET /views/deviations` (each connection's `status.nextPollAt` is the read's own instant while a poll is due; `planning-model.md` "View validators").

Pinned by: `CapacityDeviationViewTest`.

### Acknowledge

A manager who KEEPS a hand-entered figure against Flow's (a `MANUAL_PERIOD` row, or a `ZERO_CAPACITY` sprint carried by an earlier period) acknowledges THAT sprint's row: "known, leave it". **Per sprint, not per binding:** the horizon is rolling, so a per-binding fingerprint would reopen the team every time a sprint closes. The key is (binding, Flow sprint id); a closing sprint leaves the list and reopens nothing, a new sprint arrives open.

Stored in V26 `flow_capacity_acknowledgements` (`persistence.md`), written by `CapacityAcknowledgeService` (`POST|DELETE …/team-bindings/{id}/acknowledge`; no plan lock, no revision, no rate bucket). Files: `flow/CapacityAcknowledge*.kt`.

#### The stamp

- `TEAM_GONE` is acknowledgeable as the team's own row, `sprintId: null` (`sprint_id NULL`, `UNIQUE … NULLS NOT DISTINCT`; the DELETE names it by omitting `sprintId`). Rows are hard: an un-acknowledge deletes, a re-acknowledge rewrites the stamp.
- **The fingerprint** is `capacityFingerprint` = the shared `fingerprintOf` (`infra/json/CanonicalJson.kt`) over `{kind, severity, detail}` with the sprint's NAME left out: any change of the sprint's dates, held days, working days, either figure, the gap or the severity reopens it; a rename in Flow does not. **A later release that changes a kernel rule or the detail's figures un-acknowledges everything:** by design, stated in its notes.
- A row carries `fingerprint` and `acknowledgement{at, by, current}` (null until stamped; `current` false = acknowledged, then the figures changed: the row is OPEN again). `by` is the person's name else the login's display name, never an email (`planning.creatorsOf`). Each item's `can{acknowledge}` is ADMIN or the team's ACTIVE manager (the route resolves the caller's managed teams once through `activeManagedTeamIds`, not for an ADMIN, into a `CapacityDeviationActor`); a hint, the write's guard decides.
- **The write** is the Jira acknowledge's protocol with the import's guard: the binding row `FOR NO KEY UPDATE` (`lockActiveForWrite`, gone `404`); the binding re-read with its team ACTIVE (`404`); the guard AGAIN (`teams::lockedIsActiveManager`: team and person `FOR SHARE`, `403`); the binding's rows RECOMPUTED inside the write (`computeBindingInTransaction`); the named row (`detail.sprintId == sprintId`, null = `TEAM_GONE`) absent or with another fingerprint = `409` `stale-deviations` (`sync.md` "The acknowledge vocabulary");
  then UPDATE-then-INSERT, exact because every acknowledge of the binding queues behind its row lock (`uq_flow_capacity_acks_key` is the backstop). A connection that never mirrored has no row (`409`); a DISABLED connection's rows are acknowledgeable.
- The body is `{sprintId, fingerprint}` with `sprintId` REQUIRED (nullable) so a client bug never acknowledges the team by accident; the `200` is `CapacityAcknowledgement{bindingId, sprintId, fingerprint, acknowledgedAt, acknowledgedBy}`. Audited `flow.capacity_deviation_acknowledged` / `…_unacknowledged` (`observability.md`).

#### The lifetime of an acknowledgement

**An acknowledgement lives only while its row is LISTED,** so a difference that returns is open. A row that is in line, closed, skipped or no longer in Flow's document loses its acknowledgement; so does the team's own `TEAM_GONE` row once the team is back (its fingerprint is constant, so a kept row would silence the NEXT disappearance). An unlinked binding's rows and a deleted team's go too, and a deleted connection takes every row of its bindings with it (`acknowledgementsDeleted` on `flow.connection_deleted`).
A STALE acknowledgement (its row still listed, the figures moved) stays and reads `current = false`.

**Where it runs:** (1) the run's mirror replace, connection-wide, in the replace's own transaction after `teams_at` is stamped (`FlowMirrorStore.replace`'s `afterWrite`, filled by `FlowObserver` with `pruneConnectionInTransaction`); (2) `acknowledge`, for its binding, after the two `409` checks and before the stamp; (3) a plan-side capacity write (below); (4) the connection delete.

**The predicate, per binding that has stored rows** (the prune recomputes the binding's rows with the view's own computation on the new mirror):

- An unlinked binding or one of a deleted team loses every row. An active binding of an active team keeps the rows whose key is one of its LISTED rows (`detail.sprintId`) and loses every other one, the NULL-sprint row included.
- A team still ABSENT from the document (its one `TEAM_GONE` row) keeps everything: nothing can be judged while it is gone. So does a computation that answers null (nothing to compare).
- **A document with `sprintsTruncated` judges no SPRINT key** (the 2,000-sprint cap is per document, across ALL teams, so any sprint missing from it was merely not sent). It still prunes what does not depend on sprints: the NULL-sprint row of a present team and every row of an unlinked binding or a dead team. A COMPLETE document that lists a team with zero sprints clears that team's sprint rows.
- **The acknowledge's own prune never judges "gone from the document"** (only the run knows the document's truncation): it deletes only rows whose sprint is STILL IN THE MIRROR but unlisted, plus the NULL row of a present team. A sprint merely missing from the mirror waits for the next complete run.
- A binding whose deviations cannot be computed (a NON-database failure) keeps its rows and logs a WARN naming it (`sync.md` "Log lines"); a database error fails the run and the replace rolls back.
- **Known limitation:** the FIRST acknowledgement of a binding racing the run that un-lists that row (the run's candidate read saw no stored row, so it takes no lock) can leave one unlisted row until the next sweep.

Audit: `flow.capacity_acknowledgements_cleared`, one per binding that lost rows, after the commit, `via` = `run`, `acknowledge` or `capacity` (`observability.md`).

#### The capacity write's prune

A sprint brought in line by a plan-side edit (`POST /teams/{id}/capacity`, a changed `PUT`, a `DELETE /capacity-periods/{id}`, or the import's apply that wrote a period) loses its acknowledgement at once, so the same difference put back is OPEN.

- **The seam:** `teams/TeamCapacityListeners.kt` (`CapacityWriteListeners`, published empty by `configureDatabase` under `CapacityWriteListenersKey` and handed to `TeamCapacityService`); `configureFlow` registers `lockBindingsBeforeCapacityWrite` / `pruneInCapacityWrite`, so `teams/` names nothing of `flow/`.
- **The prune runs INSIDE the write,** in ONE transaction, in this order: (1) `lockBeforeTeam`: the team's ACTIVE binding row(s) `FOR NO KEY UPDATE`, taken whether or not the binding has stored rows (an acknowledge in flight could be about to store one) and before anything else; (2) the team row `FOR NO KEY UPDATE`; (3) the guard's second run; (4) the period writes; (5) `settle`.
- **`settle`** (`pruneInCapacityWrite`) is limited to the binding ids step (1) answered (a binding linked meanwhile is left alone) and runs only for a write that CHANGED a period (a same-values `PUT` and an all-skipped apply settle nothing). It reads the team's ACTIVE binding that HAS stored rows (none: nothing computed), `computeBindingInTransaction` (it sees the write's own uncommitted periods; null = keep everything; a NON-database failure keeps the rows and logs a WARN, a database error aborts the write), then `pruneUnlisted` UNCHANGED.
  The deletes commit WITH the write and roll back with it. It has no guard of its own: the write's guard is the acknowledge's, so nobody clears what they could not withdraw.
- **The audit** is queued on the caller's `CapacityWriteTrail`; the ROUTES (`teams/TeamCapacityRoutes.kt`, `flow/CapacityImportRoutes.kt`) tell the trail AFTER the commit and the write's own audit line and BEFORE the response (the page re-reads the deviations right after). A queued action's failure is one WARN naming only the exception class; the write stands. The line carries `via=capacity` and the writer's `byUserId`.
- **What stays open:** the holiday dictionary and a connection's time zone also feed the comparison and notify nobody (a `BACKLOG.md` item).

**Lock order (one for everyone):** the connection row, the binding row, the team row, the manager and person rows, the acknowledgement rows. Every write of a binding's acknowledgement rows holds that binding's row lock.

- The acknowledge, the withdrawal, the unlink and every capacity write are binding-first. The link takes its own team's binding rows before its team `FOR SHARE` (otherwise it would hold a team lock that a capacity write, holding that binding, waits for). Nobody takes a team row and then THAT team's binding row; the link does take OTHER teams' holder bindings after its own team share, safe because the capacity write holding one waits for that other team's row, which the link does not hold.
- The run's prune is connection-first: the connection row (the replace), then the binding rows `FOR NO KEY UPDATE` in id order (only bindings that HAVE stored rows), then the acknowledgement rows, one `DELETE`; the connection delete follows the same order. The binding-first writers never take the connection row, so nobody goes binding to connection.

#### Acknowledge all and withdraw all

- **`POST …/team-bindings/{id}/acknowledge-all`** takes `{items[1..2,000]}` of the single acknowledge's `{sprintId, fingerprint}` (2,000 = `FLOW_SPRINT_CAP`): the rows the client lists as open, with the fingerprints it read. **All or nothing:** in ONE transaction the binding row is locked once, the guard run again, the rows recomputed once; any named row not listed now or with another fingerprint is the shared `409 stale-deviations` with nothing stored. A key named twice is a `400`.
  Only the NAMED rows are written, with ONE stamp and ONE login (delete-then-one-multi-row-insert), answer `200 {acknowledged[]}` in the request's order. The acknowledge's prune applies once, after the checks. Audit: `flow.capacity_deviations_acknowledged` (the batch), the single write's line per row, then the cleared line.
- **`POST …/team-bindings/{id}/unacknowledge-all`** (a sibling `POST`, not a `DELETE` with a body) takes `{items[1..2,000]}` of `{sprintId: integer|null}` (`null` = the `TEAM_GONE` row; no fingerprint: a withdrawal compares nothing), the rows the list SHOWS as acknowledged. No row twice (`400`). Guard, order and lock are acknowledge-all's.
  **All or nothing:** a named row with no stored acknowledgement is `409 stale-deviations` (the first offending row in request order) and nothing is deleted; otherwise the keys are deleted in one statement (current or stale alike) and the answer is `204`. Nothing is recomputed or pruned. Audit: `flow.capacity_deviations_unacknowledged`, then the single withdrawal's line per row.

Pinned by: `CapacityDeviationAckViewTest`, `CapacityAcknowledgeTest`, `CapacityAcknowledgeAllTest`, `CapacityUnacknowledgeAllTest`, `CapacityAcknowledgePruneTest`, `CapacityAcknowledgeRaceTest`, `FlowMirrorStoreTest` (`afterWrite` is in the transaction), `TeamCapacityTest`, `CapacityImportApplyTest`.

### The team view's flag

`GET /views/team/{id}` reads the team's capacity deviation through `planning`'s flag seam (`ExternalFlagSource`: `planning-model.md` "The roadmap view"; the Jira flags: `jira-sync.md` "Timeline flags"). `flow/FlowFlagSource` implements it over `computeTeamInTransaction`, INSIDE the view's snapshot with the view's calendar, so the flag equals the Deviations page's open rows for the same state. The composition root (`infra/db/Database.kt`) hands the four views a `CompositeExternalFlagSource([Jira, Flow])`.

- **What flags:** the OPEN rows (a CURRENT acknowledgement silences a row; a stale one flags again) of an ENABLED connection (a DISABLED one raises nothing, the Jira rule; the Deviations page still lists its rows).
- ONE `FLOW_CAPACITY` roll-up flag on `team.flags[]` at the WORST severity of those rows with `count` = how many (a `CAPACITY_MISSING` row counts as an INFO row; a `TEAM_GONE` row as a WARNING with no days).
- One day range `[effectiveFrom, end]` per row at the row's severity, which marks `weeks[].flowCapacity` on every week it touches (the worst severity of the rows meeting the week; `@EncodeDefault(NEVER)`: absent on an unmarked week and on a schedule proposal's or a check's weeks).
- An unlinked team, a connection that never mirrored and a team with no open row answer `flags: []`. A disputed sprint outside the load window counts in the header and marks no week.

Pinned by: `FlowFlagSourceTest`, `CompositeExternalFlagSourceTest`, `ExternalFlagsTest`, `TeamViewFlowFlagTest`.

### The project rows' flag

`GET /views/roadmap` and `GET /views/programs` (and Home, which reuses their loader) ask the same seam with `ExternalFlagRequest.everyTeam`, and `FlowFlagSource` answers the `TeamExternal` (the roll-up flag and the day ranges, folded by ONE private function the single-team path uses too) of EVERY team that has an open row through an ENABLED connection.

- `planning` cannot know which project's milestone sits in which sprint of which team's dispute and `flow/` may not learn it, so the roll-up is `planning`'s pure `RoadmapKernels.capacityFlags` (`planning-model.md` "The roadmap view"). A project gets ONE `FLOW_CAPACITY_MILESTONES` flag per team: `teamId`, `count` = its SCHEDULED milestones on that team sharing a calendar day with an open range (both ends inclusive); WARNING when the plan holds more capacity than Flow in such a sprint, INFO otherwise, the worst among the ranges met.
- **Raises nothing:** an acknowledged row (a stale one flags again), a DISABLED connection, a `TEAM_GONE` row (no days), a team that never mirrored, an unscheduled milestone, a team the project has no milestone on.
- **The read** is `computeEveryTeamInTransaction(calendar)`, the single path's logic over many teams in at most FIVE statements whatever the number of teams, inside the view's snapshot: the ACTIVE connections (only the ENABLED kept; with none the answer is empty at once); their ACTIVE bindings of ACTIVE teams; those teams' periods; the bound Flow teams with their sprints in ONE statement (`FlowMirrorStore.teamsSprintsOf`: `teamSprintsOf`'s LEFT JOIN and sprint order, the exact pairs kept in memory); the stored acknowledgements (`storedOf`;
  the acknowledging logins' names are NOT read). The arithmetic (`computeFrom`) is one function both paths use.
- Home reads its managed teams' `flags` from the same answer (`RoadmapSnapshot.teamFlags`). No "Flow data may be out of date" note sits beside the flag (a `BACKLOG.md` line).

Pinned by: `FlowFlagSourceTest` (the every-team answer equals the single-team answer, team by team, in every state), `RoadmapFlowFlagTest`.

## The Flow stub

A deterministic WireMock stand-in for Flow's two endpoints, so the whole feature is proven without a real Flow. `sample-data/flow/README.md` holds the dataset, the credential, the scenarios and every planted case; `expected.json` every figure. The ports and their carriers (compose, Kubernetes, the pinned WireMock image) are `ci.md` "Running the full stack".

- **The generator and the one producer.** `node sample-data/flow/generate.mjs [--seed 42]` (Node >= 24, zero dependencies, seeded, no clock) writes `sample-data/flow-stub/{mappings,__files}` and `sample-data/flow/expected.json` from `sample-data/plan/teams.json`. **`contract.mjs` is the only producer of the stub's documents** (paths, `sprintsSince`, the token grammar, the 401 body, every field name); `world.mjs` builds the dataset, `mappings.mjs` the WireMock mappings, `expected.mjs` the figures.
- `node --test sample-data/flow/generate.test.mjs` runs in `scripts/gates.sh e2e_static` and CI `e2e-static` (which also diffs a fresh generation). A generator change ships with the regenerated files.
- **The credential** is ONE public, obviously fake token that satisfies the grammar: `flow_int_stub-stub-stub-stub-stub-stub-stub-stub-stu` (also `expected.json` `contract.token`). Any other credential, a malformed header, an unknown path or ANY non-GET method under `/api/v1/integration/` is the uniform `401`.
- **The world** (19 teams, 523 sprints, 120 membership rows, one document of about 132 KB; `asOf` Thursday 2026-10-29, `sprintsSince` fixed at 2025-10-27 whatever the request says; every sprint two weeks, Monday 09:00 to the second Friday 17:00 on Europe/Warsaw's clock): the 15 sample-plan teams with 33 sprints each ("Design Systems" is spelled **"Design System"**, planted: no name suggestion, so 14 of the 15 match), **"E2E Flow Team"** (the e2e spec's team, dated **2047**:
  six sprints from Monday 2047-01-07, `capacityMd` 40 / 36 / 44 / 40 / 38 / 42 = **20 / 18 / 22 / 20 / 19 / 21 MD a week** over 10 working days), "Axe Flow Team" (the accessibility scans), "Legacy Mainframe" (dated sprints with `capacityMd: null`: SYNTHETIC, Flow never emits that for a dated sprint, a robustness case) and "Empty Team". Member names are "Stub <Greek letter> <ordinal>", never a real person.
- **Planted cases:** the boundary pair on "Identity" (sprint 31 ends on the Monday, 10:00, sprint 32 starts on: the import gives the shared day to 31, W 11 and 9); "Support Tooling" (a sprint wholly inside another: `OVERLAPS`); "Analytics" (an undated sprint: `NO_DATES`); "Mobile" (a `DEFAULT`-sourced capacity); "Web Frontend" (a membership with `displayName: null`).
- **Scenarios** (both start at `Started`; `curl -X PUT http://localhost:8097/__admin/scenarios/<name>/state -d '{"state":"<state>"}'`, back with `Started` or `POST /__admin/scenarios/reset`): **`flow-day2`** (state `day2`) answers a second document a day later in which "Billing" has vanished and Platform's and the E2E Flow Team's future capacities have changed (`expected.json` `day2`); **`flow-outage`** (state `down`) answers `500` on both endpoints for any WELL-FORMED bearer (Flow checks the shape before the database, so an outage is never a `401`).
- **Port.** Host port **8097** (compose `flow-stub`, `FLOW_INSECURE_ORIGINS=http://flow-stub:8080`).
- **In the server suite.** `FlowStubServer` (an instance of the shared `StubServer`, a dynamic port, a 50-entry journal) serves the SAME files; `FlowStubFixture.warm()` in a `@BeforeClass` (`StubWarmupGuardTest` fails a class that forgets); a test that flips a scenario `resetScenarios()` in a `finally`. `FlowStubFixtureTest` replays the contract over HTTP against `expected.json`. Details: `test-fixtures.md` "The Flow stub fixture".

## First real-Flow walk-through

Do this against a real Flow 1.57.0 or later. Settle each ledger row it names (and edit `contract.mjs` / `FlowDocument.kt` if one is wrong). The stub proves the code against the contract as WRITTEN; this proves the contract. Nothing of a real installation (names, keys, figures, URLs) is written into this doc.

1. **In Flow** (an isolated stack, or the dev stack with the user's approval and a backup: creating a token writes to Flow's database): Administration, Service tokens, create "astrolabe", copy the secret once.
2. **Tell Astrolabe where Flow is** (operator configuration; the connection can only name a listed origin).
   - Compose: start Flow's own compose stack, then `docker compose -f docker-compose.yaml -f docker-compose.real-flow.yaml up --build`. The override joins the external network `flow_default`, lists `http://flow-app:8084` beside the stub, and points `POSTGRES_*_URL`, `SMTP_HOST` and `JIRA_STUB_BASE_URL` at the `astrolabe-*` container names (Flow's compose defines the same bare names on that network).
   - `http://host.docker.internal:8084` and `http://localhost:8084` do NOT work from the app container (`localhost` is the container itself; on OrbStack `host.docker.internal` resolves inside the never-allowed `0.0.0.0/8`).
   - Kubernetes: add `http://app.flow.svc.cluster.local:8084` to `FLOW_INSECURE_ORIGINS` in `k8s/local/front-door.yaml` and apply `k8s/local/flow-egress.yaml` (the base egress excludes private ranges).
   - A TLS Flow behind a private CA uses `FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE` instead and leaves the insecure list empty. Production never reaches a plain-http Flow (boot refuses it).
3. **New connection** (Administration, Flow): the canonical origin (no default port, no trailing slash), the token and **Flow's metrics time zone** (F8), then Test connection: `me` green proves the token, `teams` green proves the document decodes (F1); a `404` means Flow is older than 1.57.0, a `401` a wrong or revoked token.
4. **Refresh now**, then compare the Teams section with Flow's Teams page: names, member counts, sprint counts inside the last `flow.sprintsSinceDays`. Neither truncation flag should be set (a WARN on `ch.nokillswit.sync` otherwise).
5. **Link ONE team** (by name if suggested) and read the roster against Flow's membership page: names, the intervals, and that a member Flow ended today reads "former" (F9).
6. **Import capacity on a THROWAWAY Astrolabe team first** (bind it explicitly). Read every preview row against Flow's sprint calendar BEFORE pressing Import (assert before verify writes): `capacityMd` (F2), the start and end dates in the chosen zone (F3: an end at local midnight adds no day; consecutive sprints share their boundary day and the earlier one keeps it), the working days (a public holiday inside a sprint raises the MD/week) and `mdPerWeek = round2(5 x md / W)`.
   Then apply; check the team page's weekly capacity sums back to the sprint's man-days; re-preview: every row `UNCHANGED`; edit one period by hand: it turns manual and the next preview lists it `MANUAL_PERIOD`. Then open the Deviations page's capacity section for the same team: every row matches its preview row (F13).
7. **Leave it polling for a day:** CURRENT, one call an hour. Revoke the token in Flow: FAILED `AUTHENTICATION_FAILED` within an interval (F4); issue a new one and `PUT` it: the connection is due at once.
8. **When something fails:** the run row's `errorCode`; the `ch.nokillswit.sync` lines; the `flow.connection_tested` / `flow.sync_requested` audit events; `outbound.blocked` (an unlisted origin, or one that resolved to a refused address).

## Assumptions ledger

"Stub only" means NOT verified against a real Flow. The walk-through settles each row; until then a wrong one shows as the symptom in the last column.

| # | Assumed | What proves it | What breaks if false |
|---|---|---|---|
| F1 | The document's field names and types equal Flow's contract. The decoder is strict on lists and flags (`items`, `members`, `sprints`, `sprintsSince`, `teamsTruncated`, `sprintsTruncated`, `hasCalendar`: an absent one is drift, never "empty" or "false") and lenient on nullable scalars | Flow's source; `FlowStubFixtureTest`; step 3 | `INVALID_RESPONSE` on a missing required member; the `teams` probe row |
| F2 | `capacityMd` is a TOTAL for the sprint whatever its `capacitySource` (`CALENDAR`, `TEAM_DEFAULT`, `DEFAULT`, the pre-V24 `CONFIGURED`): no fallback arithmetic here; `null` = no capacity (`NO_CAPACITY`), 0 = Flow's default for a team without members (`ZERO_CAPACITY`). Flow never emits null for a DATED sprint | Flow's `DeriveSprintStep`, stub only; step 6 | the preview's figures vs Flow's sprint calendar |
| F3 | A sprint's window is Flow's own (`metrics.md` A42; "The span and the days a sprint holds"). The one deliberate difference: `NO_DATES` instead of Flow's one-day fallback | Flow's source; hand-counted vectors (`spanEndOf`, one per rule) and the stub's Identity pair; step 6 | the preview's `start`, `end`, `effectiveFrom`, `workingDays`; a Monday-to-Monday series reads W 11, 10, 10 |
| F4 | The uniform `401` is `application/problem+json`; only the STATUS is used and every authentication failure (revoked, expired, unknown, malformed) is the same answer | Stub only; step 7 | `AUTHENTICATION_FAILED` on a run or a probe; a 500 is an outage, never a 401 |
| F5 | Flow's team names fit 100 characters and are unique among its active teams. The mirror FITS a row regardless (text cut to the column, control characters to spaces, a repeated key collapsed to the first), so one odd team never fails every later run | Stub only | a cut name in the Teams section; no suggestion for a duplicated name |
| F6 | One document per poll stays under the response cap, 1 MiB (`flow.maxResponseBytes`) with 1-2 concurrent requests, at the plan's scale (the stub's 19 teams and 523 sprints are about 132 KB) | Stub only; step 4 | `LIMIT_EXCEEDED` on a run or the `teams` probe; shrink `sprintsSinceDays` before touching the cap |
| F7 | Flow caps a document at 1,000 teams and sets `teamsTruncated`; a team absent from such a document still exists (the run WARNs, replaces only the teams the document carries, keeps every other whole, counts `gone` 0) | `FlowRunWireTest` (three documents); Flow's source | the WARN; a team really removed from Flow stays mirrored while Flow keeps truncating |
| F8 | The connection's time zone is Flow's metrics zone (the editor pre-fills Europe/Warsaw): sprint and membership instants become dates in it | Operator-set per connection; step 6 | a shifted sprint start or end, so other working days; the panel's "since" dates |
| F9 | A membership is half-open, `[validFrom, validTo)`, `validTo` the first instant that is NOT a member (Flow's "End membership" sets it to the start of today); `displayName` may be null ("Unknown account") | Flow's source, stub only; step 5 | the roster's current/former split |
| F10 | The parsed-tree heap figure (112 B a node, one node per 8 wire bytes) is the Jira transport's, not re-measured for Flow | Unmeasured (`security.md` "The heap arithmetic") | an OOM under a large document |
| F11 | A sprint over Flow's 60-day calendar cap gets no calendar and carries Flow's DEFAULT total over its days; in Flow's order it claims LAST | Flow's source; the kernel vector "a mistyped far end claims last" (invented figures) | the later sprints of that team lose their days to it (`OVERLAPS`) |
| F12 | A `TEAM_DEFAULT` sprint (legacy `CONFIGURED` alike) carries a FIXED per-sprint total that claims do not reduce, while CALENDAR and DEFAULT totals already exclude the days an earlier sprint holds: its weekly figure spreads the total over its OWN window and the row says `FIXED_FIGURE` | Flow's `sprintCapacity` documentation; vectors (40 MD over 11-09..11-20 after a 11-02..11-13 sprint is 20.00, not 40.00) | the preview's `mdPerWeek` for a `TEAM_DEFAULT` sprint vs Flow's per-day figure; a false INFO per shared-day sprint |
| F13 | The capacity deviation's figures equal the import preview's: the deviation takes the import's own plan | `CapacityDeviationKernelsTest`, `CapacityDeviationViewTest`; step 6 | a deviation row that disagrees with its preview row; a team imported under an older rule is offered a ticked UPDATE by the preview |

F11's second limit: the mirror only holds sprints with `endAt >= sprintsSince`, so in-cap sprints that ended earlier inside a long window are unknown to the kernel and the long row's leftover divisor can exceed Flow's (the row is unticked anyway).
