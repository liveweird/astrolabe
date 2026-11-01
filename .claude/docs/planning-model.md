### Planning model

The binding reference for the planning domain as it is built (v0.2.0: people, permissions and dates, the plan structure, the roadmap ranking; v0.3.0: milestones; v0.4.0: dependencies). The product intent and the user's domain
decisions are in `product.md`; the parts not built yet stay a **sketch** at the end (capacity, the team order — the v0.5+ increments confirm or amend each line and rewrite it here when
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
| `plan_state` | `id SMALLINT` (the single row, `CHECK id = 1`), `revision BIGINT`, `updated_at` | the revision lock, below |
| `work_streams` | `name`, `description`, `owner_person_id → people`, `start_date DATE NOT NULL`, `end_date DATE NULL` (set only when the stream is CLOSED) | `ck_work_streams_end_after_start` (end ≥ start); `uq_work_streams_name_active ON LOWER(name)` (global) |
| `programs` | `work_stream_id → work_streams`, `name`, `description`, `owner_person_id → people` | `uq_programs_name_active ON LOWER(name)` (global, ≈20 programs each named once) |
| `projects` | `program_id → programs`, `name`, `description`, `owner_person_id → people`, `target_start`/`target_end DATE NULL` | `ck_projects_target_window` (both or neither), `ck_projects_target_order` (end ≥ start); `uq_projects_program_name_active ON (program_id, LOWER(name))` (per program: "Discovery"/"MVP"/"Rollout" recur) |

All three uniqueness indexes are partial over ACTIVE rows, so a deleted or renamed node frees its name; the 409 wording is in `UNIQUE_CONSTRAINT_DETAILS` (`ErrorHandling.kt`). A program's span is
derived from its projects and a project's real span from its milestones — nothing is stored for them (the project view derives the latter, "The project view" below; the program span is v0.6). A closed work stream (end date set) still accepts new programs and projects in v0.2 (the
timeline will show it closed later). The owner is changed through the ordinary full-replace PUT.

### The `plan_state` lock protocol and the 409 contract (`planning/PlanState.kt`)

`R2dbcDatabase.withPlanWrite { revision -> … }` = one transaction: `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, run the block, `UPDATE plan_state SET revision = revision + 1`. **Every
mutation of `work_streams`, `programs`, `projects`, `roadmap_entries` (V13) and `milestones` (V14) runs inside it** — people and teams are not plan state. A block that throws (404/409/400 found after the lock) rolls
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
- The wholesale ranking PUT (V13) compares `expectedRevision` under the lock and answers `409` with `type = urn:astrolabe:problem:stale-revision` (below, "The global project rank").

**Designed, not built (v0.3 view ETags and v0.9 baselines).** A view's validator must cover everything in its body, so it is `W/"p<plan revision>-n<max(people.updated_at, teams.updated_at)>-c<hash of the
caller's can-flags>"` (people/team renames change owner names without a plan revision; the flags make the validator per-caller). Baselines record the `revision` they were taken at — monotonic, so any
later state orders against them. v0.2 offers no ETag.

### API (all under `/api/v1`, `openapi/documentation.yaml`, tag `plan`)

`POST /work-streams`; `GET/PUT/DELETE /work-streams/{id}`; `POST /work-streams/{id}/programs`; `GET/PUT/DELETE /programs/{id}`; `POST /programs/{id}/projects`; `GET/PUT/DELETE /projects/{id}`;
`PUT /projects/{id}/target-window`; `POST /projects/{id}/move`; `POST /programs/{id}/move`; `GET /views/plan`; and the ranking (below): `GET /views/roadmap`, `PUT /roadmap/ranking`. PUTs are full replaces (omitted optional = unset; `204`); creates answer `201` + `Location` + the record. **No paged lists** for
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
  `403` with no bump) -> `expectedRevision` must equal the revision read under the lock (**`409`**, `type = urn:astrolabe:problem:stale-revision`, nothing written; checked BEFORE the ids so a stale list
  that names a since-deleted project is the reload signal, not a `400`) -> every id must name an ACTIVE project (`400` "Unknown or deleted project ids: …") -> `DELETE FROM roadmap_entries` + one
  `insertRows`. Before the lock: `400` for a duplicated id ("projectIds must be distinct") or more than 1000 ids. **Every accepted PUT bumps the revision, even one that keeps the order** (a no-op PUT is
  still a plan write, the conservative rule of the lock protocol). Concurrent PUTs carrying the same `expectedRevision`: the lock serializes them, the first wins and the second sees the bumped revision —
  exactly one `200`, one `409` (`RoadmapRankingTest`, deterministic with the lock barrier).
- **Project delete keeps the rank dense**: `ProjectService.delete` calls `removeFromRanking(id)` in the SAME locked transaction as the soft delete — the project's entry is hard-deleted and
  `UPDATE roadmap_entries SET position = position - 1 WHERE position > ?` closes the gap (one statement, which is why the constraint is deferred). An unranked project is a no-op. Work stream and
  program deletes need no hook: they are refused (`409`) while an ACTIVE project exists.
- **The view** (`GET /views/roadmap`, any authenticated user; the view-endpoint shape exception, bounded by ~100 projects): `{revision, can{editRank}, ranked[]{position, project}, unranked[]}` with
  `project = {id, name, programId, programName, workStreamId, workStreamName, ownerName, targetStart, targetEnd}`; `ranked` by position, `unranked` by name (case-insensitive, then id). The revision is read
  FIRST, then the rows, in one transaction (the plan view's protocol). `can.editRank` comes from `PlanPermissions.canEditRank` (ADMIN or a `ROADMAP_EDITOR` holder, the same arithmetic as the guard;
  `PlanPermissionsTest` pins it, `RoadmapRankingTest` checks it against the real PUT).
- **Authorization**: guard-before-read (the route addresses no node) — `requireRoadmapEditorOrAdmin` runs FIRST, before the body, so every other caller (an owner without the grant included) gets a uniform
  `403` even for a malformed body; `authorization.md`.
- **Audit**: `roadmap.ranked` (byUserId/revisionFrom/revisionTo/orderFrom/orderTo — the ranked project ids as comma-joined text, before and after) on every accepted PUT; a rejected PUT (`409`, `400`) emits nothing,
  a `403` is the central `authz.denied`.
- **Tests**: `RoadmapRankingTest` (guard matrix, revocation under the lock, stale `409`, the `400`s, permutations -> dense rows, delete first/middle/last, the deferrable constraint, the same-revision race, the
  view, `can.editRank` vs. the guard, audit).

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
  day"; `infra/time/WorkingDays.kt`, a three-line placeholder that v0.7's ported `WorkingCalendar`/`WorkingDayIndex` replaces, as does the v0.5 load kernel's counting).
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
  project's milestones, about 50): `{revision, project{…PlanProject fields, programName, workStreamName, can{edit, delete, editTargetWindow, createMilestone}}, span{start, end}|null, drift{startDays, endDays}|null, scheduled[], unscheduled[]}`.
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
- **Working days.** `infra/time/WorkingDays.kt` holds the closed-form Monday–Friday index (`workingDayIndex`, `workingDayOfIndex`, `nextWorkingDayOnOrAfter`, `previousWorkingDayOnOrBefore`, `plusWorkingDays`): monotone, flat over a weekend, Friday→Monday = +1. The
  violation check of a link (a later increment) is built on it; v0.7 swaps the body for the ported holiday-aware `WorkingDayIndex` and keeps the signatures. `WorkingDaysTest` pins the identities.
- **Deletes.** A milestone delete soft-deletes every ACTIVE link with either end at it (`deleteDependenciesOf`, same locked transaction; `milestone.deleted` carries `dependencyCount`). A project delete soft-deletes the links at the project AND at its milestones, both ends,
  before the milestones (`project.deleted` carries `dependencyCount` beside `milestoneCount`). Both audits list the cascaded link ids (`dependencyIds`), a project delete also the successor project ids of those links (`successorProjectIds`). A project move changes no id, so links survive; a team change and an unschedule keep them too (an unscheduled end simply has no dates). Dependency writes bump the plan revision
  and never a milestone's `schedule_revision` — a drag is never staled by someone adding a link.
- **Write order** (`DependencyService.create`, in `withPlanWrite`): project chain re-read (404) → `ownerGuard` re-run with the caller's person `FOR SHARE` (403) → successor in the project (400) → predecessor active (400) → cycle (409) → insert (pair 409). The route's outer order is
  chain → 404 → `requireOwnerOrAdmin` 403 → body → pure validation 400 (lag range, self-link) → the above. `DELETE`: `dependencyChain` (the successor's project chain, 404) → 403 → under the lock the chain re-read (404) and the guard again.
- **API** (tag `plan`): `POST /projects/{id}/dependencies` → 201 + `Location` + `DependencyResponse`; `GET /dependencies/{id}`; `DELETE /dependencies/{id}` → 204. No PUT and no list yet (the project view carries a project's links — a later increment).
- **Audit** (`observability.md`): `dependency.created` (byUserId/dependencyId/projectId/predKind/predId/succKind/succId/type/lagDays), `dependency.deleted` (byUserId/dependencyId/predKind/predId/succKind/succId).
- **Tests**: `DependencyTest` (the matrix incl. the named product-rule cases, the 400s, every endpoint kind read back resolved, the 409 pair and cycle shapes, delete), `DependencyLifecycleTest` (cascades, move/team/unschedule survival, the held-request re-guard, audits, the V15
  constraints incl. `NULLS NOT DISTINCT`), `DependencyGraphTest` (pure), `WorkingDaysTest` (pure), `PlanStateTest` (a dependency write bumps by one, a refused cycle does not), `TestPlan.dependency` / `secondProject` (the fixtures).

## The picker lists (built, v0.4.0 C2; `ProjectService.list`, `MilestoneService.list`)

`GET /api/v1/projects` and `GET /api/v1/milestones` are the paged lists (`list-endpoints.md`; copied from `GET /teams`) the dependency dialogs search with. Any authenticated user (`authorization.md`); no audit event (a read). `ProjectListItem` = `ProjectResponse` + `programName`,
`workStreamName`; `MilestoneListItem` = `MilestoneResponse` + `projectName` (the option reads "Design · Project Alpha" — "Discovery" recurs across projects). Sortable `id, name, createdAt, updatedAt` (default `id` ascending, `id` appended as the tiebreaker), the ONE filter `name`
(`containsNormalized`). ACTIVE rows only, joined to ACTIVE ancestors (a project under its active program and work stream; a milestone under its active project chain), count + rows on one predicate in one read transaction. No `projectId`/`teamId` filter (the dialogs search by name;
a `projectId` filter lands with the first picker that needs it). Work streams and programs have no list. Tests: `ProjectListTest`, `MilestoneListTest`.

## Not built yet — the sketch (v0.5+, confirmed by each increment)

- `team_milestone_orders(team_id, milestone_id, position)` — the roadmap's sibling (above): dense integers, `UNIQUE … DEFERRABLE`, wholesale PUT with `expectedRevision` (409 on stale) under the `plan_state` lock.
- `team_capacity_periods(team_id, effective_from, md_per_week)`.
- Derived spans, drift (built for the project view, `SpanKernels.kt`) and load are computed at request time in pure kernels (`planning/`, the `CapacityKernels.kt` idiom), with shared JSON test vectors for Kotlin and vitest (deferred to the first
  kernel that needs them; `PlanPermissions` is the first pure kernel and is tested against the guards instead).
- More view endpoints (`/views/team/{id}`, `/views/programs`; `/views/plan`, `/views/roadmap` and `/views/project/{id}` are built), each one document with `can:{…}` flags and a revision, like Flow's `/reports/home`.
