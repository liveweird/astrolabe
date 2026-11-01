### Planning model

The binding reference for the planning domain as it is built (v0.2.0: people, permissions and dates, the plan structure, the roadmap ranking; v0.3.0: milestones; v0.4.0: dependencies; v0.5.0: team capacity periods, the team milestone order). The product intent and the user's domain
decisions are in `product.md`; the parts not built yet stay a **sketch** at the end (the v0.5+ increments confirm or amend each line and rewrite it here when
their migration lands).

## Conventions every planning table follows

SERIAL ids (unsigned `UIntIdTable` in Kotlin), epoch-millis `BIGINT` `created_at`/`updated_at`, `SoftDeletable` (`marked_as_deleted`), partial unique indexes over ACTIVE rows, one migration + checksum
pin per change (`persistence.md`, `conventions.md`), `DATE` columns through `infra/db/LocalDateColumn.kt`, wire dates ISO `YYYY-MM-DD` strings. Names are trimmed single-line text (control characters are
a 400), 1-100 characters; descriptions optional, at most 500.

## People (built — V10, v0.2.0)

- **Table `people`** (`people/PersonService.kt`, `SoftDeletable`): `id SERIAL`, `name VARCHAR(100) NOT NULL`, `email VARCHAR(254) NULL`, `user_id BIGINT NULL REFERENCES users(id)`,
  epoch-millis `created_at`/`updated_at`, `marked_as_deleted`. A person is NOT a login: `user_id` links the optional account (an external owner has none).
- **Constraints** (partial, active rows only, the V6 shape): `uq_people_email_active ON (LOWER(email)) WHERE email IS NOT NULL` (an optional email, unique when set) and
  `uq_people_user_id_active ON (user_id) WHERE user_id IS NOT NULL` (one active person per login). Names are NOT unique (two real "Anna Nowak"s). `409` wording lives in `ErrorHandling.kt`.
- **The link** (§ person-to-user): set by an ADMIN through `userId` on the person create/update bodies; must be an ACTIVE user (`400`), not linked to another active person (`409`). A soft-deleted
  user leaves the person and the link in place, inert (reads resolve the login through ACTIVE users and show it as unlinked; the caller's person is `people.user_id = caller AND people.active()`).
  Name and email edits never cascade between the user and the person — they are separate records, and the person's name is the display name on the plan. `person.link_changed` is audited only on change.
- **Teams**: `teams.manager_person_id` replaced `manager_user_id` (V10 backfilled one person per ACTIVE user managing an ACTIVE team, linked to that user; a soft-deleted manager stayed unset).
  `isActiveManager(teamId, userId)` = an active team whose manager is an active person with `user_id = userId`.
- **Delete**: `409` ("Person is still an owner or a team manager") while the person manages an ACTIVE team OR owns an ACTIVE work stream, program or project (V12): reassign first, so every active node's
  owner stays a valid active person. Reads are open to every authenticated user, emails included (the owner pickers need them); writes are ADMIN only (`authorization.md`).
- **Tests**: `PersonTest` (incl. the owner 409), `PersonMigrationTest` (V10's backfill on V9-era data in a scratch database), `TeamTest`, `TestPeople` (the fixture).

## Permissions and dates (built — V11 and the DATE column, v0.2.0)

- **`user_permissions`** (V11, `users/UserService.kt`): the GRANT set `(user_id, permission)`; `Permission { ROADMAP_EDITOR }` is the Kotlin whitelist (`users/User.kt`).
  `ROADMAP_EDITOR` lets its holder edit the global project rank (V13) and set ANY project's target window (the owners above a project may set the window without it).
  Set wholesale by `PUT /users/{id}/permissions` (ADMIN, audited `user.permissions_changed`), read per request by `UserService.hasPermission` — never a JWT claim, never cached
  (`authorization.md` "Roles vs permissions").
- **Dates**: Postgres `DATE`, day precision, through `infra/db/LocalDateColumn.kt` (`localDate(name)` → `Column<java.time.LocalDate>`; no date module dependency; the column type overrides Exposed's default-zone
  `java.sql.Date` write path so the calendar date is bound as-is — `persistence.md` "The DATE column idiom"). Wire format ISO `YYYY-MM-DD` strings; `infra/validation/Dates.kt` (`parseIsoDate` — years 1900–2999 —
  and `requireDateOrder`) is the one parser/validator, a migration `CHECK` the backstop. `LocalDateColumnTest` pins insert, update and WHERE under swapped JVM zones and the historical traps.

## The plan structure (built — V12, v0.2.0; `planning/`)

Hierarchy **work stream → program → project**; every node has an OWNER, a person of the people directory, REQUIRED (`owner_person_id NOT NULL`: ownership-scoped rights need an owner). A node's parent
is set at create and its update body carries none; it changes only through the two **move** endpoints (v0.3.0, below). Milestones hang under a project since V14 (below).

### Entities (V12)

| Table | Columns beyond `id`, `created_at`, `updated_at`, `marked_as_deleted` | Constraints |
|---|---|---|
| `plan_state` | `id SMALLINT` (the single row, `CHECK id = 1`), `revision BIGINT`, `ranking_revision BIGINT NOT NULL DEFAULT 0` (V18), `updated_at` | the revision lock, below; `ranking_revision` = the plan revision at which `roadmap_entries` was last written |
| `work_streams` | `name`, `description`, `owner_person_id → people`, `start_date DATE NOT NULL`, `end_date DATE NULL` (set only when the stream is CLOSED) | `ck_work_streams_end_after_start` (end ≥ start); `uq_work_streams_name_active ON LOWER(name)` (global) |
| `programs` | `work_stream_id → work_streams`, `name`, `description`, `owner_person_id → people` | `uq_programs_name_active ON LOWER(name)` (global, ≈20 programs each named once) |
| `projects` | `program_id → programs`, `name`, `description`, `owner_person_id → people`, `target_start`/`target_end DATE NULL` | `ck_projects_target_window` (both or neither), `ck_projects_target_order` (end ≥ start); `uq_projects_program_name_active ON (program_id, LOWER(name))` (per program: "Discovery"/"MVP"/"Rollout" recur) |

All three uniqueness indexes are partial over ACTIVE rows, so a deleted or renamed node frees its name; the 409 wording is in `UNIQUE_CONSTRAINT_DETAILS` (`ErrorHandling.kt`). A program's span is
derived from its projects and a project's real span from its milestones — nothing is stored for them (the project view derives the latter, "The project view" below; the program and work stream spans are derived by the programs view, built in v0.6). A closed work stream (end date set) still accepts new programs and projects in v0.2 (the
timeline will show it closed later). The owner is changed through the ordinary full-replace PUT.

### The `plan_state` lock protocol and the 409 contract (`planning/PlanState.kt`)

`R2dbcDatabase.withPlanWrite { revision -> … }` = one transaction: `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, run the block, `UPDATE plan_state SET revision = revision + 1`. **Every
mutation of `work_streams`, `programs`, `projects`, `roadmap_entries` (V13), `milestones` (V14), `team_milestone_orders` / `team_order_state` (V17) and `public_holidays` (V19) runs inside it** — people and teams are not plan state. A block that throws (404/409/400 found after the lock) rolls
back the bump with everything else, so a rejected write never moves the revision; a no-op PUT still bumps (conservative). Consequences the code relies on:

- **"Count the children, then delete" is race-free**: the delete counts ACTIVE children under the plan lock, so a concurrent child create (which holds the same lock) either commits first and the
  delete sees it (409) or waits. A parent-row `FOR UPDATE` would NOT do it — a child INSERT's FK check takes only `FOR KEY SHARE` (`persistence.md` "Row locks vs. FK locks").
- **Plain `FOR UPDATE` is justified** on `plan_state`: nothing references it by a foreign key and its key is never changed.
- **Owner validity is not covered by the plan lock** (people are not plan state): `requireActiveOwner` locks the owner's person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE`
  — a delete racing a node write either commits first (the write is a 400) or waits and then sees the node (409). Both halves are pinned in `PlanStateTest`.
- **Guard outside for ordering, re-guarded under the lock.** Read-before-guard resolves the chain and guards BEFORE `call.receive` (the 404 → 403 → 400 ordering), but a request can be held open after
  that (Netty has no body-read timeout), so the verdict is not trusted: inside `withPlanWrite` every node write re-reads the chain (`workStreamChain`/`programChain`/`projectChain`; missing = 404, nothing written),
  re-resolves the caller's person (`PersonService.lockedActivePersonIdOf`, `FOR SHARE` — a re-link or delete of that person waits) and re-runs `requireOwnerOrAdmin` /
  `requireTargetWindowEditorOrAdmin` (re-reading the `ROADMAP_EDITOR` grant in the same transaction); ADMIN short-circuits. A `ForbiddenException` there rolls back with no revision bump and is audited
  centrally as `authz.denied`. No lock cycle: person and team writers never take `plan_state`. `PlanStateTest` pins owner change, person re-link and grant revocation mid-request.
- **Views read the revision FIRST, then the rows, in one transaction** (no `REPEATABLE READ`): a row newer than the revision only makes a client PUT carrying that revision answer a conservative 409.
- The wholesale ranking PUT (V13) compares `expectedRevision` under the lock against the RANKING's own revision (`plan_state.ranking_revision`, V18 — not the plan revision) and answers `409` with `type = urn:astrolabe:problem:stale-revision` (below, "The global project rank"). Like a milestone's `schedule_revision` and a team's `team_order_state.revision` (V17), it is stamped with the new plan revision by the writes that change the thing it guards, so a plan write elsewhere never stales it; the plan revision stays the upper bound of each (a value above it is a view from the future).

**Designed, not built (v0.3 view ETags and v0.9 baselines).** A view's validator must cover everything in its body, so it is `W/"p<plan revision>-n<max(people.updated_at, teams.updated_at)>-c<hash of the
caller's can-flags>"` (people/team renames change owner names without a plan revision; the flags make the validator per-caller). Baselines record the `revision` they were taken at — monotonic, so any
later state orders against them. v0.2 offers no ETag.

### API (all under `/api/v1`, `openapi/documentation.yaml`, tag `plan`)

`POST /work-streams`; `GET/PUT/DELETE /work-streams/{id}`; `POST /work-streams/{id}/programs`; `GET/PUT/DELETE /programs/{id}`; `POST /programs/{id}/projects`; `GET/PUT/DELETE /projects/{id}`;
`PUT /projects/{id}/target-window`; `POST /projects/{id}/move`; `POST /programs/{id}/move`; `GET /views/plan`; `GET /views/programs`; and the ranking (below): `GET /views/roadmap`, `PUT /roadmap/ranking`. PUTs are full replaces (omitted optional = unset; `204`); creates answer `201` + `Location` + the record. **No paged lists** for
work streams/programs (the plan view is the read surface); `GET /projects` is the paged picker list since v0.4 (see "The picker lists" below). `WorkStreamResponse` etc. carry `ownerPersonId` +
`ownerName`; a project also carries `workStreamId`.

**The plan view** (`GET /views/plan`, any authenticated user; the documented view-endpoint shape exception of `list-endpoints.md`, bounded by the scale ≈5 streams / 20 programs / 100 projects):
`{revision, can{createWorkStream}, workStreams[]{…, can{edit, delete, createProgram}, programs[]{…, can{edit, delete, createProject, move}, projects[]{…, can{edit, delete, editTargetWindow, move}}}}}`, open work streams
first then closed ones, each level by name (case-insensitive, then id).

**Moves** (v0.3.0; `ProjectService.move`, `ProgramService.move`, bodies `{programId}` / `{workStreamId}`, `204`): a node changes parent only here. The caller must be ADMIN or own something ABOVE the node (its program's / stream's
owner — the node's own owner alone may not take it out of where it is) AND own something on the TARGET chain (the right to create a child there); both guards re-run under the plan lock against chains re-read there. A missing or
deleted target is a `400` on the body field, never a `404`. The write is one `UPDATE … SET program_id / work_stream_id` plus `updated_at` in a `withPlanWrite` (revision +1): a project's name must be free in the target program (the
partial index's `409`, "A project with this name already exists in this program"); program names are global, so a program move cannot clash. Milestones ride along (their FK is the project), the global ranking is untouched (it is by
project, not by place), and the program span / project view / roadmap are derived by joins, so every chain-derived read (`projectChainRow`, the guards, `GET /views/project/{id}`, the plan view) follows at once. A move to the current
parent is a no-op `204` for a caller who passes both guards: no `UPDATE`, no audit (the plan revision still bumps — the conservative rule). No `expectedRevision`: it sets a parent, it does not merge a client's view, and the guards
re-check the target anyway. The plan view carries `can.move` on every program and project (`PlanPermissions.canMove` = the source guard) and the SPA pairs it with the candidate's `can.createProject` / `can.createProgram`. A closed
work stream still takes children, so it is a valid target (`PlanMoveTest`).
A closed work stream still takes children, so it is a valid target.

### Authorization (the matrix in `authorization.md`)

ADMIN everything; ownership cascades down (an owner at ANY level of a node's chain acts on the node); a project's own owner edits the project but does NOT set its target window (ADMIN, an owner above
it, or a `ROADMAP_EDITOR` do); reads open to every authenticated user; creating a work stream is ADMIN only. Plan routes are **read-before-guard**: chain → 404 → guard 403 → body 400 → validate 400 → write.
Any owner on the chain, the node's own included, may reassign the node's owner (a hand-over; the ancestors can always take it back). The `can:{}` flags come from the pure kernel
`planning/PlanPermissions.kt`, which uses the SAME arithmetic as the guards (`authz/Guards.kt`); `PlanPermissionsTest` pins the agreement table-driven.

### Audit events (`observability.md`)

`work_stream.created/updated/deleted`, `work_stream.owner_changed`, `work_stream.closed` / `work_stream.reopened` (end-date transitions), `program.created/updated/owner_changed/deleted`,
`project.created/updated/owner_changed/deleted`, `project.target_window_changed` (start/end from/to), `project.moved` / `program.moved` (from/to parent; a no-op move emits nothing). Owner changes and window changes are their own trail lines (rights paths). The ranking adds `roadmap.ranked` (below).

### Tests

`PlanMoveTest` (both moves: the above-the-node + target matrix, the own-owner refusal, a closed stream as a target, 404 → 403 → body → target 400, the 409 clash, the no-op, what rides along, the flags vs. the real move, audits, the re-guard under a held lock), `PlanStructureTest` (the HTTP matrix: every route × every kind of caller, 404-before-403, 403-before-body, owner hand-over, name uniqueness per scope, delete 409s, audit), `PlanViewTest` (ordering, the
`can` table, flags vs. what the server really allows), `PlanPermissionsTest` (kernel vs. guards, pure), `PlanStateTest` (revision +1 per write, the lock barrier, the count-under-lock and owner races),
fixtures in `PlanFixtures.kt` (`planWorld`, `TestPlan`). The 401 sweep and OpenAPI conformance are automatic via the spec.

## The global project rank (built — V13, v0.2.0; `planning/RoadmapService.kt`, `RoadmapRoutes.kt`)

One rank over ALL projects, not per program or work stream. **Table `roadmap_entries`** (`project_id INTEGER PRIMARY KEY REFERENCES projects(id)`, `position INTEGER NOT NULL CHECK (position >= 1)`,
`CONSTRAINT uq_roadmap_entries_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED`): one row per RANKED project, positions **dense 1..n**; a project with no row is **unranked**. It is a
**hard-delete table** (a pure position join rewritten wholesale — `persistence.md` "Soft delete"), so a project that leaves the rank leaves no row behind. `DEFERRABLE` is load-bearing: a swap of two
positions, and the renumber sweep below, are single statements an immediate unique check can reject mid-statement depending on physical row order; deferred, uniqueness is checked once at commit
(`RoadmapRankingTest` pins the swap, the sweep, the commit-time duplicate and the `CHECK`).

- **Ranking** (`PUT /roadmap/ranking`, body `{expectedRevision, projectIds[]}`; `200 {revision}`): **wholesale** — the listed projects get positions 1..n in the given order, every other project becomes
  unranked (omit one to unrank it). The SPA's "Rank" appends an unranked project at the END of the list (the user's choice; it is then moved like any other row) — to the server that is just a list one longer.
  Inside `withPlanWrite`, in this order: the grant re-check (`requireRoadmapEditorOrAdmin` again, the same TOCTOU rule as the owner guards: a revocation that landed while the request waited at the lock is a
  `403` with no bump) -> `expectedRevision` must not be below the RANKING's revision read under the lock (`plan_state.ranking_revision`, V18) nor above the current plan revision (**`409`**, `type = urn:astrolabe:problem:stale-revision`, nothing written; checked BEFORE the ids so a stale list
  that names a since-deleted RANKED project is the reload signal, not a `400` — an unranked project deleted under a held view moves no revision, so ranking it later is a `400`, which the web maps to a reload) -> every id must name an ACTIVE project (`400` "Unknown or deleted project ids: …") -> `DELETE FROM roadmap_entries` + one
  `insertRows`. Before the lock: `400` for a duplicated id ("projectIds must be distinct") or more than 1000 ids. **Every accepted PUT bumps the plan revision, even one that keeps the order** (a no-op PUT is
  still a plan write, the conservative rule of the lock protocol) **and stamps `ranking_revision` with the new plan revision** — which is also the `revision` the PUT answers. Concurrent PUTs carrying the same `expectedRevision`: the lock serializes them, the first wins and the second sees the stamped ranking revision —
  exactly one `200`, one `409` (`RoadmapRankingTest`, deterministic with the lock barrier). A plan write that does not touch `roadmap_entries` (a milestone, a dependency, a rename, a new project) moves only the plan revision: a held roadmap view stays current for the PUT.
- **Project delete keeps the rank dense**: `ProjectService.delete` calls `removeFromRanking(id, revision + 1)` in the SAME locked transaction as the soft delete — the project's entry is hard-deleted and
  `UPDATE roadmap_entries SET position = position - 1 WHERE position > ?` closes the gap (one statement, which is why the constraint is deferred) and stamps `ranking_revision` with the delete's plan revision (positions moved: a roadmap view held across the delete is stale). An unranked project is a no-op, no stamp. Work stream and
  program deletes need no hook: they are refused (`409`) while an ACTIVE project exists.
- **The view** (`GET /views/roadmap`, any authenticated user; the view-endpoint shape exception, bounded by ~100 projects): `ranked[]{position, project}` by position, `unranked[]` by name (case-insensitive, then id). `revision` is the RANKING's revision (V18), read
  FIRST, then the rows, in one transaction (the plan view's protocol); a plan write elsewhere does not move it. `can.editRank` comes from `PlanPermissions.canEditRank` (ADMIN or a `ROADMAP_EDITOR` holder, the same arithmetic as the guard;
  `PlanPermissionsTest` pins it, `RoadmapRankingTest` checks it against the real PUT). Since v0.6.0 the project rows and the document carry more: the next section.
- **Authorization**: guard-before-read (the route addresses no node) — `requireRoadmapEditorOrAdmin` runs FIRST, before the body, so every other caller (an owner without the grant included) gets a uniform
  `403` even for a malformed body; `authorization.md`.
- **Audit**: `roadmap.ranked` (byUserId/revisionFrom/revisionTo/orderFrom/orderTo — the ranked project ids as comma-joined text, before and after) on every accepted PUT; a rejected PUT (`409`, `400`) emits nothing,
  a `403` is the central `authz.denied`.
- **Tests**: `RoadmapRankingTest` (guard matrix, revocation under the lock, stale `409`, the `400`s, permutations -> dense rows, delete first/middle/last, the deferrable constraint, the same-revision race, the
  view, `can.editRank` vs. the guard, audit; since V18: a plan write elsewhere — rename, create, schedule, dependency — does not stale a ranking PUT, a ranking write or a ranked project's delete does, an unranked delete does not, a revision above the plan's is stale, and a PUT queued behind a plan write at the lock still passes).

## The roadmap view (built, v0.6.0; `planning/RoadmapKernels.kt`, `RoadmapViewRows.kt`, `RoadmapViewService.kt`)

`GET /views/roadmap` is `{revision, can{editRank}, teams[], ranked[]{position, project}, unranked[], links[]}`; no migration (every figure is derived per request, nothing is stored). The service is ONE read-only REPEATABLE READ
transaction (`SNAPSHOT`): the ranking revision first, then four row sets (the active projects with their program, work stream and the three owner ids of their chain; `roadmap_entries`; the active milestones with their team; the active links), then
the pure `RoadmapKernels` ONCE. A **project row** adds to the old fields: `ownerPersonId`, `rankPosition` (null = unranked), `teamIds` (the distinct teams of ALL its active milestones, scheduled or not, ascending), `span` (the derived span, `SpanKernels.derivedSpan`
over its scheduled milestones; null when none), `drift` (`SpanKernels.drift` against the target window), `flags[]` and `can{editTargetWindow}` (`PlanPermissions.canEditTargetWindow` on the chain read in the same statement as the row; `RoadmapViewTest` checks it
against the real `PUT /projects/{id}/target-window` for every kind of caller). `teams[]` = the active teams with a milestone in the plan, by name (the team filter's options).

- **Flags** (`PlanFlag{kind, severity, days, teamId, otherProjectId}`, raised ON a project, WARNING first, then kind, team, other project). Drift: the end later than the target end = `DRIFT_END_LATE` WARNING (`days` = the delay); a start later than the target start =
  `DRIFT_START_LATE` INFO; an end ahead of the target = `DRIFT_END_EARLY` INFO; an early start or an on-target edge raises nothing; no window or no span, no drift flags.
- **Rank inversion (user decision, 2026-11-01: adjacent pairs per team).** Only RANKED projects carry it, and the flag lives on the LOWER-ranked project B (`otherProjectId` = the higher-ranked A). `startOn(T, p)` = the earliest STORED `start_date` over p's
  scheduled milestones on team T (calendar days, not working days). For each team T, order the ranked projects with scheduled work on T by rank; flag B against its immediate predecessor A on T when `startOn(T, B) < startOn(T, A)`: a `RANK_INVERSION` WARNING
  with `teamId = T`, `days = startOn(T, A) - startOn(T, B)`. A tie is no inversion; a project without scheduled work on T is not on T's list (it neither carries a flag nor separates a pair); a chain A > B > C all inverted reads as two flags (B against A, C against B),
  so every inversion is reported once per (pair, team) without the all-pairs flood (184 warnings on the 80-project sample plan, against 1,038 for all pairs). The INFO variant is the same rule over the OVERALL rank order: each pair of adjacent ranked projects
  (among those that have a derived span) that shares NO team with scheduled work and whose B span starts strictly before A's is a `RANK_INVERSION` INFO (`teamId` null, `days` between the span starts). An unranked project never carries an inversion flag (no rank to invert).
- **Links.** `links[]` rolls the ACTIVE dependencies up per ORDERED pair (predecessor project, successor project), ordered by that pair. Each end resolves to its project (a milestone's own, a project itself) and span (the milestone's dates, the project's derived span);
  a link inside one project is skipped. The pair's `direct` is its PROJECT-to-PROJECT link (`{id, type, lagDays, check}`, at most one per ordered pair by the partial unique index), every other link (a milestone on either end) counts in
  `milestoneLinks{count, violated, unscheduled}`; each is checked like the project view's (`DependencyKernels.check`, working days). Both directions between two projects are two entries.
- **Roll-up.** `RoadmapKernels.flagCounts` (warnings, infos over a set of flags) is the kernel half of the program/work-stream roll-up of the programs view (below).
- **Tests.** `RoadmapKernelsTest` (pure: the drift table, the inversion rule incl. chains, ties, unranked, two teams, the INFO; the link aggregates; the counts), `RoadmapViewTest` (the wire, a flag of each kind, teams, direct/rolled-up links, the deletion, `can` vs. the real PUT, the 401).

## The programs view (built, v0.6.0; `planning/ProgramsView.kt`, `ProgramsTree.kt`, `ProgramsViewService.kt`)

`GET /views/programs` (any authenticated user; no audit, a read) is `{revision, teams[], links[], workStreams[]{id, name, ownerName, startDate, endDate|null, span|null, flags{warnings, infos}, programs[]{id, name, ownerName, span|null, flags, projects[]}}}`; no migration.
The service is the roadmap view's protocol (ONE read-only REPEATABLE READ transaction, `SNAPSHOT`) with one difference: `revision` is the PLAN revision, read first and informational (no flow on the programs page sends it back; the ranking's revision stays on `GET /views/roadmap`).
It calls the SAME `loadRoadmapSnapshot` (one set of loaders, one kernel run) plus the active work streams and programs, so `projects[]` are the roadmap's `RoadmapProject` rows exactly (same spans, drift, flags, `can.editTargetWindow`), `teams` and `links` are the roadmap's, and
an EMPTY program or work stream is present (with a null `span` and zero `flags`). The pure `ProgramsTree.assemble` orders and rolls up: open work streams before closed ones (an `endDate`), streams and programs by lowercase name then id, a program's projects ranked first in rank order, then by name and id.
A program's `span` = `SpanKernels.derivedSpan` over its projects' spans, a work stream's over its programs' spans (nothing stored); a program's/stream's `flags` = the WARNING and INFO flags over its projects (`RoadmapKernels.flagCounts`). Programs have no target window and no `can`.
**Tests.** `ProgramsTreeTest` (pure: every ordering, empties, the span and flag roll-ups, orphans dropped), `ProgramsViewTest` (401, the tree through the wire with open/closed/empty nodes, the roll-ups equal the sums of the projects' flags, the rows/`teams`/`links` equal the roadmap's for every kind of caller, the plan-vs-ranking revision, the deletions).

## Milestones (built — V14, v0.3.0; `planning/Milestone*.kt`)

The fourth level, under a project: a **name**, an optional **description**, **exactly one team** and a **man-day estimate**, **no owner**, and an optional inclusive **start/end** (null = *unscheduled*, the Unscheduled tray).

- **Table `milestones`** (`MilestoneService.Milestones`, `SoftDeletable`): `id SERIAL`, `project_id → projects`, `team_id → teams` (neither with an `ON DELETE` rule: projects and teams are only soft-deleted), `name VARCHAR(100)`, `description VARCHAR(500)`,
  `estimate_md NUMERIC(8,2) NOT NULL CHECK (>= 0)` (`persistence.md` "The NUMERIC column idiom"), `start_date`/`end_date DATE NULL` (`ck_milestones_schedule`: both or neither; `ck_milestones_schedule_order`: end ≥ start),
  `schedule_revision BIGINT NOT NULL` (internal, never on the wire), epoch-millis `created_at`/`updated_at`, `marked_as_deleted`. Names are unique per project among ACTIVE rows, case-insensitively
  (`uq_milestones_project_name_active`, 409 "A milestone with this name already exists in this project"; "Discovery" recurs across projects).
- **Two audiences, two routes.** The **plan fields** (name, description, team, estimate) are written by the owner chain of the project — the project's own owner included — or ADMIN (`POST /projects/{id}/milestones`,
  `PUT`/`DELETE /milestones/{id}`; a team manager who owns nothing on the chain gets 403). The **dates** are written ONLY by `PUT /milestones/{id}/schedule`, whose guard is `requireTeamManagerOrAdmin` against the milestone's STORED
  team: the manager of that team or ADMIN — **never the project's owner** (the product rule of this increment; `MilestoneScheduleTest` "the project owner cannot schedule"). Reads (`GET /milestones/{id}`) are open to every authenticated
  user and 404 when the milestone or any ancestor is gone. Everything is read-before-guard and the guard is re-run under the plan lock (`authorization.md`); the schedule PUT's full order is **404 → 403 → body/validation 400 → lock → 404 (re-read) → 403 (re-guard) → 409 stale**.
- **A new milestone is ALWAYS unscheduled**: the create body carries no dates, for every caller including ADMIN (one shape, one matrix; dates enter only through the schedule PUT).
- **Estimate**: a JSON number (`estimateMd: Double`, `type: number, format: double, minimum: 0`), validated server-side: finite, `0 <= x < 1_000_000`, at most two decimals — 400 "Estimate must be a non-negative man-day figure with at
  most two decimals" — so the stored value is exactly the sent one. Zero is allowed (a zero-effort checkpoint). No `multipleOf` in the spec (float `multipleOf` is unreliable in validators).
- **Dates** are inclusive: `[start, end]`, end ≥ start, a one-day milestone has `start == end` (the rule every dated record follows, `Dates.kt`). The schedule body is `{expectedRevision, startDate, endDate}` with both dates nullable,
  **both or neither** (400 otherwise); **the null pair unschedules** (same guard — there is no separate unschedule operation). The span must contain at least one Monday–Friday day (400 "A milestone must cover at least one working
  day"; `WorkingCalendar.containsWorkingDay`, `infra/time/WorkingCalendar.kt`). **Two checks, one message (v0.7 C3, decision D2):** `validateSchedule` (route, before any lock) keeps the calendar-free weekend-only rule; `MilestoneService.schedule` then re-checks the span against the CURRENT holiday calendar (`loadWorkingCalendar()`, read under the plan lock), **after the guard re-run and before the stale check**, so a span of only holidays (and weekend days) is a 400 with the same message. The order stays 404 → 403 → 400 → lock → 404 → 403 → **400 (holiday-only)** → 409 stale. The null pair (unschedule) has no span to check. A milestone that LATER loses its last working day to a new holiday keeps its dates (a holiday write never touches a milestone): it stays scheduled in every view, covers no working day (no load, no WIP, a zero-length point in the dependency check), and cannot be written back to the same span.
- **Per-milestone optimistic concurrency** (`schedule_revision`). It holds the plan revision at which THIS milestone's schedule was last written (`revision + 1` inside `withPlanWrite`, which hands the block the OLD revision; also set at
  create). The schedule PUT, under the lock, in this order: the chain is re-read (missing = 404, nothing written) → the guard against the stored team (a manager revoked meanwhile is a **403, not a 409**) →
  `stored.schedule_revision > expectedRevision`, or `expectedRevision` above the current plan revision (a view from the future), is a **409** `type = urn:astrolabe:problem:stale-revision` (nothing written, no bump) → the write. A negative `expectedRevision` is a 400 before the lock. The client sends the view's `revision` and adopts the `revision` the PUT answers
  (`ScheduleResponse{revision}`). So a 409 happens only when THIS milestone moved after the client's view was read; unrelated plan writes (another team's drags, a rename elsewhere, a plan-field edit or team change of this milestone)
  never stale a drag. Every accepted PUT bumps the plan revision, even a no-op one (the conservative rule); the v0.8 batch schedule reuses the same per-milestone check.
- **The re-guard locks.** `TeamService.lockedIsActiveManager` takes `FOR SHARE OF teams, people` (not the user row), so a manager change or a re-link of the manager's person either commits first (403) or waits (`persistence.md`).
  The team id the guard checks is the milestone's STORED team re-read under the lock (`milestoneChain`), never a body field.
- **A team change keeps the dates.** `PUT /milestones/{id}` with another `teamId` (an ACTIVE team, else 400 "Unknown or deleted team ids: N", locked `FOR SHARE`) leaves `start_date`/`end_date`/`schedule_revision` untouched: the new team's
  manager inherits the bar and may move or unschedule it — nothing but the manager/ADMIN ever moves a bar. It is its own audit line (`milestone.team_changed`: it changes WHO may schedule — a rights path).
- **Deletes.** A milestone delete is a soft delete under the plan lock (the name is freed). **A project delete cascades**: its ACTIVE milestones are soft-deleted in the same locked transaction (`project.deleted` carries
  `milestoneCount`), so a project with milestones deletes without a 409 (it has no children with their OWN owners). **A team delete is 409 "Team still has milestones"** while an ACTIVE milestone names it (counted under the team row lock).
- **API** (tag `plan`): `POST /projects/{id}/milestones` → 201 + `Location`; `GET`/`PUT`/`DELETE /milestones/{id}`; `PUT /milestones/{id}/schedule` → `200 {revision}`; `GET /views/project/{id}` (below); `GET /milestones` is the paged picker list since v0.4 ("The picker lists" below). A project's own milestones are
  read through the project view.
- **Audit** (`observability.md`): `milestone.created`, `milestone.updated`, `milestone.team_changed` (only on a change), `milestone.scheduled` (stored before and after, only on an actual change), `milestone.deleted`.
- **The project view** (`GET /views/project/{id}`, v0.3.0 C2; `ProjectView.kt`, `ProjectViewService.kt`, route in `PlanViewRoutes.kt`; any authenticated user; the view-endpoint shape exception of `list-endpoints.md`, bounded by ONE
  project's milestones, about 50): `{revision, project{…PlanProject fields, programName, workStreamName, can{edit, delete, editTargetWindow, createMilestone, createDependency}}, span{start, end}|null, drift{startDays, endDays}|null, scheduled[], unscheduled[], dependencies[], idleGaps[]}` (the dependencies: "The project view's dependencies" below; `idleGaps`: "Idle gaps" below).
  One read transaction, the **revision FIRST** and the rows after (the plan view's protocol; the client sends `revision` back as a schedule write's `expectedRevision`); the project, its program and its work stream must be active, else **404 for every
  caller** (a deleted ancestor hides the project; a malformed id is 400). `scheduled` = the milestones with dates, ordered by (start, end, name case-insensitively, id) — the timeline rows; `unscheduled` = the rest, by (name case-insensitively, id) —
  the tray. Each `ProjectMilestone` is the `MilestoneResponse` shape (`teamName` read from the milestone's team WITHOUT an `active()` filter: an active milestone's team is always active) plus `can{edit, delete, schedule}`.
  **Flags** come from the pure `PlanPermissions` kernel with the guards' arithmetic (`PlanPermissionsTest` pins each against its guard): `project.can.edit/delete` = `canManage(projectChain)`, `createMilestone` = `canCreateMilestone` (the same arithmetic, the project's own
  owner included), `editTargetWindow` as in the plan view; a milestone's `edit`/`delete` follow the project's chain, and **`schedule` = `canSchedule(actor, milestone.teamId)` = ADMIN or the caller manages THAT milestone's team** — never the project's owner as such.
  The actor's `managedTeamIds` is resolved once per request for a non-admin (`TeamService.activeManagedTeamIds`: `isActiveManager`'s predicate without the team id; empty for an ADMIN).
  **Derived, never stored** — computed in the first pure span kernel (`planning/SpanKernels.kt`, `SpanKernelsTest`; v0.6 reuses `derivedSpan` for programs and the roadmap): `span` = the earliest start to the latest end over the SCHEDULED milestones (null when none is
  scheduled); `drift` = the signed calendar-day deltas `span.start − target.start` and `span.end − target.end` (**positive = later than the target**, zero on target, negative ahead), null unless BOTH the span and the project's target window exist.
  `ProjectViewTest` (shape and ordering, the span/drift table, `can` per caller, every flag against the real write it mirrors, the 404 and 401 rules, a manager losing the team by reassignment, unset manager, unlinked login or deleted person, a team change moving the flag; project edit/delete/target-window and milestone edit/delete/schedule/create each checked against the real write).
- **Tests**: `MilestoneTest` (the plan-field matrix, validation, the stored `::text`, names, the team change, the cascade, audit), `MilestoneScheduleTest` (the manager matrix with the named project-owner test, the 400s, stale 409,
  per-milestone semantics, the held-request re-guard cases, the lock wait), `DecimalColumnTest`, `TeamTest` (the team 409 and both lock races), `PlanStateTest` (a milestone write bumps by one), `MigrationChecksumTest`.

## Dependencies (built — V15, v0.4.0; `planning/Dependency*.kt`, `Problems.kt`)

A link between two time points of the plan, each end a **milestone or a project**, within or across projects. Built on the recommended defaults of the v0.4 plan's open questions (the user reviews them; `product.md`).

- **Table `dependencies`** (`DependencyService.Dependencies`, `SoftDeletable`): `pred_milestone_id | pred_project_id` and `succ_milestone_id | succ_project_id` — real nullable FKs, `num_nonnulls = 1` per side (`ck_dependencies_pred/succ`) —
  `type VARCHAR(2)` (`ck_dependencies_type`: FS/SS/FF/SF), `lag_days INTEGER` (`ck_dependencies_lag`: -365..365 **working days**, negative = a lead), epoch-millis `created_at`/`updated_at`, `marked_as_deleted`. `ck_dependencies_not_self` forbids the same id on
  both sides (a NULL comparison passes a CHECK, so the mixed milestone-to-project cases pass). **`uq_dependencies_pair_active`**: one ACTIVE link per ORDERED pair of endpoints, whatever its type (`NULLS NOT DISTINCT` — the unused id column of each side is NULL
  and must still collide — and partial over ACTIVE rows, so a deleted link frees the pair); the 409 wording "These two endpoints are already linked" is in `UNIQUE_CONSTRAINT_DETAILS`. The service widens it to **at most one ACTIVE link per UNORDERED pair** (an index cannot: it is over the ordered columns): under the plan lock, before the insert, an active link on (successor, predecessor) answers the same 409 (see the cycle rule). Changing a link's type or lag is delete + add (no PUT in v0.4).
  No `ON DELETE` rules: milestones and projects are soft-deleted only and their deletes cascade here in the same transaction.
- **The successor is the constrained party.** In all four types the SUCCESSOR is the side the constraint binds (FS: it starts after the predecessor ends; SS: starts after it starts; FF: ends after it ends; SF: ends after it starts), so the link is a plan field of
  the successor and **the SUCCESSOR's project chain authorizes it** (`authorization.md`): `POST /projects/{id}/dependencies` (the successor must be project `{id}` itself or one of its ACTIVE milestones, else 400) and `DELETE /dependencies/{id}`. The predecessor must
  merely be an ACTIVE milestone or project (400 "Unknown or deleted milestone ids: N" / "… project ids: N" on the body); its owner is asked nothing — a link never moves a date. A team manager as such has no say. Reads are open to every authenticated user.
- **Cycle rule (`DependencyGraph.kt`, pure).** The graph's nodes are `START(x)` and `END(x)` of every milestone and project; edges are `START(x) → END(x)`, containment `START(project) → START(milestone)` and `END(milestone) → END(project)`, and one edge per
  dependency (`X(pred) → Y(succ)`: FS `END→START`, SS `START→START`, FF `END→END`, SF `START→END`). Without dependency edges it is a DAG, so a new edge `u → v` closes a cycle **iff `v` already reaches `u`**: the create loads every active milestone's containment
  and every active dependency (two statements, bounded by the plan's scale) and runs one iterative DFS with parent links, **under the plan lock** (two racing inserts cannot both pass). **ANY** directed cycle is refused, lags ignored: the reverse of an existing
  pair whenever the two links close a loop (FS/FS, SS/SS, ...), a zero-lag SS/SS pair, `m FS p` and `p FS m` for `m` inside `p`, a three-entity loop across projects (a link between two PROJECTS also forbids any milestone-level link the other way across them). `p SS m` / `m FF p` inside one project are redundant with containment and
  allowed (and some redundant containment links, `p SS m` with a positive lag when `m` is `p`'s earliest milestone, `m FF p` likewise for its latest, are accepted but can never be satisfied: the check will always show them violated). A reverse pair that closes NO
  loop (`a SS b` + `b FF a`, `a SF b` + `b SF a`) is not a cycle, but the one-link-per-unordered-pair rule refuses it with the plain "already linked" 409. A self-link is a 400, not a cycle. The invariant "every active row set is acyclic" is what the v0.7 critical path and the v0.8 scheduler rely on; they add edge weights to the same `TimePointGraph.build`.
- **The 409 names the cycle as data.** `type = urn:astrolabe:problem:dependency-cycle` (`DEPENDENCY_CYCLE_PROBLEM`, beside `STALE_REVISION_PROBLEM` in `Problems.kt`), `detail` "Adding this dependency would close a cycle: A → B → A", and an RFC 7807 extension member
  **`cycle`**: `[{kind: MILESTONE|PROJECT, id, name}, …]` — consecutive time points of one entity collapsed, the NEW link's predecessor first and repeated last. `ConflictException.cycle` carries it, `ProblemDetail.cycle` serializes it (omitted when null, so every other
  problem is unchanged). The SPA renders the path in the UI language instead of sniffing text. A duplicate ordered pair is the plain index 409. A refused write leaves no row and no revision bump.
- **Endpoints on the wire** (`DependencyResponse`, `resolveEndpoints` in `DependencyEndpoints.kt`): both ends resolved to `{kind, id, name, projectId, projectName, teamId?, teamName?, startDate?, endDate?}`; a milestone carries its own project and team, a project
  (`projectId` = its own id, no team) carries its **derived span** — `SpanKernels.derivedSpan` over its scheduled ACTIVE milestones, null while none is scheduled — never its target window.
- **Working days.** `infra/time/WorkingCalendar.kt` is the pure working-day calendar (Flow's `WorkingDayIndex` ported over the closed-form Monday–Friday arithmetic): `isWorkingDay`, `workingDayIndex`, `workingDayOfIndex`, `nextWorkingDayOnOrAfter`, `previousWorkingDayOnOrBefore`, `plusWorkingDays`, `containsWorkingDay`, `workingDaysBetween`, `holidayName`. The index is monotone, flat over a weekend AND a holiday (both collapse onto the working day before), Friday→Monday = +1. The
  holidays are a constructor parameter (date → name), never read from the database by the kernel; `WorkingCalendar.MON_FRI` is the calendar without holidays (kernel tests and pure vectors). **Loading (v0.7 C3):** every consumer takes a `calendar` parameter, and `loadWorkingCalendar()` (`planning/PublicHolidayService.kt`: one `SELECT` of the whole dictionary inside the caller's open transaction) builds it ONCE per request — right after `readPlanRevision()` in `ProjectViewService.view`, `TeamViewService.view` and `loadRoadmapSnapshot` (so the roadmap AND programs views share one read), and under the lock in `MilestoneService.schedule` — so the revision, the rows and the calendar are one REPEATABLE READ snapshot. Never from a route, never cached across requests. The violation check of a link (`DependencyKernels`, below) and the load kernels are built on it. `WorkingCalendarTest` pins the identities.
- **Deletes.** A milestone delete soft-deletes every ACTIVE link with either end at it (`deleteDependenciesOf`, same locked transaction; `milestone.deleted` carries `dependencyCount`). A project delete soft-deletes the links at the project AND at its milestones, both ends,
  before the milestones (`project.deleted` carries `dependencyCount` beside `milestoneCount`). Both audits list the cascaded link ids (`dependencyIds`), a project delete also the successor project ids of those links (`successorProjectIds`). A project move changes no id, so links survive; a team change and an unschedule keep them too (an unscheduled end simply has no dates). Dependency writes bump the plan revision
  and never a milestone's `schedule_revision` — a drag is never staled by someone adding a link.
- **Write order** (`DependencyService.create`, in `withPlanWrite`): project chain re-read (404) → `ownerGuard` re-run with the caller's person `FOR SHARE` (403) → successor in the project (400) → predecessor active (400) → cycle (409) → insert (pair 409). The route's outer order is
  chain → 404 → `requireOwnerOrAdmin` 403 → body → pure validation 400 (lag range, self-link) → the above. `DELETE`: `dependencyChain` (the successor's project chain, 404) → 403 → under the lock the chain re-read (404) and the guard again.
- **API** (tag `plan`): `POST /projects/{id}/dependencies` → 201 + `Location` + `DependencyResponse`; `GET /dependencies/{id}`; `DELETE /dependencies/{id}` → 204. No PUT and no list: a project's links are read through the project view (below).
- **Audit** (`observability.md`): `dependency.created` (byUserId/dependencyId/projectId/predKind/predId/succKind/succId/type/lagDays), `dependency.deleted` (byUserId/dependencyId/predKind/predId/succKind/succId).
- **Tests**: `DependencyTest` (the matrix incl. the named product-rule cases, the 400s, every endpoint kind read back resolved, the 409 pair and cycle shapes, delete), `DependencyLifecycleTest` (cascades, move/team/unschedule survival, the held-request re-guard, audits, the V15
  constraints incl. `NULLS NOT DISTINCT`), `DependencyGraphTest` (pure), `WorkingCalendarTest` (pure), `PlanStateTest` (a dependency write bumps by one, a refused cycle does not), `TestPlan.dependency` / `secondProject` (the fixtures).

### The project view's dependencies (built, v0.4.0 C3; `DependencyKernels.kt`, `ProjectViewDependencies.kt`)

`GET /views/project/{id}` carries `dependencies[]`: every ACTIVE link with an end in the project (the project itself or one of its active milestones) — including a link whose OTHER end is in another project, which is how the page draws its ghost rows. One read in the view's transaction, no
lock. Each item is `{id, predecessor, successor, type, lagDays, check, can{delete}}`:

- **Ends** are the `DependencyEndpoint` of `resolveEndpoints` (batched; a milestone: its own `projectId`/`projectName`, `teamId`/`teamName`, dates; a project: `projectId` = its own id, no team, its DERIVED span — never its target window — null while nothing in it is scheduled). The SPA derives the ghost rows from the ends whose `projectId` is not the viewed project; there is no separate `external[]`.
- **`check`** (`DependencyCheck{status, shortfallDays, requiredDate, actualDate}`) comes from the pure kernel `DependencyKernels.check(type, lagDays, predecessorSpan, successorSpan, calendar)` (no I/O; `DependencyKernelsTest` is table-driven, every figure counted by hand on the 2027 calendar, 2027-02-01 a Monday). With `W` the calendar's working-day index (`infra/time/WorkingCalendar.kt`, Monday–Friday minus holidays, flat over a weekend and a holiday), a span's EFFECTIVE start the first working day on or after
  `start`, its EFFECTIVE end the last working day on or before `end`, `A` the predecessor, `B` the successor and `lag` in working days (negative = a lead):

  | Type | required | actual |
  |---|---|---|
  | FS | `W(A.effEnd) + 1 + lag` | `W(B.effStart)` |
  | SS | `W(A.effStart) + lag` | `W(B.effStart)` |
  | FF | `W(A.effEnd) + lag` | `W(B.effEnd)` |
  | SF | `W(A.effStart) − 1 + lag` | `W(B.effEnd)` |

  Spans are half-open working intervals `[W(effStart), W(effEnd)+1)`, so SF mirrors FS: a successor ending the working day BEFORE the predecessor starts is `OK` at lag 0 (A = 2027-02-01..05, B = 2027-01-25..29, SF → `OK`).

  `shortfallDays = required − actual`; `VIOLATED` when positive (then `shortfallDays` ≥ 1, else null), `OK` otherwise; `requiredDate` = the working day with index `required`, `actualDate` = B's effective start/end, both answered for OK and VIOLATED. An end without dates (a tray milestone, a project with nothing scheduled) makes the link `UNSCHEDULED` (question 3a of the v0.4 plan): no dates, no shortfall, no warning, no arrow. Example: A = 2027-02-01..05, B moved to 2027-01-25..29, FS lag 0 → `VIOLATED`, 10 working days short, "needs 2027-02-08 · is 2027-01-25". A violation changes nothing but the view: no write, no 409, no audit.
- **Order**: `VIOLATED` first (the largest shortfall first), then `OK`, then `UNSCHEDULED`; within a group by the successor's name, the predecessor's name (case-insensitive) and the id — the top of the list IS the conflict list.
- **Flags**: `project.can.createDependency` = `canCreateDependency(projectChain)`; a link's `can.delete` = `canDeleteDependency` on the chain of the project that holds its SUCCESSOR (`authorization.md`). Both equal the arithmetic of the real `POST`/`DELETE`.
- **Tests**: `DependencyKernelsTest` (pure), `ProjectViewDependenciesTest` (the first vector per type over HTTP, both projects of a cross-project link, the order, derived-span and unscheduled ends, deleted and unrelated links absent, both flags against the real writes for ten kinds of caller), `PlanPermissionsTest` (the two flags against the guards).

## The picker lists (built, v0.4.0 C2; `ProjectService.list`, `MilestoneService.list`)

`GET /api/v1/projects` and `GET /api/v1/milestones` are the paged lists (`list-endpoints.md`; copied from `GET /teams`) the dependency dialogs search with. Any authenticated user (`authorization.md`); no audit event (a read). `ProjectListItem` = `ProjectResponse` + `programName`,
`workStreamName`; `MilestoneListItem` = `MilestoneResponse` + `projectName` (the option reads "Design · Project Alpha" — "Discovery" recurs across projects). Sortable `id, name, createdAt, updatedAt` (default `id` ascending, `id` appended as the tiebreaker), the ONE filter `name`
(`containsNormalized`). ACTIVE rows only, joined to ACTIVE ancestors (a project under its active program and work stream; a milestone under its active project chain), count + rows on one predicate in one read transaction. No `projectId`/`teamId` filter (the dialogs search by name;
a `projectId` filter lands with the first picker that needs it). Work streams and programs have no list. Tests: `ProjectListTest`, `MilestoneListTest`.

## Team capacity periods (built — V16, v0.5.0; `teams/TeamCapacity*.kt`)

A team's **man-days per week** and an optional **work-in-progress (WIP) limit**, in effective-from periods. **Team data, not plan state**: written by the team's manager or ADMIN in a transaction of its own, so a capacity write takes **no plan lock and never bumps the plan
revision** (`PlanStateTest` "a capacity write is team data"). The weekly load, overload and WIP verdicts that read these periods arrive with the team view (C3 of v0.5.0); this section is the stored model and its rules.

- **Table `team_capacity_periods`** (`TeamCapacityService.CapacityPeriods`, `SoftDeletable`; the service lives in `teams/`, beside the team it belongs to): `id SERIAL`, `team_id → teams` (no `ON DELETE` rule: teams are only soft-deleted), `effective_from DATE`
  (through `LocalDateColumn.kt`), `md_per_week NUMERIC(8,2) NOT NULL` (`ck_team_capacity_periods_md`: `>= 0`; zero = on hold), `wip_limit INTEGER NULL` (`ck_team_capacity_periods_wip`: NULL or `BETWEEN 1 AND 99`), epoch-millis
  `created_at`/`updated_at`, `marked_as_deleted`. **`uq_team_capacity_periods_team_from_active`**: one ACTIVE period per team and start date (409 "A capacity period already starts on this date for this team"; a deleted period frees its date) — the partial index also serves every per-team read of active rows, so there is no separate `team_id` index.
- **The rules below are the kernel's, not the schema's** (V16's comments carry schema facts only, and point here): the proration and the WIP count read the calendar's working-day predicate (`WorkingCalendar.isWorkingDay`), so the holiday calendar (v0.7, loaded per request) changes the covered days of the proration (the divisor stays 5) and a holiday runs no WIP, without a migration.
- **A period starts on ANY date** (the user's decision, Q1c): there is no weekday CHECK and no weekday rule anywhere; the date is `parseIsoDate`'s alone (`YYYY-MM-DD`, years 1900-2999, `Dates.kt`). A period is in force from `effective_from` until the next ACTIVE period of
  the same team; a weekend date is in force from that date, which simply counts from the next working day. Periods in the past are allowed (history). The weeks before a team's first period have **no capacity and no limit** — "no capacity", never zero, never flagged.
- **The week a period starts in is prorated by working days** (applied by the team view's kernel): a week's capacity is the sum over its working days (the calendar's) of the capacity in force THAT day, divided by 5 (fixed - a holiday week keeps the divisor) (10 MD/week through Wednesday and 20 from Thursday = 3/5 x 10 + 2/5 x 20 = 14);
  `md_per_week` is validated to two decimals so the stored value is exactly the sent one. A period that is the team's first and starts mid-week covers only the days from its start (the uncovered working days contribute 0; a week with no covered day has no capacity).
- **The WIP limit** is per period and optional (`wipLimit` null or 1..99 on the wire, 400 "wipLimit must be between 1 and 99"; the CHECK is the backstop). It is checked **per working day** against the team's scheduled milestones whose effective span covers that day, and a limit that changes
  mid-week applies to each day's own count; a period with a capacity and no limit simply never warns. Both overload and too much WIP only ever **warn** (orange); nothing moves.
- **Writes** (`TeamCapacityService`): ONE transaction that first locks the team row (`Teams.lockActiveForWrite`, `FOR NO KEY UPDATE` — a team delete racing it either commits first and the write is a 404, or waits and then cascades the new period too), then re-runs the manager guard
  with `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`; the guard runs twice, `authorization.md`), then writes. `PUT /capacity-periods/{id}` is a full replace (an absent or null `wipLimit` CLEARS the limit); a PUT that changes nothing is 204 and writes nothing.
  The man-day figure uses `validateManDays(value, field)` (`planning/Milestone.kt`, the milestone estimate's rule with the field named: finite, `0 <= x < 1_000_000`, at most two decimals). **A team delete soft-deletes the team's ACTIVE periods** in its own locked transaction (`deleteCapacityPeriodsOf`, after the
  "Team still has milestones" 409, so a refused delete changes nothing); `team.deleted` carries `capacityPeriodCount`.
- **API** (tag `teams`; `documentation.yaml`): `GET /teams/{id}/capacity` → `200 {items: CapacityPeriodResponse[]}` in `effectiveFrom` order (the bounded `{items}` wrapper of `list-endpoints.md` — a handful of periods per team per year, not paged); `POST /teams/{id}/capacity` → 201 + `Location`;
  `GET`/`PUT`/`DELETE /capacity-periods/{id}` (200 / 204 / 204). Reads: any authenticated user; 404 when the team (or the period, or the period's team) is deleted. Writes: **read-before-guard** (the team or the period's team resolved first — 404 for every caller — then `requireTeamManagerOrAdmin`
  403, then the body, a forbidden caller's malformed body staying 403, then validation 400), the guard again under the lock. The project's owner, the other teams' managers and every other caller are 403.
- **Audit** (`observability.md`): `team.capacity_period_created`, `team.capacity_period_updated` (from/to values, only on an actual change), `team.capacity_period_deleted`; `team.deleted` += `capacityPeriodCount`.
- **Tests**: `TeamCapacityTest` (the caller matrix incl. the project owner and the other team's manager, read-before-guard, any date, the 400s, the optional limit, the stored `::text`, the 409s, the audit), `TeamCapacityLifecycleTest` (the guard re-run under the team row lock — a manager cleared or the team deleted while the
  request was held —, the team-delete cascade, the CHECK and index backstops), `PlanStateTest` (no plan-revision bump), `MigrationChecksumTest`.

## The team milestone order (built — V17, v0.5.0; `planning/TeamOrder*.kt`)

**Two ranks, two meanings (the user's decision "A").** The PROJECT rank (`/roadmap/ranking`, one global list) is the top-down SUGGESTION of the order in which projects should be delivered. The MILESTONE order is the order of ACTUAL EXECUTION and belongs to the
TEAM: each team's manager orders their own team's milestones, and a lower-ranked project's milestone may come before a higher-ranked project's. The project rank is only the DEFAULT of a team's order — used until the team overrides it, and again after a Reset.
**A manager's override is never reshuffled by a later project-rank change**: the stored positions are the team's own and absolute (`replaceRanking` touches `roadmap_entries` only); only milestones the team did not list (newly created, or moved onto the team) slot in after the
listed ones, in project-rank order. The v0.6 rank-vs-time inversion (a WARNING per team, an INFO where no team is shared; built, "The roadmap view (built, v0.6.0)" above) only flags, never reorders.

- **The client's list is the FULL list (the interleaving rule, pinned).** The PUT is wholesale and positions cover scheduled and unscheduled milestones alike, so a manager's order is never reshuffled by the page either: a milestone the manager placed and later unscheduled keeps its stored place. `GET /views/team/{id}` therefore exposes the stored order as `order.milestoneIds` (the team's ACTIVE milestones currently on that team that are listed, scheduled or not, in stored position order, read in the view's own snapshot; empty when `custom` is false). The list the SPA PUTs is `order.milestoneIds` followed by the scheduled rows it does not list, in their displayed order; a reorder of the scheduled rows (a permutation `S'` of the displayed scheduled ids) keeps every unscheduled listed id at its INDEX in that full list and fills the other slots, in order, with `S'` (`web/src/utils/teamOrderList.ts`). Example: stored `[A,B,M,C]`, M unscheduled, Move C to top -> `S'=[C,A,B]` -> PUT `[C,A,M,B]`. Unlisted unscheduled milestones stay unlisted; only the unlisted newcomers (scheduled ones the write lists at the bottom of the full list, by their displayed = project-rank order) slot in at the bottom; Reset still sends `[]`.
- **Tables** (`TeamOrderService.TeamMilestoneOrders`, `TeamOrderState`): `team_milestone_orders (milestone_id INTEGER PRIMARY KEY → milestones, team_id → teams, position INTEGER NOT NULL CHECK (position >= 1), UNIQUE (team_id, position) DEFERRABLE INITIALLY DEFERRED)` — one row per LISTED
  milestone, positions dense 1..n per team; a **hard-delete position join** like `roadmap_entries` (`persistence.md` "Soft delete"); and `team_order_state (team_id PRIMARY KEY → teams, revision BIGINT, updated_at)` — per team, the plan revision at which its order was last written (created
  by the first write, never removed, inert for a deleted team). No `ON DELETE` rules: milestones and teams are only soft-deleted, so the writers remove rows themselves.
- **Write** (`PUT /teams/{id}/milestone-order`, body `{expectedRevision, milestoneIds[]}`, `200 {revision}`): **wholesale** — the listed milestones get positions 1..n, every other milestone of the team is unlisted; **`[]` is the reset** (every row removed, the state revision still
  bumped, so a stale list cannot undo it; there is no `DELETE`). Route order is read-before-guard: team active ?: 404 -> `requireTeamManagerOrAdmin` (the team's ACTIVE manager or ADMIN; the project's owner and every other caller are 403) -> body (a forbidden caller's malformed body stays 403) ->
  pure validation 400 (`expectedRevision` negative, more than 1000 ids, an id twice). Inside `withPlanWrite`, in this order: the team re-read (404; its row locked `FOR SHARE` for EVERY caller, ADMIN included, so a team delete cannot slip in before the state row is stamped) -> the guard again (`lockedIsActiveManager`, 403, no bump) -> **the stale check** (409 `urn:astrolabe:problem:stale-revision`) -> every id an
  ACTIVE milestone OF THIS TEAM (400 "Unknown, deleted or other-team milestone ids: …") -> `DELETE … WHERE team_id = ?` + one `insertRows` -> the state row set to the plan revision the write leaves behind. Every accepted PUT bumps the plan revision, a no-op one included. Positions cover any milestone of the team, scheduled or not.
- **The revision is the team's own.** The stale check is `stored order revision > expectedRevision` or `expectedRevision >` the plan revision under the lock (a view from the future); a team never written has no stored revision, so its first write passes with any valid `expectedRevision`. So only THIS team's order write
  (or its reset) stales a reorder — another team's reorder, a schedule drag, a rename or any other plan write does not, and the order write does not stale a schedule PUT (that one compares the milestone's own `schedule_revision`). The answer `{revision}` is the new order revision.
- **Hooks keep the positions dense**, each in the same plan-locked transaction (`removeFromTeamOrder`, `removeFromTeamOrders`; `persistence.md`): a milestone's team change (`MilestoneService.update`, `teamFrom != teamTo`), its delete, and its project's delete (all the project's milestones, one compaction per touched team) delete the row and close the gap with
  `UPDATE … SET position = position - 1 WHERE team_id = ? AND position > ?` (the single statements the deferred constraint exists for). A removal never bumps the team's order revision: the manager's list is still the manager's list. A milestone that LEAVES a team is unlisted in the new one.
- **The effective order** (`TeamOrderKernels.kt`, pure; `TeamOrderKernelsTest`): the stored custom position first (an unlisted milestone after every listed one), then the project's global rank (unranked projects after ranked ones), then project name (case-insensitive), project id, then the project view's tuple (start, end, name
  case-insensitive, id; a milestone WITHOUT dates sorts after the dated work of its project — undated work follows dated work in an execution order, so the tray's milestones sit last within their project). With no override a team sees its work in the roadmap's order, project by project; with one, the listed rows come first exactly as listed and only the unlisted tail follows the rank. The team view (v0.5.0 C3) is the first reader of it; the stored positions are read through `positionsOf(teamId)`.
- **Audit** (`observability.md`): `team.milestone_order_changed` (byUserId/teamId/revisionFrom/revisionTo/orderFrom/orderTo — the plan revisions around the write and the listed ids before and after as comma-joined text, "" = the default order) on EVERY accepted PUT; a 409/400 emits nothing, a 403 is the central `authz.denied`.
  The server does not know whether a list came from a menu or a drag: both are the same PUT.
- **Tests**: `TeamOrderTest` (the caller matrix incl. "the project owner cannot reorder the team", read-before-guard, "a milestone of another team in the list is 400 after the guard", both stale directions, the per-team revision, partial list and reset, "a ranking PUT after an override leaves the override as it is", the audit),
  `TeamOrderLifecycleTest` (dense positions after a team change / delete / project delete, the deferrable constraint, the same-revision race, "a manager cleared while the PUT waits at the plan lock is refused"), `TeamOrderKernelsTest` (pure, incl. "a rank change reorders only the unlisted tail"), `PlanStateTest` (an order PUT bumps by one), `MilestoneTest` (a team change leaves the old order).

## The team view (built, v0.5.0 C3; `planning/LoadKernels.kt`, `TeamView*.kt`)

`GET /api/v1/views/team/{id}` (tag `plan`; any authenticated user; 404 when the team is deleted, for every caller; **no audit** — a read) answers ONE document, the view-endpoint shape exception of `list-endpoints.md`:
`{revision, team{…TeamResponse fields, can{schedule, editCapacity, editOrder}}, order{custom, revision, milestoneIds[]}, capacity{periods[]}, weeks[], weeksTruncated, scheduled[], unscheduled[], dependencies[], idleGaps[]}`. `TeamViewService` runs ONE READ ONLY REPEATABLE READ transaction (`ProjectViewService`'s snapshot):
the plan revision FIRST, then the team ⋈ its manager's name, the team's ACTIVE milestones ⋈ project ⋈ program ⋈ work stream ⋈ `roadmap_entries` (left: `rankPosition`; `TeamViewRows.kt`), the order positions (`positionsOf`, looked up FROM the active milestones — never by iterating the order table) and the order revision, the capacity periods and the links;
then the pure kernels. `order.revision` is the TEAM's order revision (0 when never written; the `expectedRevision` of `PUT /teams/{id}/milestone-order`), `revision` the PLAN revision (the schedule PUT's). A `TeamMilestone` is `MilestoneResponse` + `projectName`, `programName`, `workStreamName`, `rankPosition` (null = unranked); no per-milestone `can` —
the three team-level flags apply to every bar. Bound: one team's milestones (about 100), their links and at most 520 weeks.

- **The `can` flags: three names, one arithmetic.** `canSchedule`, `canEditCapacity` and `canEditTeamOrder` (`PlanPermissions`) are all "ADMIN, or the caller is the ACTIVE manager of THIS team" (`requireTeamManagerOrAdmin`; the actor's managed teams resolved once, `withManagedTeams = true`). Three flags so a later version may split the rights without a wire change. `PlanPermissionsTest` pins each against the guard;
  `TeamViewTest` checks each against the real write (the schedule PUT, the capacity POST, the order PUT) for every kind of caller.
- **Order** (`effectiveOrder`, see "The team milestone order"): `scheduled[]` and `unscheduled[]` are the team's milestones in the effective order — the team's own override first, the global project rank as the default of the unlisted tail. Positions come from the team's ACTIVE milestones.
- **Weeks and working days.** A week is an ISO week keyed by its Monday (`weekStart`); its working days are the calendar's (`WorkingCalendar.isWorkingDay`: Monday–Friday minus the holidays). The capacity divisor stays **5** in a holiday week: the holiday is an uncovered day, so a 10 MD/week team has 8.00 in the week of 2027-01-04 (Epiphany, Wednesday 01-06) and a 10 MD milestone dated 01-04..01-08, spread over the four remaining days, loads 10.00 — overloaded by +2.00 (the table below; `LoadKernelsTest`). `weeks[]` runs from the Monday of the earliest scheduled start to the Sunday of
  the latest scheduled end (`loadWindow`; empty while nothing is scheduled), capped at **520 weeks** counted from the start (`MAX_LOAD_WEEKS`; `weeksTruncated` then true). A week row is `{weekStart, load, capacity|null, overloaded, overloadMd|null, maxWip, wipExceeded}`.
- **The spread (load).** A scheduled milestone's estimate `E` is spread evenly over its `n = calendar.workingDaysBetween(start, end)` working days (`W(prevWorkingDayOnOrBefore(end)) − W(nextWorkingDayOnOrAfter(start)) + 1`, `W` the index of `WorkingCalendar.kt`): a milestone's share of a week is the EXACT fraction `E × (its working days inside the week) / n` (never divided first — no digit is lost); a week's `load` = the shares of
  every milestone summed exactly (as a fraction over a common denominator) and rounded ONCE to two decimals `HALF_UP` (7.25 MD over six working days loads 3.63 into each of two weeks, 3 days apiece; two 0.01 MD milestones Friday → Monday load 0.01 into the first week, not 0.02). A weekend inside a span costs nothing. 10 MD Wednesday → next Tuesday (5 working days) loads 6.00 into the first week and 4.00 into the second; 10 MD over Friday + Monday + Tuesday loads 3.33 and 6.67.
- **Prorated capacity (Q1c).** `capacityOn(day)` = the `mdPerWeek` of the ACTIVE period with the greatest `effectiveFrom ≤ day` (null before the first). `weekCapacity(monday)` = null when no period is in force on ANY working day of the week ("no capacity", never zero, never flagged); otherwise the sum over Monday–Friday of `(capacityOn(day) ?: 0) / 5` (each share at scale 6, exact for a two-decimal figure), rounded to two decimals `HALF_UP`.
  A weekend `effectiveFrom` needs no special case (only the calendar's working days are summed). Hand-counted (2027-02-01 is a Monday; `LoadKernelsTest` has all eight):

  | Periods (`effectiveFrom` → `mdPerWeek`) | Week of 2027-02-01 | Week of 2027-02-08 |
  |---|---|---|
  | 02-01 → 10, Thu 02-04 → 20 (mid-week boundary) | 3×2 + 2×4 = **14.00** | 20.00 |
  | 02-01 → 10, Mon 02-08 → 20 (a Monday boundary) | 10.00 | 20.00 |
  | 02-01 → 10, Sat 02-06 → 20 (a weekend boundary) | 10.00 | 20.00 |
  | 02-01 → 10, Tue 02-02 → 20, Thu 02-04 → 5 | 2 + 4 + 4 + 1 + 1 = **12.00** | 5.00 |
  | Wed 02-03 → 10 (the first period mid-week) | 0 + 0 + 2 + 2 + 2 = **6.00** (the week of 01-25: null) | 10.00 |
  | Sat 02-06 → 20 (the first period on a weekend) | **null** | 20.00 |
  | 02-01 → 1.33, Thu 02-04 → 0 (rounding) | 3 × 0.266 = 0.798 → **0.80** | 0.00 |
  | 2020-01-06 → 10 (a period in the past) | 10.00 | 10.00 |
  | 01-04 → 10 with the holiday Wed 01-06 (the columns read as the weeks of 2027-01-04 and 01-11; the divisor stays 5) | 4 × 2 = **8.00** (a 10 MD milestone 01-04..01-08 loads 10.00: **+2.00** over) | 10.00 |
- **Overload.** `overloaded = capacity != null && load > capacity` on the ROUNDED figures (what is shown is what is flagged); `overloadMd = load − capacity`, only when overloaded. 0.80 against 0.80 is not overloaded, 0.81 is, by 0.01; a capacity of 0.00 (on hold) flags every loaded week; a null capacity never flags.
- **WIP (B).** A scheduled milestone is IN PROGRESS on the working days of its EFFECTIVE span `[nextWorkingDayOnOrAfter(start), previousWorkingDayOnOrBefore(end)]` (the v0.4 dependency check's rule: a weekend-only edge counts nothing). `wipOn(day)` = the number of scheduled milestones in progress that day; `wipLimitOn(day)` = the WIP limit of the period in force THAT day (null = no limit: before the first period, or a period without one).
  Per week `maxWip` = the peak over the week's working days (0 when nothing runs) and `wipExceeded` = some working day has a limit and exceeds it — **evaluated per day**, so a limit that changes mid-week judges each day by its own limit. There is no per-week limit on the wire (it may change mid-week); the periods table is where limits are read. Worked rows, milestones A 02-01..02-05, B 02-03..02-10, C 02-04..02-04
  (daily WIP, week of 02-01: 1 1 2 3 2; week of 02-08: 1 1 1 0 0):

  | Limits | Week of 02-01 | Week of 02-08 |
  |---|---|---|
  | limit 2 from 02-01 | maxWip 3, **exceeded** (Thu 3 > 2) | 1, not |
  | limit 2 from 02-01, limit 3 from Thu 02-04 | maxWip 3, **not exceeded** (Wed 2 ≤ 2, Thu 3 ≤ 3) | 1, not |
  | limit 3 from 02-01, limit 2 from Thu 02-04 | **exceeded** (Thu 3 > 2) | not |
  | limit 1 from Sat 02-06 as the FIRST period | no limit on any day → not exceeded, maxWip 3 | Mon 1 ≤ 1 → not; with D 02-08..02-09: Mon 2 > 1 → **exceeded** |
  | `wipLimit` null | maxWip 3, not exceeded | 1, not |
  | + E dated Sat 02-06 → Sun 02-14 (effective Mon 02-08 → Fri 02-12), limit 1 | unchanged — E counts on no day of this week | Mon 2 (B, E) > 1 → **exceeded** |
  | + F dated Fri 02-05 → Sat 02-06 (effective Fri only), limit 2 | Fri 3 (A, B, F) > 2 → exceeded | unchanged |
  | nothing scheduled | maxWip 0, not exceeded | 0, not |
- **`dependencies[]`** takes the project view's `ProjectDependency` shape for every ACTIVE link with a MILESTONE end among the team's milestones (`viewDependencies`, generalised from the project view's `projectDependencies`, which keeps a thin call): both ends resolved, `DependencyKernels.check`, violated first, `can.delete` on the SUCCESSOR's project chain.
  The far end of a link may lie in another team or project; it is resolved (name, project, team, dates), not listed as a row — **no ghost rows**.
- **Kernels** (`LoadKernels.kt`, pure — the `CapacityKernels.kt` idiom): `LoadItem`, `CapacityPeriod`, `WeekLoad`, `periodOn`/`capacityOn`/`weekCapacity`/`wipLimitOn`/`wipOn`, `loadWindow`, `weeklyLoad` (working days counted by `WorkingCalendar.workingDaysBetween`); the wire form is `WeekLoadView`. Cost ≤ 520 weeks × 5 days × (≤ 100 milestones + a handful of periods) — milliseconds.
- **Tests**: `LoadKernelsTest` (pure; the tables above verbatim, the spread, the window and the cap), `TeamViewTest` (401, 404/400, the shape, the order with and without an override and a rank change leaving it, the weeks through the wire, the links, the three flags against the real writes), `PlanPermissionsTest`.

## The calendar (built — V19, v0.7.0 C2; `planning/PublicHoliday*.kt`, `PolishHolidays.kt`)

The public-holiday dictionary: ONE global list of dates on which nobody works, curated by ADMIN, applying to every team (the user's decision, 2026-11-01). The working week stays Monday–Friday, fixed. Flow's `PublicHoliday*` ported (its V25 seed is NOT: the table starts empty and **the preset is the path**).

- **Table and wire.** `public_holidays(id, holiday_date DATE UNIQUE, name VARCHAR(100), created_at)` (V19, hard-delete; `persistence.md`). `GET /api/v1/public-holidays` (any authenticated) → `{items:[{id, date, name}]}` in date order, unpaged (about 14 rows a year); `POST /public-holidays` `{date, name}` (ADMIN) → 201 + `Location`, a duplicate date 409 "A holiday already exists on this date"; `DELETE /public-holidays/{id}` (ADMIN) → 204/404; `POST /public-holidays/apply-preset` `{preset: POLISH, year}` (ADMIN, years 1900..2999) → 200 `{added:[PublicHolidayResponse], skipped:[ISO date]}`. Dates are `parseIsoDate`'s (any weekday: a weekend holiday is stored and changes nothing); names are `sanitizeSingleLine`d and 1..100 characters.
- **The Polish preset** (`PolishHolidays.of(year)`, pure): New Year, Epiphany, Easter Sunday and Monday, 1 and 3 May, Pentecost (Easter + 49), Corpus Christi (Easter + 60), 15 August, 1 and 11 November, Christmas Eve (a statutory day only from 2025), 25 and 26 December — 13 days a year, 14 from 2025, Polish names, Sundays included (Easter Sunday, Pentecost). `PolishHolidaysTest` pins Easter, Pentecost and Corpus Christi against Flow's V25 literals for 2017–2030. **The preset projects TODAY's statute onto ANY year in 1900..2999** (the range of `parseIsoDate`): it does not model when a day became statutory (Epiphany only since 2011, 3 May since 1990, 11 November since 1989; Christmas Eve is the one date-dependent rule coded, from 2025), so applying it to a past year adds days that were then working days — the ADMIN removes any that do not apply. **Idempotent**: the dates the dictionary already holds are `skipped` and keep their names; a re-application adds nothing — and still bumps the plan revision (the conservative rule).
- **A holiday write is a plan write (decision D1).** Create, delete and preset each run in `withPlanWrite` and bump `plan_state.revision` by one, and stamp NOTHING else (`ranking_revision`, `team_order_state`, the milestones' `schedule_revision` untouched). So a view held from before carries an older revision (informational: its figures predate the calendar change) while no schedule, ranking or team-order PUT it sends is staled (`PlanStateTest` "a holiday write is a plan write"). A refused duplicate (409), a missing delete (404) and every 400/403 roll back and do not bump.
- **Audit** (`observability.md`): `public_holiday.created` / `.deleted` / `.preset_applied`, each with `revisionTo`.
- **Wired (v0.7.0 C3).** `loadWorkingCalendar()` (beside `PublicHolidayService`) reads the whole dictionary once per request, inside the view's snapshot (project, team, roadmap and programs views) and under the lock in the schedule write; the views pass it to every kernel. Consequences, all through the wire in `ProjectViewDependenciesTest`, `TeamViewTest`, `RoadmapViewTest`, `MilestoneScheduleTest`: an FS "needs" date skips a holiday and a lag counts the calendar's working days; the weekly load spreads over the remaining working days; the holiday is uncovered (capacity divisor stays 5) and runs no WIP; the roadmap's rolled-up links flip with it; a holiday-only schedule is a 400 (above). A removed holiday restores every figure (nothing is stored derived).

## Idle gaps (built, v0.7.0 C5; `planning/IdleGapKernels.kt`)

`idleGaps[{start, end, workingDays}]` on `GET /views/project/{id}` and `GET /views/team/{id}` (spec schema `IdleGap`, by start; empty when there are none). An **idle gap** is a maximal run of at least **3** working days (`MIN_IDLE_GAP_DAYS`, the user's threshold of 2026-11-01) inside the derived span on which nothing is in progress; weekends and public holidays neither count nor break a run, and nothing before the first start or after the last end is reported (the gaps are inside the work).

- **Team**: working days on which the team has NO scheduled milestone in progress, inside the span of the team's scheduled milestones that hold a working day (`SpanKernels.derivedSpan`, not the 520-week load window, so no truncation flag). Only the team's own milestones count. **Project**: working days inside the span of the project's milestones that hold a working day (`span` unless an end milestone is holiday-only) on which none of its OWN milestones is in progress (another project's work of the same team fills nothing).
- **In progress** is the WIP rule of the team view: a scheduled milestone covers the working days of its EFFECTIVE span, first working day on or after its start to the last on or before its end; a weekend-only or holiday-only span covers nothing (a milestone whose only day later became a holiday keeps its dates and stops splitting a hole).
- **The kernel** (`idleGaps(spans, within, calendar, minWorkingDays = 3)`, pure; the calendar is a parameter): spans to working-day-index intervals, sorted, swept with a cursor (`max`, so a nested span never pulls it back); a run closes at the next start or at the end of `within`; a gap answers its FIRST and LAST working day (ISO dates, never a weekend or holiday) and its length. `idleGapViewsOf(spans, calendar)` derives `within` from the spans that hold a working day (`containsWorkingDay`: a milestone on a single day that later became a holiday keeps its dates, is no work and opens no leading or trailing gap) and is what both services call. O(n log n).
- **Hand-counted** (`IdleGapKernelsTest`, 2027-02-01 a Monday): milestones Mon 02-01 and Tue 02-09 leave Tue 02-02..Mon 02-08 = **5** working days (the weekend between uncounted); Mon 01 and Fri 05 leave Tue..Thu = 3 (a gap) but with Wed 03 a holiday only 2 (none); Mon..Tue and Fri 02-12 leave Wed 03..Thu 11 = 7, with Wed 03 and Thu 11 holidays Thu 04..Wed 10 = 5; Thu..Tue over a weekend = 4, Fri..Mon = 2.
- **Tests**: `IdleGapKernelsTest` (pure), `ProjectViewTest` and `TeamViewTest` (a 5-day hole through the wire, a holiday-shortened hole absent via `TestHolidays.with`, own-milestones-only scoping). The web bands and the "Idle gaps" tables are C8.

## Not built yet — the sketch (v0.6+, confirmed by each increment)

- Derived spans, drift (built for the project view, `SpanKernels.kt`) and load (built, `LoadKernels.kt`) are computed at request time in pure kernels (`planning/`, the `CapacityKernels.kt` idiom), with shared JSON test vectors for Kotlin and vitest (deferred to the first
  kernel that needs them; `PlanPermissions` is the first pure kernel and is tested against the guards instead).
- More view endpoints (`/views/plan`, `/views/roadmap`, `/views/programs`, `/views/project/{id}` and `/views/team/{id}` are built), each one document with `can:{…}` flags and a revision, like Flow's `/reports/home`.
