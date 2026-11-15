# Planning model

Owns: the planning domain as built: people, permissions and dates, the plan structure, the `plan_state` lock protocol, the global rank, milestones, dependencies, capacity, the calendar, scheduling, baselines, the server's view documents with their caps and the view validators. Not here: the guard order and existence disclosure (`authorization.md` "Rules"), the DDL (the migration files; `persistence.md`), the audit event catalogue (`observability.md`), the shared Timeline component (`timeline.md`), the product intent, versions and the user's answers (`product.md`).

## Rules

- **Every planning table** has SERIAL ids (unsigned `UIntIdTable`), epoch-millis `BIGINT` `created_at`/`updated_at`, `SoftDeletable` (`marked_as_deleted`) and partial unique indexes over ACTIVE rows (the rank and order tables are hard-delete position lists); one migration and one checksum pin per change (`persistence.md`, `conventions.md`). `DATE` columns go through `infra/db/LocalDateColumn.kt`; wire dates are ISO `YYYY-MM-DD` strings; a span is inclusive.
- Names are trimmed single-line text (control characters are a 400), 1-100 characters; descriptions are optional, at most 500.
- **Every write to plan state runs in `withPlanWrite`** and bumps the plan revision once, a no-op write included; a rejected write never moves it. People and teams are not plan state ("The plan structure" › "The lock protocol").
- **The guard order is `authorization.md`'s** (403 before 400 and 404, read-before-guard for plan nodes, existence disclosure); an owner or manager guard runs again under the lock. A missing row is `x.orNotFound("Resource")` (`conventions.md` "Idioms"). A `409` for a stale revision or scope is decided under the lock, after the guard and the body.
- **A view is read, never recomputed by the client.** Each view is one document with a `revision` and, where it offers actions, `can` flags; the server reads the revision FIRST, then the rows, in one transaction. Spans, drift, load, flags and checks are DERIVED at request time and never stored.
- **Kernels are pure** (`planning/*Kernels.kt`: no I/O, no clock, the working calendar a parameter; Flow's `CapacityKernels.kt` idiom). `can` flags come from the pure `PlanPermissions` kernel with the guards' own arithmetic; `PlanPermissionsTest` pins the agreement.
- **Dependencies and capacity overload only warn.** A violated link, an overloaded week or a WIP excess is a flag and a figure in a view; nothing moves, nothing is refused, no write is staled by one.
- **Who writes what.** Plan fields follow the owner chain; dates follow the milestone's team manager, never the project's owner; the rank and any project's target window follow `ROADMAP_EDITOR`; registries (people, teams, holidays) are ADMIN.
- Every mutation emits an audit event (`observability.md`); an owner change, a window change and a team change are their own trail lines (rights paths); whether a no-op emits is per event (`observability.md`): the moves, `dependency.updated`, `milestone.scheduled`, `baseline.updated` and the pin fire only on a change, the others on every accepted write.
- Only projects and milestones have a paged list ("The picker and milestone lists"); work streams and programs are read through the plan view.
- The user's decisions behind a rule are `product.md` "Domain decisions"; this doc says what the code does.

## People

Files: `people/PersonService.kt`, `people/Person*.kt`.

- **Table `people`** (`SoftDeletable`): name (NOT unique: two real "Anna Nowak"s), an optional email, an optional `user_id` link to a login. A person is NOT a login: an external owner has no account.
- **Uniqueness** (partial, active rows): `uq_people_email_active` on `LOWER(email)` for a set email, `uq_people_user_id_active` on `user_id` (one active person per login). The `409` wording lives in `ErrorHandling.kt`.
- **The link** is set by an ADMIN through `userId` on the person bodies: an ACTIVE user (`400`) not linked to another active person (`409`). A soft-deleted user leaves the person and the link in place, inert (reads resolve the login through ACTIVE users and show it as unlinked; the caller's person is `people.user_id = caller AND people.active()`).
- Name and email edits never cascade between the user and the person; the person's name is the display name on the plan. `person.link_changed` is audited only on change.
- `isActiveManager(teamId, userId)` = an active team whose manager (`teams.manager_person_id`) is an active person with `user_id = userId`.
- **Delete** is `409` ("Person is still an owner or a team manager") while the person manages an ACTIVE team OR owns an ACTIVE work stream, program or project: reassign first, so every active node's owner stays a valid active person.
- Reads are open to every authenticated user, emails included (the owner pickers need them); writes are ADMIN only (`authorization.md`).

Pinned by: `PersonTest`, `PersonMigrationTest`, `TeamTest`, `TestPeople`.

## Permissions and dates

- **`user_permissions`** (`users/UserService.kt`): the GRANT set `(user_id, permission)`; `Permission { ROADMAP_EDITOR }` is the whitelist (`users/User.kt`). `ROADMAP_EDITOR` lets its holder edit the global project rank and set ANY project's target window (the owners above a project may set the window without it).
- Set wholesale by `PUT /users/{id}/permissions` (ADMIN), read per request by `UserService.hasPermission`: never a JWT claim, never cached (`authorization.md` "Roles vs permissions").
- **Dates** are Postgres `DATE`, day precision, through `localDate(name)` of `infra/db/LocalDateColumn.kt` (the calendar date is bound as-is, not through Exposed's default-zone write path: `persistence.md` "The DATE column idiom").
- `infra/validation/Dates.kt` (`parseIsoDate`: years 1900-2999; `requireDateOrder`) is the one parser and validator; a migration `CHECK` is the backstop.

Pinned by: `LocalDateColumnTest`.

## The plan structure

Files: `planning/PlanState.kt`, `WorkStreamService.kt`, `ProgramService.kt`, `ProjectService.kt`, `PlanPermissions.kt`, `PlanViewRoutes.kt`.

Hierarchy **work stream → program → project**; every node has a REQUIRED OWNER, a person of the people directory (ownership-scoped rights need an owner). A node's parent is set at create and its update body carries none; it changes only through the two moves. Milestones hang under a project ("Milestones").

### Entities

| Table | Beyond the common columns | Uniqueness and checks |
|---|---|---|
| `plan_state` | the single row (`CHECK id = 1`): `revision`, `ranking_revision` | the lock below; `ranking_revision` = the plan revision at which `roadmap_entries` was last written |
| `work_streams` | `start_date NOT NULL`, `end_date NULL` (set only when the stream is CLOSED) | `ck_work_streams_end_after_start`; `uq_work_streams_name_active` on `LOWER(name)`, global |
| `programs` | the work stream | `uq_programs_name_active` on `LOWER(name)`, global (about 20 programs, each named once) |
| `projects` | the program, `target_start`/`target_end NULL` | `ck_projects_target_window` (both or neither), `ck_projects_target_order`; `uq_projects_program_name_active` on `(program_id, LOWER(name))` ("Discovery" recurs) |

Every node also has name, description and `owner_person_id`. The name indexes are partial over ACTIVE rows, so a deleted or renamed node frees its name; the `409` wording is in `UNIQUE_CONSTRAINT_DETAILS` (`ErrorHandling.kt`). A program's span is derived from its projects and a project's span from its milestones: nothing is stored for them. A closed work stream still accepts new programs and projects. The owner is changed through the ordinary full-replace PUT.

### The lock protocol

`R2dbcDatabase.withPlanWrite { revision -> … }` = one transaction: `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, run the block, `UPDATE plan_state SET revision = revision + 1`.

**Every mutation of `work_streams`, `programs`, `projects`, `roadmap_entries`, `milestones`, `dependencies`, `team_milestone_orders` / `team_order_state`, `public_holidays` and the `baselines` registry with its frozen rows runs inside it.** People and teams are not plan state. The Jira import's apply is such a writer too: the ONE Jira write that takes `withPlanWrite`, after every HTTP call; it takes the bind's advisory lock right after the plan lock (`persistence.md`).

A block that throws (404/409/400 found after the lock) rolls back the bump with everything else; a no-op PUT still bumps (conservative). Consequences the code relies on:

- **"Count the children, then delete" is race-free**: the delete counts ACTIVE children under the plan lock, so a concurrent child create (same lock) either commits first and the delete sees it (409) or waits. A parent-row `FOR UPDATE` would NOT do it: a child INSERT's FK check takes only `FOR KEY SHARE` (`persistence.md` "Row locks vs. FK locks").
- **Plain `FOR UPDATE`** is enough on `plan_state`: nothing references it by a foreign key and its key is never changed.
- **Owner validity is not covered by the plan lock**: `requireActiveOwner` locks the owner's person row `FOR SHARE`, which conflicts with `PersonService.delete`'s `FOR NO KEY UPDATE`. A delete racing a node write either commits first (the write is a 400) or waits and then sees the node (409).
- **Guard outside for ordering, re-guarded under the lock.** The route guards BEFORE `call.receive`, but a request can be held open after that (`security.md` "Slow requests"), so the verdict is not trusted. Inside `withPlanWrite` every node write:
  - re-reads the chain (`workStreamChain`/`programChain`/`projectChain`; missing = 404, nothing written);
  - re-resolves the caller's person (`PersonService.lockedActivePersonIdOf`, `FOR SHARE`: a re-link or delete of that person waits);
  - re-runs `requireOwnerOrAdmin` / `requireTargetWindowEditorOrAdmin`, re-reading the `ROADMAP_EDITOR` grant in the same transaction; ADMIN short-circuits.
- A `ForbiddenException` there rolls back with no revision bump and is audited centrally as `authz.denied`. No lock cycle: person and team writers never take `plan_state`.
- **A view reads the revision FIRST, then the rows**, in one read-only `REPEATABLE READ` snapshot (`persistence.md`), so the revision, the rows and the calendar agree.
- **Three per-thing revisions** guard the ranking (`plan_state.ranking_revision`), a milestone's schedule (`schedule_revision`) and a team's order (`team_order_state.revision`). Each is stamped with the new plan revision by the writes that change the thing it guards, so a plan write elsewhere never stales it; the plan revision stays the upper bound of each (a value above it is a view from the future). A stale one answers `409` with `type = urn:astrolabe:problem:stale-revision`.
- A view's validator (`ETag`) is a hash of its rendered document and the caller's user id, not a stamp of inputs ("View validators"). A baseline records the `revision` it was taken at.

Pinned by: `PlanStateTest`.

### API

Routes, bodies and statuses are `openapi/documentation.yaml` (tag `plan`), the guards `authorization.md`. PUTs are full replaces (omitted optional = unset; `204`); creates answer `201` + `Location` + the record, which carries `ownerPersonId` + `ownerName`.

**The plan view** (`GET /views/plan`, any authenticated user; about 5 streams / 20 programs / 100 projects) nests work streams → programs → projects with a `can` on every node and one on the document; open work streams first, then closed ones; each level by name (case-insensitive, then id).

**Moves** (`ProjectService.move`, `ProgramService.move`; bodies `{programId}` / `{workStreamId}`; `204`): a node changes parent only here.

- The caller owns something ABOVE the node (the node's own owner alone may not take it out of where it is) AND something on the TARGET chain, or is ADMIN. Both guards re-run under the plan lock against chains re-read there.
- A missing or deleted target is a `400` on the body field, never a `404`. A closed work stream still takes children, so it is a valid target.
- One `UPDATE … SET program_id / work_stream_id` plus `updated_at` in a `withPlanWrite`. A project's name must be free in the target program (the partial index's `409`); program names are global, so a program move cannot clash.
- Milestones ride along (their FK is the project) and the global ranking is untouched (it is by project, not by place). Spans and views are derived by joins, so every chain-derived read follows at once.
- A move to the current parent is a no-op `204` for a caller who passes both guards: no `UPDATE`, no audit (the revision still bumps). No `expectedRevision`: it sets a parent, it does not merge a client's view.
- `can.move` on every program and project is `PlanPermissions.canMove` (= the source guard); the SPA pairs it with the candidate's `can.createProject` / `can.createProgram`.

### Authorization

The matrix is `authorization.md`'s. ADMIN everything; ownership cascades down (an owner at ANY level of a node's chain acts on the node); a project's own owner does NOT set its target window (ADMIN, an owner above it, or a `ROADMAP_EDITOR` do); creating a work stream is ADMIN only. Any owner on the chain, the node's own included, may reassign the node's owner (a hand-over; the ancestors can always take it back).

### Audit events

The catalogue is `observability.md`'s (`work_stream.*`, `program.*`, `project.*`, `roadmap.ranked`). `work_stream.closed` / `reopened` mark the end-date transition; a no-op move emits nothing.

### Pinned by

`PlanMoveTest`, `PlanStructureTest`, `PlanViewTest`, `PlanPermissionsTest`, `PlanStateTest`; fixtures in `PlanFixtures.kt` (`planWorld`, `TestPlan`).

## The global project rank

Files: `planning/RoadmapService.kt`, `RoadmapRoutes.kt`.

One rank over ALL projects, not per program or work stream. **Table `roadmap_entries`** (`project_id` primary key, `position >= 1`, `uq_roadmap_entries_position UNIQUE (position) DEFERRABLE INITIALLY DEFERRED`): one row per RANKED project, positions **dense 1..n**; a project with no row is **unranked**.

- It is a **hard-delete table** (a pure position join rewritten wholesale, `persistence.md` "Soft delete"): a project that leaves the rank leaves no row.
- `DEFERRABLE` is load-bearing: a swap of two positions and the renumber sweep below are single statements an immediate unique check can reject mid-statement depending on physical row order; deferred, uniqueness is checked once at commit.

### Ranking write

`PUT /roadmap/ranking`, body `{expectedRevision, projectIds[]}`; `200 {revision}`. **Wholesale**: the listed projects get positions 1..n in the given order, every other project becomes unranked (omit one to unrank it). The SPA's "Rank" appends an unranked project at the END of the list; to the server that is just a list one longer.

The guard runs FIRST, before the body (the route addresses no node). Before the lock: `400` for a duplicated id ("projectIds must be distinct") or more than 1000 ids. Inside `withPlanWrite`, in this order:

1. The grant re-check (`requireRoadmapEditorOrAdmin` again): a revocation that landed while the request waited at the lock is a `403` with no bump.
2. `expectedRevision` must not be below the RANKING's revision read under the lock nor above the current plan revision: **`409`** `urn:astrolabe:problem:stale-revision`, nothing written. It comes BEFORE the ids, so a stale list that names a since-deleted RANKED project is the reload signal, not a `400`. An unranked project deleted under a held view moves no revision, so ranking it later is a `400`, which the web maps to a reload.
3. Every id must name an ACTIVE project (`400` "Unknown or deleted project ids: …").
4. `DELETE FROM roadmap_entries` + one `insertRows`.

**Every accepted PUT bumps the plan revision, even one that keeps the order, and stamps `ranking_revision` with the new plan revision**, which is also the `revision` it answers. Concurrent PUTs carrying the same `expectedRevision`: the lock serializes them, the first wins and the second sees the stamped ranking revision (one `200`, one `409`). A plan write that does not touch `roadmap_entries` (a milestone, a dependency, a rename, a new project) moves only the plan revision, so a held roadmap view stays current for the PUT.

### Delete keeps the rank dense

`ProjectService.delete` calls `removeFromRanking(id, revision + 1)` in the SAME locked transaction as the soft delete: the project's entry is hard-deleted and `UPDATE roadmap_entries SET position = position - 1 WHERE position > ?` closes the gap (one statement, which is why the constraint is deferred), and `ranking_revision` takes the delete's plan revision (positions moved: a roadmap view held across the delete is stale). An unranked project is a no-op, no stamp. Work stream and program deletes need no hook: they are refused (`409`) while an ACTIVE project exists.

### The view

`GET /views/roadmap` (any authenticated user; about 100 projects): `ranked[]{position, project}` by position, `unranked[]` by name (case-insensitive, then id). Its `revision` is the RANKING's, read FIRST; a plan write elsewhere does not move it. `can.editRank` is `PlanPermissions.canEditRank` (ADMIN or a `ROADMAP_EDITOR` holder). The rows and the document: "The roadmap view". Audit: `roadmap.ranked` on every accepted PUT; a rejected PUT emits nothing.

Pinned by: `RoadmapRankingTest` (the deferrable constraint, the same-revision race, a plan write elsewhere not staling the PUT), `PlanPermissionsTest`.

## Milestones

Files: `planning/Milestone*.kt`, `TeamSchedule*.kt`, `ProjectView*.kt`, `SpanKernels.kt`, `MilestoneFlagKernels.kt`.

The fourth level, under a project: a **name**, an optional **description**, **exactly one team**, a **man-day estimate**, **no owner**, and an optional inclusive **start/end** (null = *unscheduled*, the Unscheduled tray). The project's owner chain writes the plan fields; the milestone's team manager writes the dates. Routes: `openapi/documentation.yaml`, tag `plan`; guards and their order: `authorization.md`.

### Fields

- **Table `milestones`** (`MilestoneService.Milestones`, `SoftDeletable`; no `ON DELETE` rule: projects and teams are only soft-deleted): `estimate_md NUMERIC(8,2) NOT NULL CHECK (>= 0)` (`persistence.md` "The NUMERIC column idiom"); `ck_milestones_schedule` (both dates or neither) and `ck_milestones_schedule_order`; `pinned` is on the wire (`ck_milestones_pinned_scheduled`: a pin needs dates), `schedule_revision` is internal and never on the wire.
- Names are unique per project among ACTIVE rows, case-insensitively (`uq_milestones_project_name_active`, `409` "A milestone with this name already exists in this project").
- **A new milestone is ALWAYS unscheduled**: the create body carries no dates, for every caller including ADMIN. Dates enter only through the schedule PUT, the batch accept, the cross-team accept or the Jira import's apply (which inserts the milestone unscheduled and dates it in the same plan write only where the caller manages its team).
- **Estimate**: a JSON number (`estimateMd`), finite, `0 <= x < 1_000_000`, at most two decimals (`400` "Estimate must be a non-negative man-day figure with at most two decimals"), so the stored value is exactly the sent one. Zero is allowed (a zero-effort checkpoint). The spec has no `multipleOf` (unreliable for floats in validators).
- **Dates** are inclusive: end ≥ start, a one-day milestone has `start == end`.
- **Spans.** A schedule is validated into a `DaySpan` (`planning/SpanKernels.kt`; there is no separate milestone span type). `spanOf(start, end)` builds the span of a stored pair, null while either date is missing; the view and baseline readers use it. Two aggregate queries that already filter on non-null dates (`DependencyEndpoints.kt`, `TeamLoadRows.kt`) build the `DaySpan` directly.

### Two audiences

- The **plan fields** are written by the owner chain of the project, the project's own owner included, or ADMIN; a team manager who owns nothing on the chain gets `403`.
- The **dates** are written ONLY by `PUT /milestones/{id}/schedule` (and, with the same rule, the batch accept, the cross-team accept and the Jira import's apply). The guard is `requireTeamManagerOrAdmin` against the milestone's STORED team: its manager or ADMIN, **never the project's owner** (`MilestoneScheduleTest`).
- **The re-guard locks.** `TeamService.lockedIsActiveManager` takes `FOR SHARE OF teams, people` (not the user row), so a manager change or a re-link of the manager's person either commits first (403) or waits (`persistence.md`). The guard checks the milestone's STORED team re-read under the lock (`milestoneChain`), never a body field.

### The schedule write

`{expectedRevision, startDate, endDate}`, both dates nullable, **both or neither** (400 otherwise); **the null pair unschedules** (same guard: no separate unschedule operation). A negative `expectedRevision` is a 400 before the lock. Under the lock: chain re-read (404) → guard again (403) → holiday-only span (400) → stale (409).

**Working days.** The span must contain at least one Monday-Friday day (`WorkingCalendar.containsWorkingDay`; `400` "A milestone must cover at least one working day"). Two checks, one message:

- `validateSchedule` (route, before any lock) keeps the calendar-free weekend-only rule.
- `MilestoneService.schedule` re-checks the span against the CURRENT holiday calendar (`loadWorkingCalendar()`, read under the plan lock), **after the guard re-run and before the stale check**, so a span of only holidays is a 400 with the same message. The null pair has no span to check.
- A milestone that LATER loses its last working day to a new holiday keeps its dates (a holiday write never touches a milestone). It stays scheduled in every view, covers no working day (no load, no WIP, a zero-length point in the dependency check) and cannot be written back to the same span.
- The project and team views mark it: each SCHEDULED milestone row carries a `NO_WORKING_DAY` WARNING flag (`FlagKind`, declared after `RANK_INVERSION`; every other `PlanFlag` member null), raised by the pure `MilestoneFlagKernels.noWorkingDay(span, calendar)` from the view's OWN `WorkingCalendar` (nothing stored). The roadmap and programs views, the tray and the weeks strip carry nothing. `withExternal` merges the row's own flags with the external ones in `FLAG_ORDER`.

**Per-milestone optimistic concurrency** (`schedule_revision`) holds the plan revision at which THIS milestone's schedule was last written (`revision + 1` inside `withPlanWrite`, which hands the block the OLD revision; also set at create). Under the lock, after the re-guard (a manager revoked meanwhile is a **403, not a 409**): `stored.schedule_revision > expectedRevision`, or `expectedRevision` above the current plan revision (a view from the future), is a **409** `urn:astrolabe:problem:stale-revision` (nothing written, no bump).

The client sends the view's `revision` and adopts the `revision` the PUT answers (`ScheduleResponse{revision}`). So a 409 happens only when THIS milestone moved after the client's view was read; unrelated plan writes (another team's drags, a rename, a plan-field edit or team change of this milestone) never stale a drag. Every accepted PUT bumps the plan revision, a no-op one too; the batch reuses the same per-milestone check.

Pinned by: `MilestoneScheduleTest`, `PlanStateTest`.

### The batch schedule

Files: `TeamSchedule.kt`, `TeamScheduleService.kt`, `TeamScheduleRoutes.kt`.

`POST /teams/{id}/milestone-schedules`, body `{expectedRevision, items: [{milestoneId, startDate, endDate}], scopeHash?}`: "N schedule PUTs in ONE plan write under the TEAM's guard", the accept of an auto-proposal (the scope check: "The auto-proposal"). Each item is the single PUT's body. A `POST`, not a `PUT`: unlisted milestones keep their dates.

`200 {revision, accepted: [id…], skipped: [{milestoneId, reason}]}` in request order, `reason ∈ STALE | GONE | NOT_ON_TEAM | NO_WORKING_DAY` (a stale item is skipped and the rest are written). After the team guard:

1. **Whole-batch 400s before the lock, for client bugs**: negative `expectedRevision`, no items, more than 1000, a milestone twice, an item failing `validateSchedule` (the message names `items[i]`).
2. Under `withPlanWrite`: team re-read and locked `FOR SHARE` (404), manager guard again (403, nothing written, no bump).
3. `expectedRevision` above the plan revision: **409 `stale-revision` for the WHOLE batch**; with a `scopeHash`, then **409 `stale-scope` for the WHOLE batch**.
4. The working calendar is read once; per item, in body order, the FIRST of:
   - no ACTIVE milestone with the id (its project, program and work stream active too, as in `milestoneChain`), or an id that never existed: `GONE`;
   - the STORED team is not the path's team: `NOT_ON_TEAM` (a team change keeps `schedule_revision`, so the revision does not catch it);
   - a span without a working day of the CURRENT holiday calendar: `NO_WORKING_DAY` (the unschedule pair is exempt);
   - `schedule_revision > expectedRevision`: `STALE`.
5. The accepted items are written together by multi-row `UPDATE start_date, end_date, schedule_revision = revision + 1, updated_at … FROM (VALUES …)` statements.

**ONE bump for the batch**, an all-skipped batch too. The answered `revision` is `revision + 1` and every written item's new `schedule_revision`, so it is the next `expectedRevision` of a single PUT or a second batch. A skipped item never rolls the others back. An item equal to its stored span is accepted (and stamped) but audits no `milestone.scheduled`. No cycle check, no order change, no `team_order_state` touch.

Pinned by: `TeamScheduleBatchTest`, `TeamScheduleScopeTest`, `TeamViewTest` (`can.schedule` against the batch POST), `PlanStateTest`.

### The pin

Files: `MilestoneService.pin`, `MilestoneRoutes.kt`.

"Keep this one": a pinned milestone is FIXED for the team's auto-proposal (its dates stand, its load is booked, its dates bound its successors: "The auto-proposal"). It is stored, not per run, and it is advice, not a lock.

`PUT /milestones/{id}/pin` `{pinned: boolean}` → `200 {revision}` (`ScheduleResponse`). The guard is the schedule PUT's, with **no new `can` flag** (`can.schedule` governs it); `pinned` is required (400). Under the lock, after the re-read and the guard again (`lockedIsActiveManager`): pinning a milestone **without dates** is a **409** `urn:astrolabe:problem:milestone-unscheduled` (`MILESTONE_UNSCHEDULED_PROBLEM`; unpinning one is a harmless no-op).

- **No `expectedRevision`** (an idempotent flag; what guards an accept against a pin flipped meanwhile is the proposal's `scopeHash`), **`schedule_revision` untouched** (a pin never stales a drag); the plan revision bumps ONCE, a no-op included.
- A drag or the schedule dialog still moves a pinned milestone and **a reschedule keeps the pin**; a team change and a plan-field edit keep it with the dates.
- **An unschedule clears the pin in the same write**, in EVERY writer of the dates: `MilestoneService.schedule` (the null pair sets `pinned = FALSE`), `writeSchedules` (the batch accept's and the Jira import's multi-row `UPDATE`: `pinned = pinned AND v.s IS NOT NULL`) and the insert (dates NULL, unpinned). The CHECK turns a missed writer into a 500, never a pinned unscheduled row.
- `pinned` rides `MilestoneResponse`, `MilestoneListItem`, `ProjectMilestone` and `TeamMilestone` (required). Audit: `milestone.pinned` / `milestone.unpinned` on a change only; the clear is `milestone.unpinned` with `reason = UNSCHEDULED`.

Pinned by: `MilestonePinTest`, the clear cases in `MilestoneScheduleTest` / `TeamScheduleBatchTest`, `PlanStateTest`, `TeamScheduleScopeTest`.

### Team change and deletes

- **A team change keeps the dates.** `PUT /milestones/{id}` with another `teamId` (an ACTIVE team, else `400` "Unknown or deleted team ids: N", locked `FOR SHARE`) leaves `start_date`/`end_date`/`schedule_revision` untouched: the new team's manager inherits the bar and may move or unschedule it. It is its own audit line (`milestone.team_changed`: it changes WHO may schedule).
- A milestone delete is a soft delete under the plan lock (the name is freed). **A project delete cascades**: its ACTIVE milestones are soft-deleted in the same locked transaction (`project.deleted` carries `milestoneCount`), so a project with milestones deletes without a 409.
- **A team delete is `409` "Team still has milestones"** while an ACTIVE milestone names it (counted under the team row lock).
- Audit: `milestone.scheduled` only on an actual change (the batch emits it per changed item) and one `team.schedule_batch_applied` per accepted batch (`observability.md`).

Pinned by: `MilestoneTest`, `DecimalColumnTest`, `TeamTest` (the team `409` and both lock races), `MigrationChecksumTest`.

### The project view

Files: `ProjectView.kt`, `ProjectViewService.kt`, route in `PlanViewRoutes.kt`.

`GET /views/project/{id}`, any authenticated user; bounded by ONE project's milestones (about 50): `{revision, project{…PlanProject fields, programName, workStreamName, can{edit, delete, editTargetWindow, createMilestone, createDependency}}, span|null, drift|null, scheduled[], unscheduled[], dependencies[], idleGaps[]}` ("The project view's dependencies", "Idle gaps").

- The **revision is read FIRST** (the client sends it back as a schedule write's `expectedRevision`). The project, its program and its work stream must be active, else **404 for every caller**.
- `scheduled` = the milestones with dates, by (start, end, name case-insensitively, id): the timeline rows. `unscheduled` = the rest, by (name case-insensitively, id): the tray.
- Each `ProjectMilestone` is the `MilestoneResponse` shape (`teamName` read WITHOUT an `active()` filter: an active milestone's team is always active) plus `can{edit, delete, schedule}`.
- **Flags** come from `PlanPermissions` with the guards' arithmetic: `project.can.edit/delete` = `canManage(projectChain)`; `createMilestone` = `canCreateMilestone`; `editTargetWindow` as in the plan view; a milestone's `edit`/`delete` follow the project's chain; **`schedule` = `canSchedule(actor, milestone.teamId)` = ADMIN or the caller manages THAT milestone's team**, never the project's owner (`TeamService.activeManagedTeamIds`, resolved once per request for a non-admin).
- **Derived, never stored**, in `SpanKernels` (`derivedSpan` also serves programs and the roadmap): `span` = the earliest start to the latest end over the SCHEDULED milestones (null when none); `drift` = the signed calendar-day deltas `span.start − target.start` and `span.end − target.end` (**positive = later than the target**), null unless BOTH the span and the target window exist.

Pinned by: `ProjectViewTest` (the span/drift table, `can` per caller, every flag against the real write it mirrors, the 404 and 401 rules), `SpanKernelsTest`.

## Dependencies

Files: `planning/Dependency*.kt`, `Problems.kt`, `ProjectViewDependencies.kt`.

A link between two time points of the plan, each end a **milestone or a project**, within or across projects. Types FS/SS/FF/SF plus a lag in working days (the calendar is "The calendar" › "Working days"). A violated link only ever warns (Rules). Routes: `openapi/documentation.yaml`, tag `plan`. No per-resource list: a project's links are read through the project view, the whole plan's through "The dependencies view".

### Table and ends

- **Table `dependencies`** (`DependencyService.Dependencies`, `SoftDeletable`): each side is a nullable milestone FK or a nullable project FK (`ck_dependencies_pred/succ`: `num_nonnulls = 1`), `ck_dependencies_type` (FS/SS/FF/SF), `lag_days` -365..365 **working days** (`ck_dependencies_lag`; negative = a lead). No `ON DELETE` rules: milestones and projects are soft-deleted only and their deletes cascade here in the same transaction. `ck_dependencies_not_self` forbids the same id on both sides.
- **`uq_dependencies_pair_active`**: one ACTIVE link per ORDERED pair of endpoints, whatever its type (`NULLS NOT DISTINCT`, because the unused id column of each side is NULL and must still collide; partial over ACTIVE rows, so a deleted link frees the pair). The `409` wording "These two endpoints are already linked" is in `UNIQUE_CONSTRAINT_DETAILS`.
- The service widens it to **at most one ACTIVE link per UNORDERED pair** (an index cannot): under the plan lock, before the insert, an active link on (successor, predecessor) answers the same `409`.
- A link's TYPE and LAG are edited in place; its ENDS never are (another end = delete + add).
- **Ends on the wire** (`DependencyResponse`, `resolveEndpoints` in `DependencyEndpoints.kt`): `{kind, id, name, projectId, projectName, teamId?, teamName?, startDate?, endDate?}`. A milestone carries its own project and team; a project carries its **derived span** (`SpanKernels.derivedSpan` over its scheduled ACTIVE milestones, null while none is scheduled), never its target window.

### Who writes, and in what order

**The successor is the constrained party** (the side the constraint binds in all four types), so the link is a plan field of the successor and **the SUCCESSOR's project chain authorizes it** (`authorization.md`); a team manager as such has no say.

- The successor must be the project `{id}` itself or one of its ACTIVE milestones, else 400.
- The predecessor must merely be an ACTIVE milestone or project (`400` "Unknown or deleted milestone ids: N" / "… project ids: N"); its owner is asked nothing, because a link never moves a date.

- **Create** (`DependencyService.create`, in `withPlanWrite`; pure validation of lag range and self-link comes first, outside the lock): project chain re-read (404) → `ownerGuard` re-run with the caller's person `FOR SHARE` (403) → successor in the project (400) → predecessor active (400) → cycle (409) → insert (pair 409). A delete re-reads the successor's chain (404) and re-runs the guard under the lock too.
- **Edit in place** (`PUT /dependencies/{id}`, `DependencyService.update`): body `DependencyUpdateRequest{type, lagDays}`, **both required** (a missing field is a 400, there is no partial body) with the create's lag bounds (`validateDependencyUpdate`, shared `requireLagInRange`). `204` with no body (the SPA refetches the view, whose `check` is the answer).
- **Cycle on an edit:** only a changed TYPE moves an edge (a lag-only edit skips the check). The time-point graph is then loaded **without this link's old edge** (`loadTimePointGraph(excludingDependency = id)`) and the new `DependencyEdge(pred, succ, newType)` is checked with the same `cycleClosedBy` under the same lock: `409 urn:astrolabe:problem:dependency-cycle`, detail "**Changing** this dependency would close a cycle: …" (the create says "Adding"), nothing written, no bump. No duplicate/reverse-pair check: the unordered pair is already this link's alone.
- **Revision:** every accepted PUT bumps the plan revision once, a no-op (same type and lag) included; a no-op writes no row (`updated_at` stays) and emits no audit.

### The cycle rule

`DependencyGraph.kt`, pure. The graph's nodes are `START(x)` and `END(x)` of every milestone and project; edges are `START(x) → END(x)`, containment `START(project) → START(milestone)` and `END(milestone) → END(project)`, and one edge per dependency (`X(pred) → Y(succ)`: FS `END→START`, SS `START→START`, FF `END→END`, SF `START→END`).

- Without dependency edges it is a DAG, so a new edge `u → v` closes a cycle **iff `v` already reaches `u`**. The create loads every active milestone's containment and every active dependency (two statements) and runs one iterative DFS with parent links, **under the plan lock** (two racing inserts cannot both pass).
- **ANY** directed cycle is refused, lags ignored: the reverse of an existing pair whenever the two links close a loop (FS/FS, SS/SS, …), a zero-lag SS/SS pair, `m FS p` and `p FS m` for `m` inside `p`, a three-entity loop across projects (a link between two PROJECTS also forbids any milestone-level link the other way across them).
- `p SS m` / `m FF p` inside one project are redundant with containment and allowed; with a positive lag (`m` being `p`'s earliest, resp. latest, milestone) they are accepted but can never be satisfied: the check will always show them violated.
- A reverse pair that closes NO loop (`a SS b` + `b FF a`, `a SF b` + `b SF a`) is not a cycle, but the one-link-per-unordered-pair rule refuses it with the plain "already linked" `409`. A self-link is a 400, not a cycle.
- "Every active row set is acyclic" is what the critical path (`CriticalPathKernels` reuses this time-point vocabulary) and the scheduler rely on.
- **The 409 names the cycle as data.** `type = urn:astrolabe:problem:dependency-cycle` (`DEPENDENCY_CYCLE_PROBLEM`, beside `STALE_REVISION_PROBLEM` in `Problems.kt`), `detail` "Adding this dependency would close a cycle: A → B → A", and an RFC 7807 extension member **`cycle`**: `[{kind: MILESTONE|PROJECT, id, name}, …]` (consecutive time points of one entity collapsed, the NEW link's predecessor first and repeated last). `ConflictException.cycle` carries it, `ProblemDetail.cycle` serializes it (omitted when null).
- The SPA renders the path in the UI language instead of sniffing text. A refused write leaves no row and no revision bump.

### Deletes

- A milestone delete soft-deletes every ACTIVE link with either end at it (`deleteDependenciesOf`, same locked transaction); a project delete soft-deletes the links at the project AND at its milestones. The `*.deleted` audits carry `dependencyCount` and the cascaded `dependencyIds`; a project delete also the `successorProjectIds`.
- A project move, a team change and an unschedule keep the links (an unscheduled end simply has no dates). Dependency writes bump the plan revision and never a milestone's `schedule_revision`: a drag is never staled by someone adding a link.
- `dependency.updated` is audited only on a real change.

Pinned by: `DependencyTest`, `DependencyUpdateTest`, `DependencyLifecycleTest` (cascades, survival, the `NULLS NOT DISTINCT` constraint), `DependencyGraphTest` (pure), `PlanStateTest` (a refused cycle does not bump), `TestPlan.dependency` / `secondProject` (the fixtures).

### The project view's dependencies

Files: `DependencyKernels.kt`, `ProjectViewDependencies.kt`.

`GET /views/project/{id}` carries `dependencies[]`: every ACTIVE link with an end in the project (the project itself or one of its active milestones), including a link whose OTHER end is in another project, which is how the page draws its ghost rows (the SPA derives them from the ends whose `projectId` is not the viewed project; there is no `external[]`). One read in the view's transaction, no lock. Each item is `{id, predecessor, successor, type, lagDays, check, can{edit, delete}}`.

- **`check`** (`DependencyCheck{status, shortfallDays, slackDays, requiredDate, actualDate}`) comes from the pure kernel `DependencyKernels.check(type, lagDays, predecessorSpan, successorSpan, calendar)`. With `W` the calendar's working-day index, a span's EFFECTIVE start the first working day on or after `start`, its EFFECTIVE end the last working day on or before `end`, `A` the predecessor, `B` the successor and `lag` in working days (negative = a lead):

  | Type | required | actual |
  |---|---|---|
  | FS | `W(A.effEnd) + 1 + lag` | `W(B.effStart)` |
  | SS | `W(A.effStart) + lag` | `W(B.effStart)` |
  | FF | `W(A.effEnd) + lag` | `W(B.effEnd)` |
  | SF | `W(A.effStart) − 1 + lag` | `W(B.effEnd)` |

  Spans are half-open working intervals `[W(effStart), W(effEnd)+1)`, so SF mirrors FS: a successor ending the working day BEFORE the predecessor starts is `OK` at lag 0.
- `shortfallDays = required − actual`; `VIOLATED` when positive (then `shortfallDays` ≥ 1, else null), `OK` otherwise. **`slackDays = actual − required`** is the link's OWN float in working days: 0 or more when `OK`, `−shortfallDays` when `VIOLATED`, null when `UNSCHEDULED` (not the critical path's slack toward a project's end).
- `requiredDate` = the working day with index `required`, `actualDate` = B's effective start/end, both answered for OK and VIOLATED. An end without dates (a tray milestone, a project with nothing scheduled) makes the link `UNSCHEDULED`: no shortfall, no warning, no arrow. A violation changes nothing but the view.
- **Order**: `VIOLATED` first (the largest shortfall first), then `OK`, then `UNSCHEDULED`; within a group by the successor's name, the predecessor's name (case-insensitive) and the id. The top of the list IS the conflict list.
- **Flags**: `project.can.createDependency` = `canCreateDependency(projectChain)`; a link's `can.edit` / `can.delete` = `canEditDependency` / `canDeleteDependency` on the chain of the project that holds its SUCCESSOR; each equals the arithmetic of the real write.

Pinned by: `DependencyKernelsTest` (table-driven, counted by hand on the 2027 calendar, 2027-02-01 a Monday), `ProjectViewDependenciesTest`, `PlanPermissionsTest`.

## The picker and milestone lists

Files: `ProjectService.list`, `MilestoneService.list`.

`GET /api/v1/projects` and `GET /api/v1/milestones` are the paged lists (`list-endpoints.md`; copied from `GET /teams`) the dependency dialogs search with; the milestone list also backs the Milestones page. Any authenticated user; no audit event (a read). Work streams and programs have no list.

- `ProjectListItem` = `ProjectResponse` + `programName`, `workStreamName`; `MilestoneListItem` = `MilestoneResponse` + `projectName` and `teamName` (the option reads "Design · Project Alpha": "Discovery" recurs across projects). The sort and filter whitelists are the spec's per path; `milestones` sorts by the joined tables' `name` columns through one `SORTABLE_COLUMNS` map that is also the route's whitelist.
- Projects take the ONE filter `name` (`containsNormalized`). Milestones take `name`, `scheduled` (strict `true`/`false`: `start_date IS [NOT] NULL`, since `ck_milestones_schedule` makes the date pair both-or-neither), `teamId` and `projectId`, all ANDed into the one predicate.
- A malformed or repeated filter is a `400`; an id that names nothing is an empty `200` page (a filter is not an address, no `404`).
- `scheduled=false` counts the SAME set as Home's `plan.unscheduledMilestones` (and `scheduled=false&teamId=N` a team row's `unscheduledMilestones`): the active milestones under an active project, program and work stream. ACTIVE rows only, joined to ACTIVE ancestors; count and rows on one predicate in one read transaction.

Pinned by: `ProjectListTest`, `MilestoneListTest` (the equality above).

## Team capacity periods

Files: `teams/TeamCapacity*.kt` (`TeamCapacityService.kt`, `TeamCapacityRoutes.kt`, `TeamCapacityRows.kt`, `TeamCapacityImportStore.kt`).

A team's **man-days per week** and an optional **work-in-progress (WIP) limit**, in effective-from periods. **Team data, not plan state**: written by the team's manager or ADMIN in a transaction of its own, so a capacity write takes **no plan lock and never bumps the plan revision**.
The weekly load, overload and WIP verdicts that read these periods are "The team view"'s; this section is the stored model and its rules.

- **Table `team_capacity_periods`** (`TeamCapacityService.CapacityPeriods`, `SoftDeletable`; the DDL is the migrations'): `md_per_week` is `NUMERIC(8,2)`, `>= 0` (zero = on hold); `wip_limit` is NULL or 1..99. No `ON DELETE` rules: teams are only soft-deleted.
- **`uq_team_capacity_periods_team_from_active`**: one ACTIVE period per team and start date (409 "A capacity period already starts on this date for this team"; a deleted period frees its date). The partial index also serves every per-team read of active rows, so there is no separate `team_id` index.
- **Provenance.** `source` is `MANUAL` (hand-entered; the default) or `FLOW` (written by the capacity import for the Flow sprint in `flow_sprint_id`/`flow_sprint_name`). `CapacityPeriodResponse` always carries `source` and `flowSprintName` (null on a manual one); the team view's `capacity.periods` are the same schema.
  The kernels read neither column: a Flow-sourced period weighs like any other.
- **A PUT on a `FLOW` period makes it `MANUAL`** and clears the sprint columns, even when the figures are equal (the manager took it over). The import never updates or removes a `MANUAL` period. The audit carries `sourceFrom`/`sourceTo`.
- **The capacity import** (`flow/CapacityImportKernels.kt`, `flow-sync.md` "The capacity import") writes `FLOW` periods: `mdPerWeek = round2(5 x flowMd / workingDays)`, so `weekCapacity` over a sprint adds up to the sprint's man-days within rounding (the divisor 5 holds on a holiday week).
  Its preview only reads the periods. Its apply is `TeamCapacityService.applyImport`, the public entry; the writes live in `teams/TeamCapacityImportStore.kt`.
- **The apply** is ONE team-locked transaction: it creates a `FLOW` period per CREATE row, rewrites the figure and sprint of the sprint's existing `FLOW` period for an UPDATE (its WIP limit is kept), soft-deletes the ticked removals, and never touches a `MANUAL` one. An imported period is shown like any other and feeds `weekCapacity` unchanged.
- **Reads.** The team view and the team-load views read the ACTIVE periods through `teams/TeamCapacityRows.kt`: `activeCapacityPeriods` (one team, or many in one statement), ordered by `effectiveFrom` then id. `toCapacityPeriodResponse` is the ONE row-to-wire mapping, shared with `TeamCapacityService`.
- **The rules below are the kernel's, not the schema's.** The proration and the WIP count read the calendar's working-day predicate (`WorkingCalendar.isWorkingDay`), so the holiday calendar changes the covered days of the proration (the divisor stays 5) and a holiday runs no WIP, without a migration.
- **A period starts on ANY date.** There is no weekday CHECK and no weekday rule; the date is `parseIsoDate`'s alone (`YYYY-MM-DD`, years 1900-2999). A period is in force from `effective_from` until the next ACTIVE period of the same team; a weekend date is in force from that date, which counts from the next working day. Periods in the past are allowed.
- **No period, no capacity.** The weeks before a team's first period have **no capacity and no limit**: "no capacity", never zero, never flagged. A period that is the team's first and starts mid-week covers only the days from its start. The week a period starts in is prorated by working days (prorated capacity in "The team view").
- **The WIP limit** is per period and optional (`wipLimit` null or 1..99 on the wire, 400 "wipLimit must be between 1 and 99"; the CHECK is the backstop). It is checked **per working day** against the team's scheduled milestones whose effective span covers that day; a limit that changes mid-week applies to each day's own count. A period with a capacity and no limit never warns.
  Both overload and too much WIP only ever **warn**; nothing moves.
- **Writes** are ONE transaction that first locks the team row (`Teams.lockActiveForWrite`, `FOR NO KEY UPDATE`: a team delete racing it either commits first and the write is a 404, or waits and then cascades the new period too), then re-runs the manager guard with `TeamService.lockedIsActiveManager` (`FOR SHARE OF teams, people`), then writes.
  `PUT /capacity-periods/{id}` is a full replace (an absent or null `wipLimit` CLEARS the limit); a PUT that changes nothing is `204` and writes nothing. The man-day figure uses `validateManDays(value, field)` (`planning/Milestone.kt`: finite, `0 <= x < 1_000_000`, at most two decimals).
- **A team delete** soft-deletes the team's ACTIVE periods in its own locked transaction (`deleteCapacityPeriodsOf`), after the "Team still has milestones" 409, so a refused delete changes nothing; `team.deleted` carries `capacityPeriodCount`.
- **API** (tag `teams`; the spec): `GET /teams/{id}/capacity` answers `{items: CapacityPeriodResponse[]}` in `effectiveFrom` order, the bounded `{items}` wrapper of `list-endpoints.md` (a handful of periods a year, not paged); `POST /teams/{id}/capacity` is `201` + `Location`; `GET`/`PUT`/`DELETE /capacity-periods/{id}`. Reads: any authenticated user; `404` when the team, the period or the period's team is deleted.
- **Writes are read-before-guard.** The team (or the period's team) is resolved first (404 for every caller), then `requireTeamManagerOrAdmin` (403; the project's owner and the other teams' managers are 403), then the body (a forbidden caller's malformed body stays 403), then validation (400); the guard runs again under the lock (`authorization.md`).
- **Audit** (`observability.md`): `team.capacity_period_created`, `team.capacity_period_updated` (from/to values, only on an actual change), `team.capacity_period_deleted`.

Pinned by: `TeamCapacityTest`, `TeamCapacityLifecycleTest`, `PlanStateTest`, `MigrationChecksumTest`.

## The team milestone order

Files: `planning/TeamOrder*.kt` (`TeamOrderService.kt`, `TeamOrderRoutes.kt`, `TeamOrderKernels.kt`).

**Two ranks, two meanings.** The PROJECT rank (`/roadmap/ranking`, one global list) is the top-down SUGGESTION of the order in which projects should be delivered. The MILESTONE order is the order of ACTUAL EXECUTION and belongs to the TEAM: each team's manager orders their own team's milestones, and a lower-ranked project's milestone may come before a higher-ranked project's.
The project rank is only the DEFAULT of a team's order, used until the team overrides it and again after a Reset.

- **A manager's override is never reshuffled by a later project-rank change.** The stored positions are the team's own and absolute (`replaceRanking` touches `roadmap_entries` only); only milestones the team did not list (new, or moved onto the team) slot in after the listed ones, in project-rank order. The roadmap's rank-vs-time inversion only flags, never reorders ("The roadmap view").
- **Tables** (`TeamOrderService.TeamMilestoneOrders`, `TeamOrderState`; the DDL is the migrations'): `team_milestone_orders` has one row per LISTED milestone, positions dense 1..n per team, `UNIQUE (team_id, position) DEFERRABLE INITIALLY DEFERRED`; a **hard-delete position join** like `roadmap_entries` (`persistence.md` "Soft delete").
  `team_order_state` holds, per team, the plan revision at which its order was last written (created by the first write, never removed, inert for a deleted team). No `ON DELETE` rules: milestones and teams are only soft-deleted, so the writers remove rows themselves.
- **The client's list is the FULL list (the interleaving rule).** The PUT is wholesale and its positions cover scheduled and unscheduled milestones alike, so a milestone the manager placed and later unscheduled keeps its stored place. `GET /views/team/{id}` therefore exposes the stored order as `order.milestoneIds` (the team's ACTIVE listed milestones, scheduled or not, in stored order, read in the view's snapshot; empty when `custom` is false).
- **What the SPA PUTs** is `order.milestoneIds` followed by the scheduled rows it does not list, in their displayed order. A reorder of the scheduled rows (a permutation `S'`) keeps every unscheduled listed id at its INDEX in that full list and fills the other slots, in order, with `S'` (`web/src/utils/teamOrderList.ts`).
  Example: stored `[A,B,M,C]`, M unscheduled, Move C to top: `S'=[C,A,B]`, PUT `[C,A,M,B]`. Unlisted unscheduled milestones stay unlisted; unlisted scheduled newcomers go to the bottom in project-rank order; Reset sends `[]`.
- **Write** (`PUT /teams/{id}/milestone-order`, body `{expectedRevision, milestoneIds[]}`, `200 {revision}`): **wholesale**, the listed milestones get positions 1..n and every other milestone of the team is unlisted. **`[]` is the reset** (every row removed, the state revision still bumped, so a stale list cannot undo it; there is no `DELETE`).
- **Order of checks** (read-before-guard): team active (404) → `requireTeamManagerOrAdmin` (the team's ACTIVE manager or ADMIN; the project's owner and every other caller are 403) → body (a forbidden caller's malformed body stays 403) → pure validation 400 (`expectedRevision` negative, more than 1000 ids, an id twice).
- **Inside `withPlanWrite`:** the team re-read (404; its row locked `FOR SHARE` for EVERY caller, ADMIN included, so a team delete cannot slip in before the state row is stamped) → the guard again (`lockedIsActiveManager`, 403, no bump) → **the stale check** (409 `urn:astrolabe:problem:stale-revision`) → every id an ACTIVE milestone OF THIS TEAM (400 "Unknown, deleted or other-team milestone ids: …")
  → `DELETE … WHERE team_id = ?` + one `insertRows` → the state row set to the plan revision the write leaves behind. Every accepted PUT bumps the plan revision, a no-op one included.
- **The revision is the team's own.** The stale check is `stored order revision > expectedRevision` or `expectedRevision >` the plan revision under the lock (a view from the future); a team never written has no stored revision, so its first write passes with any valid `expectedRevision`.
  So only THIS team's order write (or reset) stales a reorder: another team's reorder, a schedule drag, a rename or any other plan write does not, and the order write does not stale a schedule PUT (that compares the milestone's own `schedule_revision`). The answer `{revision}` is the new order revision.
- **Hooks keep the positions dense**, each in the same plan-locked transaction (`removeFromTeamOrder`, `removeFromTeamOrders`): a milestone's team change (`MilestoneService.update`, `teamFrom != teamTo`), its delete, and its project's delete (one compaction per touched team) delete the row and close the gap with `UPDATE … SET position = position - 1 WHERE team_id = ? AND position > ?`
  (the single statements the deferred constraint exists for). A removal never bumps the team's order revision. A milestone that LEAVES a team is unlisted in the new one.
- **The effective order** (`TeamOrderKernels.kt`, pure): the stored custom position first (an unlisted milestone after every listed one), then the project's global rank (unranked projects after ranked ones), then project name (case-insensitive), project id, then the project view's tuple (start, end, name case-insensitive, id; a milestone WITHOUT dates sorts after the dated work of its project).
  With no override a team sees its work in the roadmap's order, project by project; with one, the listed rows come first exactly as listed and only the unlisted tail follows the rank. The stored positions are read through `positionsOf(teamId)`.
- **Audit** (`observability.md`): `team.milestone_order_changed` on EVERY accepted PUT (the plan revisions around the write, and the listed ids before and after as comma-joined text, "" = the default order); a 409/400 emits nothing, a 403 is the central `authz.denied`. The server does not know whether a list came from a menu or a drag.

Pinned by: `TeamOrderTest`, `TeamOrderLifecycleTest`, `TeamOrderKernelsTest`, `PlanStateTest`, `MilestoneTest`.

## The calendar

Files: `planning/PublicHoliday*.kt`, `PolishHolidays.kt`, `infra/time/WorkingCalendar.kt`.

The public-holiday dictionary is ONE global list of dates on which nobody works, curated by ADMIN, applying to every team. The working week stays Monday-Friday, fixed. Flow's `PublicHoliday*` is ported; its seed is not: the table starts empty and **the preset is the path**.

### The dictionary

- **Table and wire.** `public_holidays(id, holiday_date DATE UNIQUE, name VARCHAR(100), created_at)` (hard-delete; `persistence.md`). A duplicate date is `409` "A holiday already exists on this date". Dates are `parseIsoDate`'s (any weekday: a weekend holiday is stored and changes nothing); names are `sanitizeSingleLine`d, 1..100 characters.
- **Routes** (the spec): `GET /public-holidays` (any authenticated) answers `{items:[{id, date, name}]}` in date order, unpaged (about 14 rows a year); `POST` and `DELETE /public-holidays/{id}` are ADMIN; `POST /public-holidays/apply-preset` `{preset: POLISH, year}` (ADMIN, years 1900..2999) answers `{added:[PublicHolidayResponse], skipped:[ISO date]}`.
- **The Polish preset** (`PolishHolidays.of(year)`, pure): New Year, Epiphany, Easter Sunday and Monday, 1 and 3 May, Pentecost (Easter + 49), Corpus Christi (Easter + 60), 15 August, 1 and 11 November, Christmas Eve (a statutory day only from 2025), 25 and 26 December: 13 days a year, 14 from 2025, Polish names, Sundays included.
  `PolishHolidaysTest` pins Easter, Pentecost and Corpus Christi against Flow's literals for 2017-2030.
- **The preset projects TODAY's statute onto any year in 1900..2999.** It does not model when a day became statutory (Epiphany only since 2011, 3 May since 1990, 11 November since 1989; Christmas Eve is the one date-dependent rule coded), so applying it to a past year adds days that were then working days; the ADMIN removes any that do not apply.
- **Idempotent.** The dates the dictionary already holds are `skipped` and keep their names; a re-application adds nothing and still bumps the plan revision.
- **A holiday write is a plan write.** Create, delete and preset each run in `withPlanWrite` and bump `plan_state.revision` by one, and stamp NOTHING else (`ranking_revision`, `team_order_state` and the milestones' `schedule_revision` are untouched). A view held from before carries an older revision (informational: its figures predate the calendar change) while no schedule, ranking or team-order PUT it sends is staled.
  A refused duplicate (409), a missing delete (404) and every 400/403 roll back and do not bump.
- **Audit** (`observability.md`): `public_holiday.created`, `.deleted`, `.preset_applied`, each with `revisionTo`.

### Working days

`WorkingCalendar` is the pure working-day calendar (Flow's `WorkingDayIndex` ported over the closed-form Monday-Friday arithmetic): `isWorkingDay`, `workingDayIndex`, `workingDayOfIndex`, `nextWorkingDayOnOrAfter`, `previousWorkingDayOnOrBefore`, `plusWorkingDays`, `containsWorkingDay`, `workingDaysBetween`, `holidayName`.

- The index is monotone, flat over a weekend AND a holiday (both collapse onto the working day before), Friday → Monday = +1.
- The holidays are a constructor parameter (date → name), never read from the database by the kernel; `WorkingCalendar.MON_FRI` is the calendar without holidays (kernel tests and pure vectors).
- **Loading.** `loadWorkingCalendar()` (`planning/PublicHolidayService.kt`) reads the whole dictionary in one `SELECT` inside the caller's open transaction and builds the calendar ONCE per request: right after `readPlanRevision()` in `ProjectViewService.view`, `TeamViewService.view` and `loadRoadmapSnapshot` (the roadmap AND programs views share one read), and under the lock in `MilestoneService.schedule`.
  Never from a route, never cached across requests. A view's calendar sits inside its REPEATABLE READ snapshot, so it agrees with the revision and the rows.
- **What the calendar changes**, all through the wire: a dependency's required date skips a holiday and a lag counts working days; the weekly load spreads over the remaining working days; a holiday is uncovered (the capacity divisor stays 5) and runs no WIP; the roadmap's rolled-up links flip with it; a holiday-only schedule is a 400. A removed holiday restores every figure, because nothing derived is stored.

Pinned by: `PublicHolidayTest`, `HolidayPresetTest`, `PolishHolidaysTest`, `WorkingCalendarTest`, `PlanStateTest`, `ProjectViewDependenciesTest`, `TeamViewTest`, `RoadmapViewTest`, `MilestoneScheduleTest`.

## Idle gaps

Files: `planning/IdleGapKernels.kt`.

`idleGaps[{start, end, workingDays}]` rides `GET /views/project/{id}` and `GET /views/team/{id}` (spec schema `IdleGap`, by start; empty when there are none). An **idle gap** is a maximal run of at least **3** working days (`MIN_IDLE_GAP_DAYS`) inside the derived span on which nothing is in progress. Weekends and public holidays neither count nor break a run, and nothing before the first start or after the last end is reported.

- **Team**: working days on which the team has NO scheduled milestone in progress, inside the span of the team's scheduled milestones that hold a working day (`SpanKernels.derivedSpan`, not the 520-week load window, so no truncation flag). Only the team's own milestones count.
- **Project**: working days inside the span of the project's milestones that hold a working day on which none of its OWN milestones is in progress (another project's work of the same team fills nothing).
- **In progress** is the WIP rule of the team view: a scheduled milestone covers the working days of its EFFECTIVE span; a weekend-only or holiday-only span covers nothing (a milestone whose only day later became a holiday keeps its dates and stops splitting a hole).
- **The kernel** (`idleGaps(spans, within, calendar, minWorkingDays = 3)`, pure; the calendar is a parameter): spans become working-day-index intervals, sorted and swept with a cursor (`max`, so a nested span never pulls it back). A run closes at the next start or at the end of `within`. A gap answers its FIRST and LAST working day (ISO dates, never a weekend or holiday) and its length.
  `idleGapViewsOf(spans, calendar)` derives `within` from the spans that hold a working day (`containsWorkingDay`) and is what both services call. O(n log n).
- Hand-counted (2027-02-01 a Monday): milestones Mon 02-01 and Tue 02-09 leave Tue 02-02..Mon 02-08 = **5** working days; Mon 01 and Fri 05 leave Tue..Thu = 3, but with Wed 03 a holiday only 2 (no gap).

Pinned by: `IdleGapKernelsTest`, `ProjectViewTest`, `TeamViewTest`.

## The critical path

Files: `planning/CriticalPathKernels.kt`, `CriticalPathView.kt`, `RoadmapCriticalPath.kt`.

Per PROJECT, on the PLANNED dates; nothing moves. The path follows the driving chain through every project it passes. It rides `GET /views/project/{id}`, `GET /views/roadmap?criticalPath=N` and `GET /views/programs?criticalPath=N` ("The roadmap view"), and `GET /views/team/{id}`. No migration.

- **The team view** asks the question per milestone toward its OWN project's end: each `TeamMilestone` carries the SAME `slackDays`/`critical` the project page gives that milestone, and a link is `critical` when it lies on the chain of a project one of the team's milestones belongs to (a link that drives only a project none of them belongs to is not marked; its own project's page marks it).
  `TeamViewService` loads the graph once (`loadCriticalPaths`, `analyseAll`: one edge build, one walk per project of the team) inside its snapshot.
- **Inputs, one snapshot.** `ProjectViewService` loads, inside its REPEATABLE READ transaction right after the calendar, the WHOLE active graph with the roadmap's shared loaders (`milestoneFacts`/`linkFacts`/`activeProjectNames` in `RoadmapViewRows.kt`: every active milestone with its name, every link, every project name), then runs the pure `CriticalPathKernels.analyse(projectId, milestones, links, calendar)` once.
  A milestone whose project is not an active row is left out.
- **Values and edges** (`DependencyGraph.kt`'s `TimePoint`/`TimeSide` and `DependencyEdge.from`/`to`). A scheduled milestone has the half-open working-day values `S = W(first working day on or after start)`, `E = W(last working day on or before end) + 1` (exactly `DependencyKernels`' table); a project has `min S`/`max E` over its scheduled milestones.
  An edge `from -> to` with `offset` has slack `value(to) - value(from) - offset`.
- **The edges:** a milestone's `S -> E` (offset = its length, slack 0: the whole bar slips together); containment `S(project) -> S(milestone)` and `E(milestone) -> E(project)` (offset 0); a link `X(pred) -> Y(succ)` with offset `lagDays` for all four types, so **a link's slack equals `actual - required` of `DependencyKernels.check`**.
  **A PROJECT has no start-to-end edge** (its span is derived from its milestones; the edge would make every link into a project's START zero-slack through its END).
- **Excluded:** a link with an unscheduled end (no values) and a VIOLATED link (negative slack): never driving, caps nothing, and upstream it ENDS the chain (that project's page shows it red).
- **The upstream set and the float.** Walk the included edges backwards from `E(p)` (p the viewed project); the points that reach it are the upstream set U (downstream-only and unconnected points have no slack toward this project: `null`/absent).
  `float(E(p)) = 0` and `float(u) = min(slack(u -> v) + float(v))` over the edges into U, in the reverse topological order of U (Kahn; the acyclicity of "The cycle rule" makes it terminate, a leftover is `error("the active plan graph holds a cycle")`, a 500-grade invariant violation).
- **Slack.** A milestone's `slackDays = float(S)`: the working days it could slip, with everything downstream of it allowed to slip too, before THIS project's end moves. Internal milestones are always finite (containment reaches `E(p)`); an external milestone's slack is finite exactly when it is upstream, through any number of projects; a link from this project into another caps nothing unless its path returns to `E(p)`.
- **Critical** = zero float. Every milestone ending on the project's end is critical and parallel zero-slack chains are all critical. A milestone is critical when either point is, a link when its slack is 0 and its `to` point is critical, a project entity when either of its points is (it reports the minimum over its points in U).
  **hops** = the fewest LINK edges from one of its points to the viewed project (containment and a milestone's own start-to-end cost nothing; a direct neighbour is 1). An unscheduled milestone has `slackDays: null`, `critical: false`.
- **The wire.** Each `ProjectMilestone` adds `slackDays` (`null` while unscheduled) and `critical`; each `ProjectDependency` adds `critical`; the view adds `criticalPath{upstream[], upstreamTruncated}`: `UpstreamEntity{kind, id, name, projectId, projectName, startDate, endDate, slackDays, critical, hops}` for every milestone or project of ANOTHER project in U.
  A PROJECT is listed only when an included link names it; a project that merely contains upstream milestones is not.
- **Order and cap.** `orderUpstream` (pure) puts the CRITICAL entries first, read from the chain's origin (start date, end date, name case-insensitively, kind, id), then the rest by slack ascending (then the same keys). The critical ones are never cut; the non-critical are capped at **100** (`upstreamTruncated`).
- **`hops` is not a ghost-row filter:** it counts links only, so every milestone of a project that a link names is at hops 1. The page's "Critical chain" list is `criticalPath.upstream` minus the ends already shown in `dependencies[]` (matched by kind + id).
- **Cost.** Three linear passes over about 2,000 points and 3,000 edges (hash maps), under 1 ms; the extra reads are the roadmap's milestone and link statements plus one 100-row name read.

Pinned by: `CriticalPathKernelsTest`, `ProjectViewTest`, `ProjectViewDependenciesTest`, `TeamViewTest`, `RoadmapViewTest`.

## The auto-proposal

Files: `planning/ScheduleKernels.kt`, `ScheduleLedger.kt`, `ScheduleConstraints.kt` (the kernel); `ScheduleProposalService.kt`, `ScheduleProposalAssembly.kt`, `TeamScheduleRoutes.kt` (the endpoint); `ScheduleScope.kt`, `ScheduleSnapshot.kt` (the scope check).

The scheduling kernel is pure: no I/O, no clock, no randomness; the calendar, the clock date `asOf` and every row are parameters. It places ONE team's not-started milestones and answers a PROPOSAL; nothing moves. The user's answers that bind it:

- Every not-started milestone is re-planned from the earliest day. A link into another team's fixed milestone is placed anyway and reported. A day without capacity, or on hold, is unusable.
- A 0 MD milestone takes one working day and counts for WIP. The target window is NOT a constraint. A stale item is skipped and the rest land (the batch's rule).

### Placement

- **API.** `ScheduleKernels.propose(ScheduleInputs): ScheduleProposalResult` and `ScheduleKernels.postCheck(inputs, result): ScheduleProposalCheck`.
  `ScheduleInputs(asOf, teamId, team: List<TeamScheduleItem>, periods, plan: Collection<PlanMilestoneFact>, links: Collection<PlanLinkFact>, calendar, horizonWeeks = 520)`; `TeamScheduleItem(id, projectId, span: DaySpan?, estimateMd, key: OrderKey, pinned = false)`; `Placement(milestoneId, from: DaySpan?, to: DaySpan)` (`to == from` = it stays).
  `Unplaced(milestoneId, reason: NO_CAPACITY | NO_ROOM)`; `ScheduleProposalResult(placements, unplaced, spansAfter)`; `ScheduleProposalCheck(weeks: List<WeekLoad>, weeksTruncated, links: List<ScheduleLinkCheck(linkId, before: DependencyStatus, after: DependencyCheck)>)`.
  `Fraction` (`LoadKernels.kt`, the exact rational) and `DependencyKernels.requiredIndex` are the shared arithmetic (`internal`).
- **Movable / fixed.** MOVABLE = the team's milestones with no dates or a start AFTER `asOf`. FIXED = every other milestone: the other teams' always; this team's with `start <= asOf` (in progress or past; a weekend-dated start counts by its date) **and its PINNED dated milestones whatever their start**.
  The one predicate is `Pass.isFixed`: `span != null && (start <= asOf || pinned || id in held)`.
- **A pinned milestone** keeps its dates, its load is booked in the ledger at the even rate, its dates feed the link values (an FS successor starts after it, like another team's milestone), it is in `spansAfter`, and it is in NO placement and NO `unplaced` list.
  "Pinned" has two meanings here: the manager's pin (stored) and the fixpoint's internal "held" set below.
- **The ledger starts with this team's fixed milestones only** (their effective working days at the even rate `E/n`); a movable milestone's current dates are forgotten until it is placed (they survive as the order tiebreak only).
- **Order and hoisting.** Movable milestones are sorted by `effectiveOrder`. The PLACEMENT order hoists, depth-first in link-id order, the movable milestones of this team that a milestone must wait for: the predecessor of a link INTO it (any type), the movable milestones of a predecessor PROJECT, and the same for a START-bound link (FS/SS) into its project (containment).
  `placements` and `unplaced` are listed in the TEAM order.
- **An END-bound link (FF/SF) into a PROJECT** binds the project's derived end, which no single milestone owns: no bound, no hoist; the post-check reports it.
- **A hoisting loop is skipped, never an error.** The hoisting relation can close a loop on valid data (`a FF b` + `b SS a`: the cycle rule is on time points, the hoist on entities): an entity met again on the walk's stack is skipped (the bound it would have given is missing; only the post-check reports a link it leaves violated). A real cycle of the time-point graph fails closed first with `error("the active plan graph holds a cycle")`.
- **The ledger** runs per working day from the team's first USABLE day (a working day in a period with capacity above zero and a WIP limit above zero) to `horizonWeeks` weeks later: `dailyCap = mdPerWeek / 5` (the fixed divisor of `weekCapacity`), `share = dailyCap / (wipLimit ?: 1)`, and `wip` and `used` (exact `Fraction`s) booked by the fixed milestones and every placement.
- **Earliest start.** The later of the first working day after `asOf` and every START-bound lower bound: `requiredIndex` of each binding link whose predecessor has dates now (fixed, or placed in this run; a project predecessor = min start / max end over its dated milestones). A predecessor without dates binds nothing.
  END-bound links into the MILESTONE (FF/SF) demand the span's last working-day index be `>= required` (`last index >= requiredIndex`, the check's own comparison, instead of calling `DependencyKernels.check` per candidate), tested per candidate. All four types are lower bounds, so no link makes a milestone impossible, only later. A link between two fixed ends is not the scheduler's business.
- **Duration.** From a candidate start `s`, `n` = the smallest number of consecutive usable working days `d1..dn` with `E <= n x min(share(d1..dn))` (`E = 0` gives `n = 1`). For a constant share this is exactly `ceil(E / share)`; when a period lowers the share inside the span the span stretches, so the even rate `E/n` never exceeds the share of ANY of its days.
  A holiday inside a span costs a calendar day, not a working day. An unusable day ends the candidate.

### The candidate loop

- **Per DAY, stricter than the view's week rule and implying it.** The first start that fits: every day has WIP place (`wip + 1 <= limit` when a limit is in force that day) and room for the rate (`rate <= dailyCap - used`, exact), and the END-bound links hold. A conflict moves the start by ONE working day (the span length, hence the rate, depends on the start).
- **Two exact shortcuts only.** The first day alone (WIP full, or `used >= dailyCap` for `E > 0`) rejects every span starting there. A start from which even every remaining day of its usable run at the run's best share cannot carry `E` skips the whole run (a later start has fewer days and no greater share). A stretch without capacity costs one jump per run, never a walk.
- **Why one day at a time.** With a share that varies inside a span a later start can end earlier (a weak first day taxes the whole span), so a "jump past the conflict" could skip a valid start; the exact run-level pruning above gives identical results for a constant share.
- **Two levels.** The per-day test alone does not imply the view's week rule when FIXED load overbooks a day (3 MD on a 2/day day) or sits on a day without capacity or before the first candidate day. So the ledger also keeps, per ISO week, the exact `weekCap` (`sum of mdPerWeek/5` over ALL the week's working days, the view's `weekCapacity` unrounded) and the exact `weekUsed`
  (every booking's rate on every working day of the week, the days before the first candidate day and any unusable day included).
- **A candidate fits** only if the per-day test holds and, for every week it touches, `weekUsed + rate x (its days there) <= weekCap` (O(weeks touched) per candidate; a 0 MD estimate skips both load tests, WIP still applies). So the proposal never adds load to a week the view would show overloaded (`HALF_UP` rounding is monotone, so exact `load <= capacity` keeps the rounded comparison false).
  The fixed milestones' own excess (an overbooked in-progress milestone) stays and is shown, never added to.
  Example: F 3 MD on Mon 02-01 (`asOf` = 02-01), X 8 MD (4 days at 2): from 02-02 the week would load 3 + 8 = 11 of 10, so X starts Wed 02-03 (3 + 6 = 9; 02-08 loads 2).
- **Reasons.** `NO_CAPACITY`: no usable day exists at or after the milestone's earliest start (no period, or on hold from there on). `NO_ROOM`: usable days exist but no span fits before the horizon (`horizonWeeks` counted from the team's FIRST USABLE day, not from `asOf`: a team whose capacity starts years away is placed there). An unplaced milestone with NO dates needs nothing and is absent from `spansAfter`.
- **The fixpoint.** A SCHEDULED movable milestone that ends unplaced keeps its stored dates when the proposal is accepted, so its load is real: it is treated as fixed at its stored dates ("held": booked in the ledger, its dates feed link values), and the run repeats until the held set stops growing (at most `|movable| + 1` passes).
  It stays listed in `unplaced` with its reason and is present in `spansAfter` at its stored dates. Example: capacity on hold from 02-15, A 18 MD first in order, U 4 MD stored 02-08..02-09: accepting A's nine days would overload week 02-08 with U's kept dates, so U is held and A finds no nine free days either (both `NO_ROOM`; the week reads U's 4.00).
- **The post-check.** `weeks` = the view's own `weeklyLoad` over the team's spans AFTER the run (fixed + placed), the strip the team page shows after accepting everything. `links` = `DependencyKernels.check` before (stored spans) and after for every link with a MILESTONE end among the team's milestones plus every link with a PROJECT end whose derived span changed, violated-after first, then by link id.
- **Determinism and cost.** Inputs are sorted inside (`team` by effective order, `links`/`plan` by id, periods by `effectiveFrom`); nothing depends on hash order (pinned by shuffled inputs). Cost is bounded by the horizon, never by the data: arrays over at most about 2,600 working days; most candidates are O(1) thanks to the first-day tests,
  an end bound beyond the horizon answers `NO_ROOM` at once, a full candidate is O(days + weeks touched).

### Hand-counted vectors

`ScheduleKernelsTest`; 2027-02-01 is a Monday, capacity 10 MD/week from 2027-01-04 = 2/day, `asOf` Sunday 01-31, `MON_FRI`.

| Case | Result |
|---|---|
| 3 MD, WIP 2 (share 1) / no limit (share 2) | 02-01..02-03 / 02-01..02-02; 0 MD takes 02-01 (a second 0 MD under WIP 1 takes 02-02) |
| no limit, A 3, B 4, C 5 | A 02-01..02 (1.5/day), B 02-03..04 (2/day), C 02-05..09 (3 days at 5/3): the daily rule serialises what the week rule would run in parallel |
| fixed F Sat 01-30..Fri 02-05, X 4 MD, WIP 2 | F 5 MD: X 02-01..04. F 10 MD: X 02-08..11. F 15 MD (overbooked): X 02-08..11, week 02-01 stays 15.00 vs 10.00, nothing added |
| capacity 10, then 5 from Thu 02-04; X 7 MD | 7 days 02-01..02-09 (rate 1 is within every share); week 02-01 loads 5.00 against 3x2 + 2x1 = 8.00 |
| first period Mon 02-08 / no period / on hold / a period in 2086 | 02-08..02-09 / `NO_CAPACITY` / `NO_CAPACITY` / 2086-01-07..01-08 |
| on hold 02-08..02-12, 10 again from 02-15; X 3 MD, Y 10 MD | X 02-01..02; Y jumps the hold to 02-15..02-19. Hold for good: Y `NO_ROOM` |
| m 3 MD against a fixed P 02-01..02-05 (no limit) | FS 0: 02-08..09. FS 2: 02-10..11. FS -2: 02-04..05. FS -10: 02-01..02 (clamped). SS 1: 02-02..03. FF 0: 02-04..05. SF 0: 02-01..02 |
| Wed 02-03 a holiday | P ending 02-02, FS lag 2: 02-08..09. X 4 MD at 1/day: 02-01..02-05 (four working days, five calendar days) |
| order [c, a, b], `b -> c` FS (2 MD each, WIP 2) | b 02-01..02, c 02-03..04, a 02-01..02; `placements` read [c, a, b] |
| FF into a project | no bound; the post-check reads UNSCHEDULED before, `VIOLATED` after, shortfall 8 |
| `a FF b` + `b SS a`, a 3 MD, b 2 MD | b 02-01..02, a 02-01..03; the skipped hoist bound shows only as `a FF b` VIOLATED by 1 in the post-check |
| shuffled inputs / a cyclic plan / a dense 200-milestone team | identical output / `IllegalStateException` / no overloaded and no over-WIP week |

### The proposal endpoint

`POST /teams/{id}/schedule-proposal`, body `{asOf}`. ONE read-only REPEATABLE READ snapshot (the plan revision first, then the calendar and the rows: the team's milestones with their order keys, its capacity periods, EVERY active milestone and link) feeds `propose` and `postCheck`; nothing is stored, locked, bumped or audited. The answer's `revision` is the snapshot's plan revision (the batch's `expectedRevision`).
`asOf` is capped at `LAST_PLAN_DAY` minus the horizon (+1 week) so every proposed date stays writable. The guard order is `authorization.md`'s.

- **`moves`**: the placements whose span differs from the stored one (`from` null = unscheduled, `workingDays`, `shiftDays` in working days between the effective starts, null when newly scheduled). **`unchanged`**: the placements that land on their stored dates.
- **`unplaced`**: the kernel's verdicts with names (a scheduled milestone the fixpoint held at its stored dates is listed ONLY there).
- **`pinned`**: the team's pinned milestones that start after `asOf` (fixed by their pin; one already in progress is fixed regardless and not listed), in the team's effective order, in neither `moves` nor `unchanged`. The page says "N kept by a pin".
- **`weeks`/`weeksTruncated`** are the post-check's. **`dependencies`** are only the post-check's links whose verdict is VIOLATED before or after, each end slimmed to `{kind, id, name, projectName|null}` (no dates, no team; the full `check` carries `requiredDate`/`actualDate` after the moves, and `before` sits beside it).

### The scope check

`scopeHash` is the proposal's fingerprint of what the kernel read; the batch accept (`POST /teams/{id}/milestone-schedules`) recomputes it under the plan lock. The cross-team run's token is "The cross-team run"'s, and the two never match.

- **The token has three parts, 64 hex.** Chars 0-27 the **structure** digest (the first 28 hex of `sha256(canonical JSON of ScheduleScope)`, the scope WITHOUT the holidays); chars 28-55 the **holidays** digest (the first 28 hex of `sha256` of the canonical JSON array of the Monday-Friday holidays ascending, `WorkingCalendar.offDayDates()`: a weekend holiday changes nothing);
  chars 56-63 the proposal's `asOf` as days since 1900-01-01 in 8 hex (`ScopeDigests.token`, `ScopeToken`). Two proposals of an unchanged plan for the same `asOf` carry the same token.
- **The accept** carries `scopeHash` OPTIONALLY (absent: no check). It recomputes the token UNDER THE PLAN LOCK from the same function over the same row shape (`loadScheduleSnapshot` → `ScheduleSnapshot.scopeDigests`, the proposal's own loader) and refuses the WHOLE batch with `409 stale-scope` (nothing written, no bump, no audit) on a different STRUCTURE part,
  or when another milestone of the team that the batch does not name has `schedule_revision > expectedRevision` (the team sweep). A token of another layout lands in the same refusal: a proposal open across an upgrade is refused once and proposed again by the page.
- **In the structure hash:** the team's milestone set with each one's project, estimate and **pin** (a pin flipped after the proposal is a `409 stale-scope`); the team's effective ORDER (stored positions, the projects' global rank, project and milestone names, ids) with the milestones' own start/end taken out of its tiebreak (as the id sequence, so an absolute rank shift that reorders nothing is not a change);
  the capacity periods (`effectiveFrom`, man-days, WIP); every link with an end that is a team milestone or a project holding one, each end carrying the span of its FOREIGN part (a foreign milestone's own span; a project's derived span over its milestones of OTHER teams).
- **Out of the structure hash:** the Monday-Friday holidays (their own digest); the team's OWN milestones' spans, fixed or movable, scheduled or not (covered by `schedule_revision`: a batch item is the per-item `STALE`, any other team milestone is the sweep, so a colleague dragging a batch item skips that item and the rest land, and the team's own accepted moves never stale a later accept); the horizon (not state).
  A change of the other teams' milestones that no link of the team touches changes nothing the kernel reads and does not flip the hash.
- **The look-again.** When the structure and the sweep pass and ONLY the holidays part differs, the accept does not refuse. It decodes `asOf` from the token (a day past `LATEST_AS_OF`, or any other undecodable part, is `409 stale-scope`), runs the kernel ONCE on the snapshot the check just loaded (`ScheduleKernels.propose(snapshot.inputs(teamId, asOf))`, `proposeMany` for a run; `ScheduleSnapshot.freshSpans`)
  and goes through only when EVERY item carries both dates and equals the fresh `spansAfter` of its milestone (`acceptsOnlyFreshDates`: another date, an unschedule pair, a milestone the fresh run does not place are all `409 stale-scope`; nothing written, no bump).
- **What the look-again writes** is exactly what a proposal computed now, on the current dictionary, would propose for those milestones: the page's own "propose again, accept the same ticks" without the round trip. A far-off holiday and a near one that moves nothing pass; a holiday inside an accepted span, or on a day that moves one, refuses. A colleague's drag of a batch item together with a holiday change refuses the batch instead of skipping the item.
- **Cost.** With unchanged holidays the check is the digests only and runs NO kernel (the `asOf` part is not even decoded); on the look-again path one kernel run under the plan lock.
- **Known consequence.** The per-item `STALE` rule judges each item alone: if a batch item is the hoisted predecessor of another batch item and is skipped as `STALE`, the dependent item is still written against the predecessor's PROPOSED dates and its link may read violated on the team view, which only warns. The page re-proposes at once on this 409 (`web-internals.md` "Teams and the team page").

Pinned by: `ScheduleKernelsTest`, `ScheduleProposalTest`, `ScheduleScopeTest`, `TeamScheduleScopeTest`, `CrossTeamAcceptTest`.

## The cross-team run

Files: `planning/CrossTeamKernels.kt` (the kernel); `CrossTeamSchedule.kt`, `CrossTeamProposalService.kt`, `CrossTeamScheduleRoutes.kt`, `ScheduleSnapshot.kt`, `ScheduleScope.kt` (the endpoints); `TeamScheduleService.acceptRun`, `TeamSchedule.kt` (the accept).

"The auto-proposal" places ONE team with every other team's dates fixed, and accepting every team in turn never reaches a global fixed point (the other teams' dates are constraints, so the first team moves again after the rest were accepted). The cross-team run is that proposal over a SET of teams (the user's answer). It is pure like the kernel it is built on (no I/O, no clock). Nothing moves; a run stores nothing.

### Kernel

- **API.** `ScheduleKernels.proposeMany(MultiTeamInputs): MultiTeamResult` (extension functions on the `ScheduleKernels` object). `MultiTeamInputs(asOf, teams: List<TeamRun>, plan, links, calendar, horizonWeeks = 520, maxPasses = MAX_CROSS_TEAM_PASSES)`; `TeamRun(teamId, name, team: List<TeamScheduleItem>, periods)` (`name` is only the team order's tiebreak).
  `MultiTeamResult(order, passes, settled, byTeam: Map<teamId, ScheduleProposalResult>)`: `byTeam` iterates in `order`; each value is the team's result of the LAST pass, the very `ScheduleProposalResult` of the per-team kernel.
- **`MAX_CROSS_TEAM_PASSES = 5`**, a separate constant from the per-team fixpoint's (that one is internal to each team's run). `propose` itself is `requireAcyclicPlan` + `proposeUnchecked`; the run calls `proposeUnchecked` per team and pass and checks the plan ONCE (containment over `plan` and every run team's rows, all links), because 75 acyclicity checks of about 300 DFS over 2,200 points would be the whole cost.
- **Each team is placed by today's kernel,** with the teams placed so far as FIXED facts. The other teams enter a team's run only through `inputs.plan`: the run keeps a working copy of the plan facts and, after a team, replaces that team's facts by the spans it ended on (a milestone with no span after the run gets `null`). The team's own facts are ignored by teamId, so its `TeamScheduleItem.span` stays the STORED span (the `from` of a move, the fixed test, the order tiebreak).
  Before the first pass every run team's facts are its stored rows. **Pinned milestones are fixed everywhere:** in their own team's run, in its `spansAfter` at the stored dates, as the stored dates in every other team's facts, and in no placement list.
- **The team order.** A team graph over the run's teams has an edge `a -> b` per link with an end on `a` and the other on a different team `b` (a MILESTONE end is its plan fact's team, a PROJECT end every run team holding one of its milestones; teams outside the run add no edge, their dates never change).
  Influence flows only along links (`ScheduleConstraints.bounds` reads link predecessors), so the graph captures every path by which one team's placement can change another's.
- **Kahn's algorithm** picks among the READY teams (no incoming edge from a remaining team) by ONE comparator: **the most movable milestones first** (`span == null || (start > asOf && !pinned)` at the stored dates, the complement of the kernel's fixed test), then the **name case-insensitively**, then the **id**.
- **The cycle break.** When a cycle leaves no team ready the same comparator picks among the teams of the SOURCE strongly connected components of what remains (a team is eligible when every remaining team that reaches it is also reachable from it; closure per round over at most 50 teams), so a team merely downstream of a cycle is never placed before that cycle.
  An edge whose source is placed after its target is a **back edge** (only a cyclic team graph has any): the target read the source's dates of the PREVIOUS pass.
- **Passes and `settled`.** Every pass places every team in `order` once. A team is **changed** in a pass when its `spansAfter` differs from its previous result's (pass 1: from its stored spans). After a pass, **`settled`** = no team changed in it is the SOURCE of a back edge (a change read only by later-placed teams was already seen in this pass, so a next pass would reproduce every result); then the run stops, `passes` = the passes made.
  After `maxPasses` without settling: `settled = false` and the last pass's results stand (each team's dates are self-consistent; the cross-team links that still fail are what the post-check reports).
- **Pinned consequences.** An acyclic team graph settles in ONE pass; a single team always does and equals `propose`; teams with no link between them each equal their own `propose`; the request order never matters (the order is computed); shuffled `teams`/`plan`/`links`/rows give the identical result.
- **`checkMany(inputs, afterByTeam)` and `postCheckMany(inputs, result)`.** `before` = every plan fact's stored span (the run teams' from their rows); `after` = the stored spans of the teams OUTSIDE the run plus `afterByTeam` (team → milestone → span, an id absent = no dates); a run team with no entry fails closed with `NoSuchElementException`.
  Per team: `weeks` = the view's `weeklyLoad` over its after-spans (`ScheduleKernels.proposedWeeks`, also `postCheck`'s) and `links` = `teamLinkChecks`: a link with a MILESTONE end among the team's, or a PROJECT end that holds one of the team's milestones AND whose derived span changed.
  So a link between two run teams is in BOTH lists. For ONE team the holding clause is implied and `postCheck` is unchanged. `postCheckMany` is `checkMany` over the run's own final spans.
- **`CheckInputs(teams, plan, links, calendar)`** (`MultiTeamInputs.checkInputs()`, `CrossTeamSnapshot.checkInputs()`) is the narrower input of `checkMany`: no `asOf`, horizon or pass limit, so none can be read by mistake.
- **Cost.** 15 teams x up to 5 passes = up to 75 `proposeUnchecked` calls plus one acyclicity check: about 285 ms a run on the sample's sizes, `postCheckMany` about 15 ms (`ScheduleKernelsScaleTest`, tripwire 20 s). The fallback if a real plan measures slow is a per-pass worklist (re-run only the teams whose incoming facts changed); not built.

### The run endpoint

`POST /api/v1/schedule-proposals`, body `{asOf, teamIds[1..50]}`, answers `{revision, asOf, passes, settled, teams[], scopeHash}`. A COMPUTATION like the per-team proposal: `200`, no lock, no bump, no audit event, nothing stored. `teams[]` is in PLACEMENT order (`MultiTeamResult.order`; no separate `order[]`).
Each block is the per-team proposal's shape without the run-level fields: `{teamId, name, moves, unchanged, unplaced, pinned, weeks, weeksTruncated, dependencies}` (`proposalLists` and `proposalLinks` are shared with the per-team service through `ScheduleProposalAssembly.kt`). `dependencies` are the links touching THAT team, violated before or after over the WHOLE run's final dates (`postCheckMany`).

- **Order of checks.** The team SET is in the body, so it differs from the per-team route: the body decodes first (a malformed body is a `400` even for a caller the guard would refuse); `validateTeamIds` `400` (1..50, none twice); `PlanRouteDeps.requireTeamManagers` (every team ACTIVE else `404` for EVERY caller, `TeamService.activeNamesAmong`, one query);
  `requireTeamManagerOfAllOrAdmin` (ADMIN, or one `activeManagedTeamIds` query and every listed team in it, else `403`); then `asOf` `400` (`validateAsOf`; a forbidden caller's malformed `asOf` stays `403`).
- **One snapshot, no lock.** `CrossTeamProposalService.propose` is ONE read-only REPEATABLE READ transaction whose FIRST statement is the plan revision, then the teams' names, the calendar, per team `teamMilestoneRows` / `positionsOf` / `teamCapacityRows`, and the plan-wide `milestoneFacts` / `linkFacts` read ONCE (`loadCrossTeamSnapshot` → `CrossTeamSnapshot`),
  so `revision`, every block, the link verdicts and `scopeHash` describe one plan. A team deleted between the guard and the snapshot is the same `404`.
- **`scopeHash`** is the same three-part token as the per-team proposal's ("The auto-proposal" › "The scope check"; the holidays digest and `asOf` as there; `CrossTeamSnapshot.scopeDigests`), but the structure digest is over `ScheduleRunScope`: the teams sorted by id with their LOWERCASE names (the team order's tiebreak reads the name, so a rename can change the placement)
  plus one `ScheduleScope` per team built with the WHOLE run set as "own" (`scheduleScope(..., runTeamIds)`; the per-team endpoints keep the default `setOf(teamId)`).
- **"Foreign" = outside the run.** A run team's milestone spans are NOT in the hash (each is covered by its `schedule_revision`: a colleague's drag of a ticked item must skip that item, not refuse the run); a team outside the run enters only through the links that touch a run team.
- **`GET /api/v1/schedule-proposals/teams`** answers `{items[{id, name}]}`: the ACTIVE teams the caller may include (ADMIN: all; otherwise `PlanPermissions.canSchedule` over the actor built with `withManagedTeams`, one query), by name (case-insensitive) then id. It is the page's multi-select; the server's `403` stays the rule.
- **Size.** The sample-density plan (15 teams, 1,000 milestones, 300 links) answers about 470 KB uncompressed in 3 passes, settled (`CrossTeamProposalSizeTest` gates the bytes at 600,000 B with a 10 s tripwire).

### The accept

`POST /api/v1/schedule-proposals/accept`, body `{expectedRevision, scopeHash, teamIds[1..50], items[1..2,000]}` (`MAX_RUN_SCHEDULE_ITEMS`; items are the per-team batch's `{milestoneId, startDate, endDate}`), answering the per-team batch's `{revision, accepted, skipped}`: N teams' schedule PUTs in ONE plan write, ONE bump (an all-skipped accept bumps too).

- **Two deliberate differences from the per-team batch's body, both forced by the hash.** `teamIds` is IN the body (the run's fingerprint is over a team SET the items do not determine: a team whose moves were all unticked is still a premise of the run, so it must still be locked, re-guarded and checked). `scopeHash` is REQUIRED (a missing field is a `400` at the decode).
- **Order of checks.** Body decodes (`400`) → `validateTeamIds` `400` → every team ACTIVE else `404` → `requireTeamManagerOfAllOrAdmin` `403` → the rest of the shape `400` before the lock (`validateCrossTeamAccept`; a forbidden caller's malformed items stay `403`).
- **Inside `withPlanWrite`:** for each team in ASCENDING id order `lockActiveTeam` (`404`, `FOR SHARE`) then the locked guard (`teamManagerGuard`, `403`: ADMIN, or the ACTIVE manager of EVERY team as of the lock) → `expectedRevision` above the plan revision `409 stale-revision` → `requireRunScopeUnchanged` → the per-item rules.
- **`requireRunScopeUnchanged`** is `409 stale-scope` when the hash recomputed under the lock differs (`loadCrossTeamSnapshot` with the teams' CURRENT names, read after the team rows were locked, through the very loader and `CrossTeamSnapshot.scopeDigests` the run used; a different holidays part only is the look-again of "The auto-proposal" › "The scope check": `proposeMany` once, the items must equal the fresh spans),
  **or** when ANY milestone of ANY run team that the accept does not name has `schedule_revision > expectedRevision` (`reschedulesOutsideBatch(teamIds, …)`: `teamId IN (set)`, one `LIMIT 1` query). The sweep covers the FIXED milestones (started, pinned) too, whose spans the run's hash deliberately does not read; a pin flip is in the hash.
- **The per-item rules** (`decideItems`, shared with `batch`): the first of `GONE` / `NOT_ON_TEAM` (the item's STORED team is outside the set) / `NO_WORKING_DAY` / `STALE` skips it; the rest are written by `writeSchedules` with `schedule_revision = revision + 1`. A GONE or NOT_ON_TEAM item is data in the `200`, never a refusal.
- **The per-team and the run hash never cross.** The two definitions of "foreign" differ, so a per-team `scopeHash` on the run accept and a run `scopeHash` on `POST /teams/{id}/milestone-schedules` are both `409 stale-scope`; `CrossTeamAcceptTest` pins both ways so nobody "fixes" it.
- **Audit** (`observability.md`): `milestone.scheduled` per changed item with the item's STORED team (`AcceptedSchedule.teamId`, which the per-team batch fills too), `milestone.unpinned` per released pin, and ONE `team.schedule_batch_applied` per team of the set (ascending id) over the items whose stored team it is, plus the additive `runTeamIds`.

### The check

`POST /api/v1/schedule-proposals/check` (`CrossTeamProposalService.check`), body `{teamIds[1..50], items[1..2,000]}` (the accept's items; the null pair unschedules; no `asOf`: no verdict reads it) answers `{teams[{teamId, weeks, weeksTruncated, dependencies}]}` in the REQUEST's team order. It answers "what if only THESE moves were accepted".

- **How.** Each listed team's `after` is its STORED spans (`CrossTeamSnapshot.storedSpansOf`) with exactly the items overlaid, every other milestone keeps its stored dates, and `ScheduleKernels.checkMany` gives `weeks` and `dependencies` (the links touching the team that are or were violated, as the proposal's).
  So an unticked move keeps its stored dates, and a successor ticked WITHOUT its predecessor is judged against the predecessor's stored (or colleague-moved) dates.
- **What it cannot do.** The check cannot anticipate a skip (`STALE`, `NO_WORKING_DAY`); it describes the ticked subset as written. For the spans of a per-team proposal the answer equals that proposal's `weeks` and `dependencies`. Both pages call it, debounced: the cross-team page with the run's set, the team page with its one team.
- **Order of checks** (the team set is in the body): decode `400` → `validateTeamIds` `400` → every team ACTIVE else `404` → `requireTeamManagerOfAllOrAdmin` `403` → the items' shape `400` (`validateScheduleCheck`, after the guard) → ONE read-only REPEATABLE READ snapshot (no lock, no audit, nothing stored; a team deleted in the gap is the same `404`)
  → an item whose milestone is not an ACTIVE milestone of a listed team (unknown, deleted, another team's) is a `400` naming the ids (a client bug: ignoring it would make the verdicts describe another subset).

### Hand-counted vectors

`CrossTeamKernelsTest`; the builders and calendar of `ScheduleKernelsTest` (2027-02-01 a Monday, 10 MD/week from 2027-01-04 = 2/day, `asOf` Sunday 01-31, `MON_FRI`).

| Case | Result |
|---|---|
| two teams with no link | each equals its own `propose`, one pass; equal movables, the name decides |
| A: a1 4 MD stored 02-22..02-23, `a1 -> b1` FS; B: b1 2 MD unscheduled | order [A, B] whatever the request order; a1 02-01..02-02, b1 02-03 (the PROPOSED end, not the stored 02-23); one pass |
| cycle `a1 -> b1 -> a2`, A at 50 MD/week | order [A, B] (2 movables vs 1); pass 2 moves a2 only; `passes 2`, `settled` (B unchanged) |
| the same at 10 MD/week | `passes 3`, `settled`; with `maxPasses` 2: `settled = false`, the pass-2 dates stand |
| the 50 MD/week cycle with `maxPasses` 1 | `settled = false`; `postCheckMany` lists `b1 -> a2` in BOTH teams: `UNSCHEDULED` before, `VIOLATED` after |
| B: b1 pinned 02-15..02-16, `b1 -> a1` FS | order [B, A]; b1 stays, in no placement or unplaced list; a1 02-17; unpinned: b1 02-01, a1 02-02 |
| a team cycle, 3 movables vs 2 / equal counts / equal names | the team with more movables first / the lower name, case-insensitively / the lower id; an in-progress or pinned milestone is not counted |
| a team merely downstream of a cycle | the cycle's source component is placed first, the downstream team after the cycle's FINAL dates |
| `a1 -> b1` plus `P -> Q` (both projects hold only B's milestones) | link 1 in both teams' lists, link 2 in B's only |
| shuffled inputs / a cyclic plan / a team twice / `maxPasses` 0 | identical result / `IllegalStateException` / `IllegalArgumentException` x 2 |

Pinned by: `CrossTeamKernelsTest`, `ScheduleKernelsScaleTest`, `ScheduleKernelsTest`, `CrossTeamProposalTest`, `CrossTeamProposalSizeTest`, `CrossTeamAcceptTest`, `ScheduleCheckTest`, `PlanStateTest`.

## Baselines

Files: `planning/Baseline*.kt`, `*BaselineOverlay.kt`.

A **baseline** is a named, immutable copy of the plan's DATED STRUCTURE taken at one plan revision: every ACTIVE milestone (name, project, team, estimate, dates) and every ACTIVE project (name, program, work stream, target window, rank position, derived span), everything the timelines draw.
Links, capacity periods, holidays and team orders are NOT copied (they do not "move"; the comparison is about dates). Plan-wide only: one object at one revision, which every page filters to its own rows. Nothing is edited inside a baseline; baselines are not scenarios (one live plan).

### The registry

- **Tables** (`persistence.md` "The baselines (V20)"): `baselines` is the header (soft-deleted; `uq_baselines_name_active` over `LOWER(name)`; `plan_revision`, `milestone_count`, `project_count`, `created_by_user_id`). `baseline_projects` and `baseline_milestones` are the two FROZEN row tables (no FK to a live row).
  Typed rows rather than a JSON document: the `DATE`/`NUMERIC` idioms, CHECKs, indexed per-team and per-project reads, and a 50-row overlay never parses 1,000 entries.
- **Immutability is the database's.** A `BEFORE UPDATE OR DELETE` trigger and a `BEFORE TRUNCATE` one refuse every change to the frozen tables (Flow's `metrics.forbid_snapshot_change` ported without its purge bypass). The header has its own triggers: never hard-deleted, and `id`, `plan_revision`, `created_by_user_id`, the counts and `created_at` never change; only name, description, `updated_at` and the soft-delete flag do.
- **The create** (`BaselineService.create`, one `withPlanWrite`): the grant is re-read under the lock (`requireRoadmapEditorOrAdmin`, the ranking's TOCTOU rule) → the cap (`MAX_ACTIVE_BASELINES` = 100 active; 409 `urn:astrolabe:problem:baseline-limit`, "The limit of 100 baselines is reached: delete one first")
  → the facts: `loadRoadmapSnapshot` (the roadmap's loaders and ONE `RoadmapKernels` run, so a baseline project's span, rank and target are exactly what the roadmap showed at that moment) plus `baselineMilestoneFacts` → the header (a name clash is the unique index's 23505 → 409, before the bulk rows) → one `insertRows` per frozen table → the audit.
- **One revision.** The plan lock makes the copy the plan at ONE revision. The create bumps the revision like any plan write and stales no client write (`schedule_revision`, the ranking's and the team orders' revisions are untouched, like a holiday write). **`plan_revision` = `revision + 1`** (the revision the create LEFT BEHIND: `withPlanWrite` hands the block the old one),
  so a view whose `revision` equals it shows zero movement; any later state orders against it.
- **Rename and delete** run under `withPlanWrite` too. `PUT` re-guards, locks the ACTIVE row `FOR NO KEY UPDATE` (gone = 404), updates name and description (audit only on a change; a no-op still bumps the revision). `DELETE` re-guards and flips `marked_as_deleted` (the name frees; the frozen rows stay as history). A deleted baseline reads as 404 everywhere.
- **API** (tag `plan`; the spec; guards in `authorization.md`): `POST /baselines` `{name, description?}` → `201` + `Location` + `Baseline`; `GET /baselines` → `{items, can{manage}}`, the ACTIVE baselines newest first (`created_at` then `id`, descending), a bounded set (at most 100 by the cap), not paged; `GET /baselines/{id}`; `PUT /baselines/{id}` → `204`; `DELETE /baselines/{id}` → `204`.
  Name and description follow the registry rules (trimmed single-line name 1..100, description at most 500).
- **`Baseline {id, name, description|null, planRevision, createdAt (epoch millis), createdBy {userId, name}|null, milestoneCount, projectCount}`.** `createdBy.name` is the login's linked ACTIVE person's name, else its display name (`users.name`), NEVER its email (which would reach every reader and is a targeting aid on a lockout-prone account); `createdBy` is null once the login is gone.
- **Audit** (`observability.md`): `baseline.created`, `baseline.updated` (only on a change), `baseline.deleted`.

### The overlay

`?baseline=N` on `GET /views/project/{id}`, `/views/team/{id}`, `/views/roadmap` and `/views/programs`: ONE request, ONE snapshot. The baseline header and the frozen rows are read inside the view's own `REPEATABLE READ` transaction right after the revision, so the deltas are consistent with the bars and no second revision exists to reconcile.

- **Additive.** Every field it adds is `null`-defaulted with `@EncodeDefault(NEVER)` (Ktor's JSON encodes defaults, which would write `"baseline":null`): **without the parameter a view answers the exact bytes it answered before**. The tests compare the plain document with the overlay document minus its `baseline` keys and assert the plain one has none (`assertOverlayIsAdditive`).
- **Errors.** `?baseline=` is parsed in the route (`optionalUInt`: a repeated or non-integer value is a plain `400`). The view's OWN rules come first (a gone project or team is `404` for every caller), then the header: unknown or soft-deleted gives `400` `urn:astrolabe:problem:unknown-baseline` "Unknown or deleted baseline id: N" (`TypedBadRequestException`; the id is a query value the client held, so the page clears its pick and asks again).
- **Movement** is `BaselineKernels` on the live rows the view already holds (the unrounded estimate is kept beside the wire figure).
- **Loaders** (`BaselineRows.kt`, one indexed select each, inside the view's snapshot after `readPlanRevision()`): `activeBaseline(id)`, `frozenProjects(id)` / `frozenProject(id, projectId)`, `frozenMilestonesOfProject(id, projectId)`, `frozenMilestonesOfTeam(id, teamId)`, `frozenMilestonesById(id, ids)`, `frozenMilestones(id)`, plus `teamNames(ids)` (any team, active or not) and `liveTeamsOfMilestones(ids)`.
- **Project view.** `baseline{id, name, planRevision, project{span, movement}|null (null = the project is newer), milestones[{milestoneId, teamIdThen, start, end, estimateMd, movement}], removed[{milestoneId, projectId, name, teamId, teamName, estimateMd, start, end}]}`. `milestones` has one entry per LIVE milestone, scheduled or in the tray, that has a frozen row, by id (a live milestone without an entry is NEW).
  `removed` holds the frozen rows of the project with no active live row. Frozen rows: `idx_baseline_milestones_project`.
- **Team view.** The same `milestones[]` for the team's live milestones (the frozen rows are the team's own, `idx_baseline_milestones_team`, plus those of live milestones that sat on another team then, by primary key; `teamIdThen` differing from the viewed team reads "from {team}").
  `removed[]` = the baseline's milestones of THIS team that are no longer on it, with `now{teamId, teamName}` when the milestone still exists on another team and no `now` when it was deleted.
- **Roadmap.** Each `RoadmapProject` the baseline also froze gains `baseline{span, movement, rankPosition, targetStart, targetEnd}` (ABSENT = the project is newer: the field cannot be an explicit null under `NEVER`). The document gains `baseline{id, name, planRevision, removedProjects[{projectId, name, programId, programName, workStreamId, workStreamName, span}]}`, by work stream, program, name, id;
  the program and work stream ids are as frozen, and either may be gone now.
- **Programs.** The same project rows; a document `baseline` that is the roadmap's `RoadmapBaseline`, built from the same overlay; and on every program and work stream `baseline{span, movement}`: the `derivedSpan` of the frozen spans of its CURRENT projects (programs, for a stream) that the baseline froze, against its live span (`ProgramsTree.assemble`, `TreeBaseline`), absent when none was frozen.
  A project that moved between programs rolls up under its CURRENT program on both sides. A removed project takes no part in the frozen roll-up, so a program that lost a project can read UNCHANGED, but the page appends it as a dimmed row under that program (`removedProjects`, also the comparison page).

### The comparison view

`GET /views/baseline/{id}` (any authenticated; `BaselineView.kt`, `BaselineViewService.kt`, pure `BaselineComparison.kt`) answers `{revision, baseline (the registry's Baseline), totals{milestones, projects}, projects[{projectId, name, programName, workStreamName, rankThen, rankNow, baselineSpan, span, movement, counts}], milestones[{milestoneId, name, projectId, teamId, teamName, frozen{start, end, estimateMd}|null, live|null, movement}]}`.

- **Errors.** An unknown or soft-deleted id is `404` (it is the addressed resource; the overlays answer `400` because there the id is a query value); a malformed id is `400`.
- **One snapshot:** the plan revision, the header, `loadRoadmapSnapshot(…, withLinks = false)` (the live projects with rank and derived span; the links statement is skipped), `baselineMilestoneFacts()` (the live milestones with estimate), the frozen rows of both tables and the team names.
- **Rows.** `projects[]` is the UNION of frozen and live projects (a project newer than the baseline has `movement.kind` ADDED, a gone one REMOVED with `span` null), by work stream, program, name (case-insensitive), id, with the live names where it exists. `counts` and `totals` cover EVERY row.
  `milestones[]` lists ONLY the changed rows (any kind but UNCHANGED, or an estimate delta that is not zero) in the projects' order, then by start (the live one, else the frozen; undated last), end, name, id. Bounded by the plan's scale (at most 100 project rows, 1,000 milestone rows).
- **Two baselines.** `?against=N` (`optionalUInt`) swaps the "now" side from the live plan to baseline N's frozen rows: the path id is "then", N is "now", `against` (a `BaselineResponse`, ABSENT without the parameter so the plain document is byte-identical) names it, and the fields named `live`/`rankNow`/`span` read N.
  `BaselineComparison` is side-neutral over `CompareProject` and `MilestoneCapture` (`FrozenProjectRow.toCompare()`, `FrozenMilestoneRow.toCapture()`, `RoadmapProject.toCompare()`).
- **In `against` mode:** ADDED = in N only, REMOVED = in the path baseline only; names and teams are N's when the row is in N (a team deleted since is still named); any order is allowed (the older one as `against` reads as negative movement); two baselines at one plan revision compare as all UNCHANGED.
  Still ONE snapshot: the live roadmap snapshot is not read, only the calendar (movement is on the CURRENT calendar in both modes).
- **Order of errors:** a malformed or repeated `against` is a plain `400` (the route), the path id's `404`, then `against == id` a plain `400` ("A baseline cannot be compared with itself") and an unknown or deleted N the `400` `urn:astrolabe:problem:unknown-baseline`.

### The comparison kernel

`BaselineKernels.kt`, pure: `milestoneMovement(frozen?, live?, calendar)`, `spanMovement(frozenSpan?, liveSpan?, calendar)` (projects, programs, work streams), `totals(movements)`.

- **Deltas are WORKING days on the CURRENT calendar, positive = later:** `startDays = W(live effective start) - W(frozen effective start)`, `endDays` likewise on the effective ends (`shiftInWorkingDays`/`endShiftInWorkingDays` in `SpanKernels.kt`, shared with the proposal's `shiftDays`; effective start = next working day on or after, effective end = previous on or before).
- **Kinds.** No frozen row `ADDED`, no live row `REMOVED` (deltas null); undated → dated `SCHEDULED`, dated → undated `UNSCHEDULED`, both undated `UNCHANGED` (deltas null); both dated with both deltas 0 `UNCHANGED` (a Saturday start moved to its Monday is no movement), else `MOVED`.
- **Estimate and totals.** `estimateDelta = live - frozen` whenever both rows exist (an estimate change alone stays `UNCHANGED`). `totals.later`/`earlier` = the `MOVED` rows with `endDays` > 0 / < 0 (a start-only move is `moved`, neither).

Vectors (`BaselineKernelsTest`; 2027-02-01 is a Monday), frozen 02-01..05 unless stated:

| live | kind | (start, end) |
|---|---|---|
| 02-08..12 / 01-25..29 | MOVED | (+5, +5) later / (-5, -5) earlier |
| 02-01..08 / 02-02..05 | MOVED | (0, +1) later / (+1, 0) neither |
| Sat 01-30..Fri 02-05 / 02-01..Sat 02-06 | UNCHANGED | (0, 0) |
| 02-08..12 with Wed 02-03 a holiday | MOVED | (+4, +5) |
| Mon 02-01 a holiday, live 02-02..05 | UNCHANGED | (0, 0) |
| null to 02-01..05 / 02-01..05 to null / null to null | SCHEDULED / UNSCHEDULED / UNCHANGED | null |

Pinned by: `BaselineTest`, `BaselineCopyTest`, `BaselineViewTest`, `ProjectViewBaselineTest`, `TeamViewBaselineTest`, `RoadmapViewBaselineTest`, `ProgramsViewBaselineTest`, `BaselineKernelsTest`, `PlanStateTest`, `PlanPermissionsTest`, `MigrationChecksumTest`.

## The view documents

**View endpoints are the one shape exception** to the paged envelope of `list-endpoints.md`: each answers ONE unpaged document, read in one snapshot. This section owns the shapes and the caps; the per-view sections below own what each figure means.

- **Every view** carries a `revision` (except the links reads `GET /views/jira-links` and `GET /integrations/flow/teams`: no plan state) and `can` flags (except those two, the home view and the team-load view), and has capped sub-lists; the spec documents each cap.
- **The four timeline views** (`/views/roadmap`, `/views/project/{id}`, `/views/team/{id}`, `/views/programs`) carry `jiraSites[]` (rows add `jira`, `flags`) and take an optional `?baseline=N`: the SAME document plus additive `baseline` blocks from the same snapshot, absent without the parameter ("Baselines" › "The overlay").
- **Ten of the views answer through a validator** (`ETag`, `If-None-Match`, `304`; "View validators").
- **The integration views** (`GET /views/deviations`, `GET /integrations/flow/teams`, `GET /views/capacity-deviations`) are unpaged one-snapshot documents; their shapes are in `jira-sync.md` and `flow-sync.md`.
- **Ordinary resource lists keep the envelope.** Projects and milestones have a paged list (`GET /projects` rows add `programName`/`workStreamName`, `GET /milestones` rows add `projectName`/`teamName`; "The picker and milestone lists"); work streams and programs have none, the plan view is theirs.

| Route | Answers | Caps |
|---|---|---|
| `GET /views/plan` | `{revision, can, workStreams[…programs[…projects[…]]]}`, each node with `can` | the plan |
| `GET /views/roadmap` | `{revision, can{editRank}, teams[], ranked[{position, project}], unranked[], links[]}`; `?criticalPath=N` adds `criticalPath` | about 100 projects, 300 pairs |
| `GET /views/programs` | `{revision (the plan's), teams[], links[], workStreams[{…, span, flags{warnings, infos}, programs[{…, span, flags, projects[<the roadmap's project row>]}]}]}`; `?criticalPath=N`; empty nodes present | about 100 projects |
| `GET /views/project/{id}` | `{revision, project{…, can}, span|null, drift|null, scheduled[], unscheduled[], dependencies[], idleGaps[], criticalPath{upstream[], upstreamTruncated}}` | about 50 milestones, each with `can`; `upstream[]` = the critical chain plus at most 100 others |
| `GET /views/team/{id}` | "The team view" | about 100 milestones, at most 520 weeks |
| `GET /views/baseline/{id}` | `{revision, baseline, totals{milestones, projects}, projects[], milestones[changed rows]}` (`404` if gone; `?against=N`: two baselines) | 100 projects, 1,000 milestones |
| `GET /views/home` | `{revision (the plan's), plan{…, flags, conflicts, overloadedTeams, wipExceededTeams}, me|null{personId, name, workStreams[], programs[], projects[], teams[], truncated}, jiraSites[]}`; no `can`, no parameter | each `me` list at most 100 |
| `GET /views/team-load` | `{revision (the plan's), currentWeekStart, totals{teams, overloadedTeams, wipExceededTeams}, teams[{id, name, managerName|null, milestones, unscheduledMilestones, overloadedWeeks, wipExceededWeeks, weeksWithoutCapacity, warningWeeks[]}], truncated, warningWeeksTruncated}`; the same for every caller, no `can`, no parameter | 200 rows; 2,000 listed weeks in all |
| `GET /views/dependencies` | `{revision (the plan's), totals{links, violated, unscheduled}, projects[], teams[], milestones[], dependencies[{id, predecessor{kind, id}, successor{kind, id}, type, lagDays, check, can{edit, delete}}], truncated}`; the same for every caller except each row's `can`, no document-level `can`, no parameter | 1,000 rows; each name list at most 2,000, exactly what the listed rows name |

### Batch commands

- `POST /teams/{id}/milestone-schedules` takes `{expectedRevision, items[1..1000], scopeHash?}` and answers `{revision, accepted[], skipped[{milestoneId, reason}]}`: a per-item failure is data in `200`.
- `POST /teams/{id}/schedule-proposal` and `POST /schedule-proposals` (`{asOf, teamIds[1..50]}`, `teams[]` at most 50) answer one document each; so do the Jira import's preview and apply (`items[1..2,000]`).
- `POST /schedule-proposals/accept` takes `{expectedRevision, scopeHash, teamIds, items[1..2,000]}` and answers the batch's `{revision, accepted[], skipped[]}`; `POST /schedule-proposals/check` takes `{teamIds, items}` and answers per team `{weeks, dependencies}`.

### Measured figures

One-off and NON-BINDING; this machine, in-process `testApplication` against the Postgres container, one warm-up then five timed reads, the median; statements are counted below Exposed (only `SELECT`s; the dialect probe `SELECT current_database()` of a fresh database is not counted). Re-measure rather than quote. The client-side figures are `timeline.md`'s.

**Gates.** The team view with the overlay is gated at 400,000 B and 40,000 B gzip (`TEAM_VIEW_GATE_BYTES`; the wire is gzip, and a smaller gate would mean dropping the always-present nulls the contract promises) and the project view with the overlay at 40,000 B (`JiraFlagsScaleTest`). A gate is revised only with its measurement in the same commit.

| Metric | Figure | Repeat with |
|---|---|---|
| The pool-wide statement limit (15 s shipped) | costs nothing measurable: identical statement counts (the cache sends one `SET` per physical connection) and medians within noise, with the harness limit at 0 and at 60 s | `JiraImportScaleTest`, `HomeViewSizeTest`, `TeamScheduleBatchHoldTimeTest` with `postgres.statementTimeoutSeconds` 0 and 60 |
| The longest plan-lock hold, the 2,000-item Jira import apply | 2.1 s with the limit, 2.07 s without: 15 s is about seven times the longest legitimate wait | `JiraImportScaleTest` |
| Home, worst case (one person owns 125 nodes, manages 15 teams) | 31,533 B (gzip 1,956 B) against the 40,000 B gate, median 45-54 ms; the other callers 687, 504, 386 B; stop line 250 ms, tripwire 500 ms. Each program and project row's `ownerName` and `direct` cost about 52 B | `HomeViewSizeTest` |
| Home, statements | the roadmap read (18) + 5 for any caller + 1 for a person, nothing per managed team: 23, 24, 24, 24 for a login without a person, a person with nothing, the manager of one team, the manager of 15. The roadmap's part moves with the Jira fold, so the test pins Home relative to the roadmap counted in the same test | `HomeViewSizeTest` |
| The roadmap read with an enabled Flow link | 13 statements enabled, 9 disabled, whatever the number of teams; median 12.8 ms and 6.4 ms on a small plan (stop line 10 ms) | `RoadmapFlowFlagTest`'s two-team world |
| Team load | 27,928 B for the sample's 15 teams (gate 42,000 B); a row about 196 B, a listed warning week 123 B, `currentWeekStart` 32 B; at both caps about 290 KB; median 22.8 ms | `HomeViewSizeTest` |
| Dependencies | 117,984 B for 300 sample links (gate 170,000 B); a row about 360 B with the ends named once, `can` 36 B; at the 1,000-row cap about 340 KB, the wire about a ninth of it; median 13.9 ms | `HomeViewSizeTest` |
| Bytes in the Jira blocks | a bound milestone row costs about 125 B for `jira` and about 215 B for each flag; a clean bound milestone the 125 B alone, an unbound one 24 B (`"jira":null,"flags":[]`); a filled `JiraLink.rollup` (`jira.rollup`) about 75 B against 14 B for `"rollup":null`; each `jiraSites[]` entry 33 to 41 B (`state` and `mappingOk` add 40 B to a one-site document) | `JiraFlagsScaleTest` |
| The baseline overlay | about 50 KB on the team view: a `baseline.milestones[]` entry 166 B on average, a comparison milestone row 296 B, a comparison project row 442 B, a roadmap project's `baseline` object 192 B | `JiraFlagsScaleTest` |
| Other medians | the largest sample team view 37.7 ms; a 1,000-item batch accept 74 ms; Home's four callers 38-58 ms | `HomeViewSizeTest`, `TeamScheduleBatchHoldTimeTest` |

## The roadmap view

Files: `planning/RoadmapKernels.kt`, `RoadmapViewRows.kt`, `RoadmapViewService.kt`, `RoadmapCriticalPath.kt`, `ExternalFlags.kt`, `Deviations.kt`.

`GET /views/roadmap` answers the document of "The view documents"; no migration (every figure is derived per request, nothing is stored). The service is ONE read-only REPEATABLE READ transaction (`SNAPSHOT`): the ranking revision first, then four row sets (the active projects with their program, work stream and the three owner ids of their chain; `roadmap_entries`; the active milestones with their team; the active links), then the pure `RoadmapKernels` ONCE.

- **A project row** carries `ownerPersonId`, `rankPosition` (null = unranked), `teamIds` (the distinct teams of ALL its active milestones, scheduled or not, ascending), `span` (`SpanKernels.derivedSpan` over its scheduled milestones; null when none), `drift` (`SpanKernels.drift` against the target window), `flags[]` and `can{editTargetWindow}`.
  `can` is `PlanPermissions.canEditTargetWindow` on the chain read in the same statement as the row; `RoadmapViewTest` checks it against the real `PUT /projects/{id}/target-window` for every kind of caller.
- **`teams[]`** = the active teams with a milestone in the plan, by name (the team filter's options).
- **Roll-up.** `RoadmapKernels.flagCounts` (warnings, infos over a set of flags) is the kernel half of the program/work-stream roll-up of "The programs view"; a `JIRA_DEVIATION` counts once per deviation, a `JIRA_MILESTONES` once.

### Flags

`PlanFlag{kind, severity, days?, teamId?, otherProjectId?, deviation?, count?}`: only `kind` and `severity` are always on the wire, every other member is ABSENT when it does not apply (`@EncodeDefault(NEVER)` with a null default; `DeviationDetail`'s four members the same, on the flags and on the Deviations view's lines). Flags are raised ON a project, WARNING first, then kind, team, other project.

- **Drift.** The end later than the target end is `DRIFT_END_LATE` WARNING (`days` = the delay); a start later than the target start is `DRIFT_START_LATE` INFO; an end ahead of the target is `DRIFT_END_EARLY` INFO. An early start or an on-target edge raises nothing; no window or no span, no drift flags.
- **Rank inversion** (adjacent pairs per team). Only RANKED projects carry it, and the flag lives on the LOWER-ranked project B (`otherProjectId` = the higher-ranked A). `startOn(T, p)` = the earliest STORED `start_date` over p's scheduled milestones on team T (calendar days, not working days).
- **The per-team rule.** For each team T, order the ranked projects with scheduled work on T by rank; flag B against its immediate predecessor A on T when `startOn(T, B) < startOn(T, A)`: a `RANK_INVERSION` WARNING with `teamId = T`, `days = startOn(T, A) - startOn(T, B)`. A tie is no inversion; a project without scheduled work on T is not on T's list (it neither carries a flag nor separates a pair).
  A chain A > B > C all inverted reads as two flags (B against A, C against B), so every inversion is reported once per (pair, team) without the all-pairs flood.
- **The INFO variant** is the same rule over the OVERALL rank order: each pair of adjacent ranked projects (among those that have a derived span) that shares NO team with scheduled work and whose B span starts strictly before A's is a `RANK_INVERSION` INFO (`teamId` null, `days` between the span starts). An unranked project never carries an inversion flag.

### Jira flags and links

Files: `ExternalFlags.kt`, `Deviations.kt`; the Jira side is `jira/JiraFlagSource`.

- **`PlanFlag` members.** `deviation: FlagDeviation` is `{kind, detail}`: a `Deviation` without its severity, which is the flag's own. `count: int`. `FlagKind` has `JIRA_DEVIATION` and `JIRA_MILESTONES`, declared after the calendar kind `NO_WORKING_DAY` (a milestone row's own flag), so they sort after the existing kinds within a severity; `FLAG_ORDER` breaks the remaining tie by the deviation's kind, the kernel's own order.
- **`JIRA_DEVIATION`** is raised ON the node the binding sits on, one per deviation of the kernel's list at the deviation's severity, carrying the `deviation` (a project's on its roadmap row and in `ProjectView.project.flags`, a milestone's on its row of the project and team views; `days`, `teamId` and `otherProjectId` are absent, the detail holds the days).
  `DeviationKind` has `UNLINKED_IN_JIRA` (WARNING), `UNLINKED_IN_PLAN` and `CHILDREN_DONE` (INFO), and `DeviationDetail` a `count: int|null`; they fold into `JIRA_DEVIATION` flags like every other kind (`jira-sync.md` "Deviations").
- **`JIRA_MILESTONES`** is raised ON a project: ONE roll-up over its milestones that raised at least one flag, `count` = how many such milestones, severity = the worst among them. Never one flag per milestone on the roadmap; the detail lives on the project view's rows.
- **A project row's `jira: JiraLink|null`** is `{bindingId, connectionId, issueKey, start, end, rollup}`: the observed dates, null when never observed or `gone`. The link's `start`/`end` stay explicit nulls (null means "unknown"; absent would have to mean "as the plan"). `rollup` (always present) is `JiraRollup {children, done, points|null, observedAt}`, a live milestone link's census figure from the deviations view's own loader; it is null on a project link, through a DISABLED connection, beside a `gone` issue and with no mirrored child.
- **`jiraSites[]`** (`{connectionId, siteUrl, state, mappingOk}`) is once per document; the client builds `siteUrl + "/browse/" + issueKey`. `state` is `JiraSiteState`, `planning`'s own enum with exactly `sync`'s `SyncState` names (`NEVER_SYNCED | CURRENT | STALE | FAILED | DISABLED`; `planning` may not name `sync`, so the seam mirrors it, `JiraFlagSourceTest` pins the two name lists equal and the Jira module converts by name).
  `mappingOk` is the Deviations view's member of the same name. Both members have no default, so the encoder always writes all four keys.
- **The fold rule** (`JiraFlagSource`, the Jira implementation of `planning`'s `ExternalFlagSource`, wired by `infra/db/Database.kt`; `planning` names no `jira` package): a binding raises one flag per OPEN LINE, a kernel deviation whose own acknowledgement is not CURRENT (an acknowledgement that went stale raises again; an acknowledged line of the same binding raises nothing).
  `ESTIMATE_NOT_COMPARABLE` never raises a flag. Both kinds are raised by an OPEN binding only.
- **Disabled, gone, unbound.** A binding through a DISABLED connection keeps its link and its site with null dates but raises no flag and adds nothing to a roll-up (the node still reads as linked, so it can be unlinked and never gets a second link; the Deviations page lists it too). A `gone` item raises its `GONE` WARNING alone and its dates are null.
  An unbound plan answers `jira: null`, `flags` without the Jira kinds and `jiraSites: []`. A fully acknowledged binding keeps its `jira` link (the bar); it only stops raising flags.
- **Sites.** The sites are the connections the REFERENCED rows link through, each with its derived state from one indexed `sync_runs` read per such connection (`DeviationViewService.siteStatesInTransaction`); a plan with no row reads none.
- **Where it is asked.** The source is asked INSIDE each view's `READ ONLY REPEATABLE READ` snapshot, right after the calendar (the roadmap and programs views through `loadRoadmapSnapshot`, which the baseline capture and comparison call WITHOUT a source), and runs the deviations view's own `computeInTransaction` scoped to the requested nodes, so the flags equal the Deviations page's open lines for the same state.
- **Which nodes are named** (`ExternalFlagRequest`): the project view the project and ALL its milestones; the team view no project and the team's milestones. A project's roll-up is exact only when all its milestones are named, so the team view carries none. The `?baseline=` overlay stays additive.

### The external flag seam

`ExternalFlagSource` is `planning`'s seam for flags that other packages raise. `CompositeExternalFlagSource` merges the Jira and Flow sources: per node the first link and every source's flags in `FLAG_ORDER`; per team the flags and ranges; the sites distinct.

- **The team half.** `ExternalFlagRequest.teamId`; `ExternalFlags.teams` is `TeamExternal{flags, ranges}` with `FlaggedRange{start, end, severity}`. `FlagKind.FLOW_CAPACITY` and `flow/FlowFlagSource` raise ONE roll-up flag and one day range per open capacity row of an ENABLED connection (`flow-sync.md` "Deviations"). The team view asks (`teamId`).
- **The every-team form.** `ExternalFlagRequest.everyTeam` (default false; refused together with a `teamId`) asks for the `TeamExternal` of EVERY team with something to say. `loadRoadmapSnapshot` (the roadmap, programs and home views) asks that way, in the whole-plan request, right after the calendar and in the same snapshot.
  The project view therefore carries no Flow flag, and the team view and both Deviations documents do not change by a byte. `RoadmapSnapshot.teamFlags` keeps each team's own `FLOW_CAPACITY` roll-up from the same answer, which `HomeViewService.managedTeams` reads instead of asking the seam per managed team.
- **`FlagKind.FLOW_CAPACITY_MILESTONES`** (appended last: it sorts after `FLOW_CAPACITY`, then by team) is raised ON a project, **ONE per team**, with `teamId` and `count` (`RoadmapKernels.capacityFlags`, pure, over the loader's `PlanMilestoneFact`s and the answer's `FlaggedRange`s by team id).
  A milestone MEETS a range of its own team when it is SCHEDULED and shares a calendar day with it (`!range.start.isAfter(span.end) && !range.end.isBefore(span.start)`: both ends inclusive, the weeks strip's test, stored dates, not working days).
- **Its figures.** `count` = the project's milestones on that team that meet a range; `severity` = the worst among the ranges any of them meets (a WARNING when the plan holds more capacity than Flow in such a sprint, an INFO otherwise). An unscheduled milestone, a team without an open row with days (`TEAM_GONE` holds none: it stays on the team page and the Deviations page), an acknowledged row, a stale-then-current mix (a stale acknowledgement flags again) and a DISABLED connection raise nothing.
- **Where the flags count.** They join the row's own drift and inversion flags BEFORE the Jira fold and count in every roll-up that counts a row's flags (a program's and a work stream's `flags`, Home's plan block and "Yours"); the same document for every caller.
- **Statements.** The roadmap, programs and home reads gain ONE (the Flow connections select) while no Flow connection is enabled and at most FIVE with one (connections, bindings of active teams, those teams' capacity periods, the bound Flow teams with their sprints in one statement, the stored acknowledgements), whatever the number of teams.

### Links and the chain toward a picked project

- **Links.** `links[]` rolls the ACTIVE dependencies up per ORDERED pair (predecessor project, successor project), ordered by that pair; both directions between two projects are two entries. Each end resolves to its project (a milestone's own, a project itself) and span (the milestone's dates, the project's derived span); a link inside one project is skipped from the pairs.
- **The pair.** Its `direct` is its PROJECT-to-PROJECT link (`{id, type, lagDays, check}`, at most one per ordered pair by the partial unique index); every other link (a milestone on either end) counts in `milestoneLinks{count, violated, unscheduled}`. Each is checked like the project view's (`DependencyKernels.check`, working days).
- **Checks are kept per link.** `RoadmapKernels.checkedLinks` answers one `CheckedLink{link, predecessorProjectId, successorProjectId, check}` per link whose two ends resolve (a link inside one project INCLUDED); `aggregate` folds them into the pairs and `linkAggregates` is `aggregate(checkedLinks(…))`.
  `RoadmapSnapshot.checkedLinks` and `milestoneFlags` (the source's milestone flags by id) keep what the loader computes or receives.
- **The chain toward a picked project** (`GET /views/roadmap?criticalPath=N` and `GET /views/programs?criticalPath=N`: the SAME block from ONE shared step, `RoadmapSnapshot.criticalPathTo`, which both view services call; `criticalPathParam()` is `internal` beside `baselineParam()`) adds `criticalPath{projectId, projects[], pairs[]}`.
  It is `@EncodeDefault(NEVER)`: the document is byte-identical without the parameter (`RoadmapViewTest` compares it with the parameter's document minus the key).
- **The parameter.** N names an ACTIVE project of the snapshot, else a plain `400` "Unknown or deleted project id: N" (a repeated or malformed value is a plain `400` too, a blank one means absent). With `?baseline=` the baseline's own errors, the typed `unknown-baseline` included, are answered first. The parameter combines with `?baseline=` (independent blocks).
- **No second read.** `loadRoadmapSnapshot` keeps the milestone and link rows it read (`RoadmapSnapshot.facts`/`linkFacts`) and `CriticalPathKernels.analyse(N, …)` runs on those very rows: no new statement, the project page's rule over the whole graph on the planned dates ("The critical path").
  The roadmap's root and rows also require the program and the work stream active, which cannot differ from the project page's on a live database: a program delete is refused with 409 while it has active projects and a work stream delete while it has active programs.
- **The roll-up.** The pure `RoadmapCriticalPathKernels.rollUp` folds the result to the roadmap's grain. `projects[]` = the OTHER projects with an upstream milestone or a linked project entity (N is implied: critical, slack 0), each with the least `slackDays`, `critical` when any entity is, the fewest `hops`, ordered by hops, slack, id.
  `pairs[]` = the ordered (predecessor, successor) project pairs holding at least one link of `criticalDependencies` (a link inside one project yields none; a pair with a direct link and several milestone links is critical when ANY is; the per-link truth stays on the project page). A target with nothing scheduled answers both lists empty.
- **The programs view takes the same parameter** and the same block ("The programs view").

Pinned by: `RoadmapKernelsTest`, `RoadmapViewTest`, `RoadmapCriticalPathTest`, `ProgramsViewCriticalPathTest`, `JiraFlagSourceTest`, `FlowFlagSourceTest`, `RoadmapFlowFlagTest`.

## The programs view

Files: `planning/ProgramsView.kt`, `ProgramsTree.kt`, `ProgramsViewService.kt`.

`GET /views/programs` (any authenticated user; no audit, a read; no migration) answers the document of "The view documents". The service is the roadmap view's protocol (ONE read-only REPEATABLE READ transaction, `SNAPSHOT`) with one difference: `revision` is the PLAN revision, read first and informational (no flow on the programs page sends it back; the ranking's revision stays on `GET /views/roadmap`).

- **The same loader.** It calls the SAME `loadRoadmapSnapshot` (one set of loaders, one kernel run) plus the active work streams and programs, so `projects[]` are the roadmap's `RoadmapProject` rows exactly (same spans, drift, flags, `can.editTargetWindow`), `teams` and `links` are the roadmap's, and an EMPTY program or work stream is present (with a null `span` and zero `flags`).
- **The tree** (`ProgramsTree.assemble`, pure) orders and rolls up: open work streams before closed ones (an `endDate`), streams and programs by lowercase name then id, a program's projects ranked first in rank order, then by name and id.
- **Roll-ups.** A program's `span` = `SpanKernels.derivedSpan` over its projects' spans, a work stream's over its programs' spans (nothing stored). A program's or stream's `flags` = the WARNING and INFO flags over its projects (`RoadmapKernels.flagCounts`; the project rows' Flow capacity flags count too, "The roadmap view" › "The external flag seam"). Programs have no target window and no `can`.
- **`?criticalPath=N`.** The view takes the roadmap's parameter and adds `criticalPath` (`@EncodeDefault(NEVER)`, last: byte-identical without it): the roadmap's `RoadmapCriticalPath` for the same target, from the same snapshot's rows (`RoadmapSnapshot.criticalPathTo`, the 400 for an unknown or deleted id included; answered after the baseline's own errors, no further statement).
  A project the page hides (a fold, the program pick) stays in the block: the page decides what it shows. The picker, the emphasis and the panel are the web's (`web-internals.md`).

Pinned by: `ProgramsTreeTest`, `ProgramsViewTest`, `ProgramsViewCriticalPathTest`.

## The home view

Files: `planning/HomeKernels.kt`, `HomeView.kt`, `HomeViewService.kt`.

`GET /views/home` (any authenticated user, no parameter: an unknown query name is ignored; `200`/`401`/`500`; no audit, a read) answers `{revision, plan, me|null, jiraSites[]}` ("The view documents"): the plan's figures and the caller's own items in ONE document. Nothing is stored; every figure is an existing page's own function applied to a subset, so Home cannot disagree with the page it links to.

### Kernel

`HomeKernels.plan(streams, programs, facts)` and `HomeKernels.mine(personId, name, streams, programs, facts, teams, maxRows)` are pure (no I/O, no clock) over plain facts: `HomeFacts(projects, milestones, checkedLinks, milestoneFlags, teamWeeks)` (the roadmap snapshot's project rows with flags folded in, `facts`, `checkedLinks`, `milestoneFlags` where an entry may hold an empty list, and every team's `weeklyLoad` weeks), `HomeStreamFact`, `HomeProgramFact` and `HomeTeamFact(id, name, flags)`.

| Figure | Derived by | The page that says the same |
|---|---|---|
| work streams, programs, projects | counts of the facts (a program whose stream is not listed is not counted, as the Programs tree drops it) | Programs facts line, nothing picked |
| milestones, not scheduled | the snapshot's `facts`; `span == null` | each project's and team's Unscheduled tray, summed |
| ranked, unranked | `rankPosition` of the project rows | Roadmap facts line, nothing filtered |
| warnings, infos | `RoadmapKernels.flagCounts` over every project row's `flags` | Roadmap and Programs facts lines |
| conflicts | the `VIOLATED` checked links, each once, a link inside one project included: `DependencyListKernels.totals(checkedLinks).violated`, the ONE function `HomeKernels.plan` and the dependency list's `totals` share | the red badge of the project and team pages, and the dependency list's `totals.violated`; NOT the Roadmap's arrows (`RoadmapKernels.aggregate` skips a link inside one project) |
| teams overloaded, teams over the WIP limit | `TeamLoadKernels.totals(teamWeeks)`: teams with at least one `WeekLoad.overloaded` / `wipExceeded` week, where `teamWeeks` must hold EVERY active team with scheduled work for every caller (never only the managed teams) | the team page's two orange badges; the team-load view's `totals` |
| a work stream's / program's projects and flags | `flagCounts` over the projects below it | its row on the Programs page |
| a project's flags, milestones, not scheduled, conflicts | `flagCounts(row.flags)`; `facts` of the project; violated checked links with an end in the project | its Roadmap row, the project page |
| a team's milestones, not scheduled, conflicts | `facts` of the team; violated checked links with a MILESTONE end in the team (a link with both ends in the team counts once) | the team page's facts line |
| a team's weeks overloaded / over the WIP limit | `teamWeeks[team]` | the team page's two orange badges |
| a team's Jira | `JIRA_DEVIATION` flags of the team's milestones in `milestoneFlags`, by severity, nothing else | the team page's Jira chip |
| a team's flags | passed through (the team view's `team.flags`) | the team header's Flow badge |

### "Yours" is the owner chain

- **The rule.** With P the caller's person, a row is P's when P is on its owner chain `[work stream owner, program owner, project owner]`, exactly what `PlanPermissions.canManage` answers for a non-administrator. Work streams: those P owns. Programs: in a LISTED work stream that P owns, or whose work stream P owns. Projects: those P owns or that sit in one of those programs.
  Teams: the ones the person manages (the caller passes exactly those).
- **No role branch.** An administrator's own "Yours" is still the person's, never everything. A program whose work stream is not listed is dropped with the projects it would pass down. A person on two levels of one chain gets each row once, `direct` where it is theirs.
- **Row members.** Each program and project row carries `ownerName` and `direct` (its `ownerPersonId` is P: false means it is listed through the work stream or program above); a work stream row gains nothing. `HomeProgramFact.ownerName` rides the SAME programs select (a join to `people` with no `active()` filter: an owner of an active program cannot be deleted);
  a project's name is the roadmap row's `ownerName`. **No statement is added** (`HOME_ONLY_STATEMENTS` stays 5).
- **Orders.** Open work streams before closed, then lowercase name then id; programs and teams by lowercase name then id; projects ranked first in rank order, then lowercase name then id; all over the longer lists. Each of the four lists is cut at `MAX_HOME_ROWS` (100) and `truncated` says one was.
- **Row vocabulary.** A project's row carries the Roadmap vocabulary (warnings and infos, Jira's included), a team's row the team page's two integration figures (`jira`, `flags`), never both on one row.

### Service

`HomeViewService(database, external, maxRows)`, `HomeCaller(userId)`. ONE read-only REPEATABLE READ transaction (`SNAPSHOT`, the views' protocol); reads only, no lock, no revision moves.

- **Reads, in order.** `readPlanRevision()` FIRST (informational: Home offers no write, so no `can`); `loadRoadmapSnapshot` with the actor that may do nothing (the `can` flags are not read; the snapshot already keeps `checkedLinks`, `milestoneFlags` and `teamFlags`); the active work streams and programs (two selects); the capacity load.
- **The capacity load** is `teamWeeks(calendar)` in `TeamLoadRows.kt` (the loader the team-load view runs too): ONE select of every active scheduled milestone's team, span and estimate (all teams, every caller), then ONE select of those teams' ACTIVE capacity periods (`team_id IN …`, through `activeCapacityPeriods`) and one `weeklyLoad` run per team with scheduled work.
  These are the team view's exact inputs (`LoadItem(span, estimate)`, the same periods, `loadWindow`, the snapshot's calendar), so the plan block's `overloadedTeams`/`wipExceededTeams` never depend on who asks.
- **The caller's person** is resolved INSIDE the snapshot from the token's user id (`HomeCaller(userId)`: the ACTIVE `people` row with that `user_id`, one select; the login's own liveness is the per-request access check, as in `activePersonIdOf`). Only a caller with a person adds the ACTIVE teams whose manager that person is (one select, id and name).
- **Managed teams' flags** are the loader's `RoadmapSnapshot.teamFlags` entry (the seam's team half for EVERY team, asked once by `loadRoadmapSnapshot`): **no seam statement per managed team**. They equal the team view's `team.flags` (`FlowFlagSourceTest`).
- **Statements.** The roadmap's own, plus 5 for every caller (the work streams, the programs, the scheduled milestones, ALL the capacity periods, the caller's person lookup), plus 1 for a caller with a person (the managed teams' select), and NOTHING per managed team. `HomeViewSizeTest` pins it relative to the roadmap read (the Jira fold adds statements per live connection and binding).
- **"Me" has no role branch.** The route passes `HomeCaller(caller.userId)` and the service resolves the person and the managed teams in its own snapshot (the guards' semantics, `activePersonIdOf` and `activeManagedTeamIds`, without their two extra pool checkouts). Unlike `callerPersonId`/`actor` (whose `can` flags short-circuit an ADMIN), an administrator's person is looked up too, and an administrator without a person gets `me: null`.
- **A person deleted or unlinked before the snapshot began** reads `me: null`, one consistent view. The view has no parameter, so no query or path value reaches the lookup. A team is "yours" exactly when `requireTeamManagerOrAdmin` would let a non-administrator schedule it. A soft-deleted team, project, program or work stream is in no list and no count.

Pinned by: `HomeKernelsTest`, `HomeViewTest`, `HomeViewSizeTest`.

## The team-load view

Files: `planning/TeamLoadKernels.kt`, `TeamLoadView.kt`, `TeamLoadViewService.kt`, `TeamLoadRows.kt`.

`GET /views/team-load` (any authenticated user, no parameter: an unknown query name is ignored; `200`/`401`/`500`; no audit, no lock, no bucket, a read) answers the document of "The view documents", behind the Team load page and Home's two capacity badges. It is the SAME for every caller: no `can`, no person id, no email.
Nothing is stored; every figure is the team page's own, so the list cannot disagree with the page it links to or with Home.

- **Capacity figures the caller already sees.** The weeks behind the two warning counts are listed in `warningWeeks` (the team page's own `weeks[]` items), which that page already shows every login. `currentWeekStart` is the Monday of the SERVER's current week in UTC, the same for every caller.

| Figure | Derived by | The page that says the same |
|---|---|---|
| `milestones`, `unscheduledMilestones` | the team's ACTIVE milestones (`teamMilestoneCounts()`: ONE select of `team_id` and `start_date`, grouped in Kotlin; the pair of dates is both-or-neither) and those without dates | the team page's two trays summed, and its Unscheduled tray |
| `overloadedWeeks`, `wipExceededWeeks` | `WeekLoad.overloaded` / `.wipExceeded` counted over the team's `teamWeeks` entry | the team page's two orange badges |
| `warningWeeks` | the team's weeks with `overloaded` or `wipExceeded`, oldest first, each `WeekLoad.toView()` (the team view's own `WeekLoadView`, never with `flowCapacity`: this view reads no external source); at most 520 a team, 2,000 across the document ("The weeks' budget") | the team page's weekly load table, filtered to its two orange badges |
| `weeksWithoutCapacity` | the weeks of the team's load whose `capacity` is null (no period in force on any working day of the week) | the team page's weeks with no capacity figure; such a week is never flagged, so without this figure a team with work and no capacity period would look fine |
| `managerName` | the team's manager when that person is ACTIVE, else null | the team page's header (a deleted manager's team answers no manager) |
| `totals.overloadedTeams`, `.wipExceededTeams` | `TeamLoadKernels.totals(teamWeeks)`, the ONE expression `HomeKernels.plan` calls for its two members | Home's `plan.overloadedTeams` and `.wipExceededTeams` (a test pins the equality on the same snapshot) |
| `totals.teams` | every ACTIVE team, whatever the rows cut | `GET /teams`, active rows |

While nothing is cut, `overloadedWeeks` / `wipExceededWeeks` equal the listed weeks that carry each flag.

### One rule in one place

- **The loader.** `teamWeeks(calendar)` (`internal` in `TeamLoadRows.kt`) is the loader both this service and Home call: ONE select of every active scheduled milestone's team, span and estimate, ONE select of those teams' ACTIVE capacity periods, one `weeklyLoad` run per team with work. A team with no scheduled work has no entry and reads zeros.
  **The map must hold EVERY active team with scheduled work, for every caller.** The two team counts are `TeamLoadKernels.totals`, called by `HomeKernels.plan` and by `TeamLoadKernels.view`.
- **Rows.** Every ACTIVE team, by lowercase name then id, at most `MAX_TEAM_LOAD_ROWS` = 200 (`truncated` says the list was cut; `totals` always count every team). A team with nothing scheduled has zeros. A soft-deleted team is in no row and no total; a deleted manager reads `managerName: null` (the team is still listed).
- **The weeks' budget.** `TeamLoadKernels.view(…, maxRows, maxWarningWeeks, currentWeek)` keeps at most `MAX_TEAM_LOAD_WARNING_WEEKS` = 2,000 weeks across the whole document. `handOutWarningWeeks` (pure) ranks every warning week of every listed row: first the weeks on or after `currentWeek` (a week ON it counts), the nearest first, then the earlier ones, the latest first;
  a tie on the date goes to the earlier row, whatever the team's place in the name order.
- **What the cut touches.** Each row lists the weeks it kept oldest first; `warningWeeksTruncated` is true when any listed row left a week out. The three counts and `totals` are never touched by the cut; a team past the 200-row cut is not a row and uses no budget. A week without capacity is not listed (a fact, not a warning; it stays a count).
- **The clock only decides what a FULL budget keeps.** While nothing is cut the lists are the oldest-first lists whatever `currentWeek` is. A page that hides the earlier weeks cuts at `currentWeekStart`, never at the browser's clock; no count moves with the date.

### Service

`TeamLoadViewService(database, maxRows, maxWarningWeeks, clock)`. ONE read-only REPEATABLE READ transaction (`SNAPSHOT`): `readPlanRevision()` FIRST, `loadWorkingCalendar()`, `activeTeamsWithManagers()` (ONE select: the ACTIVE teams LEFT-joined to `people`; the person's deleted flag is read with the name and turned into a null name in Kotlin, because a `WHERE` on the person would drop the team itself),
`teamMilestoneCounts()`, then `teamWeeks(calendar)` (two selects).

- **The clock** (`() -> Long`, default `nowMillis`: the deviation services' idiom) is read once, before the revision; its UTC date's Monday (`mondayOf`) is `currentWeekStart` and the kernel's `currentWeek`. There is no plan time zone: the week changes over at 00:00 UTC.
- **Six statements** (five when no milestone is scheduled anywhere: the capacity select is skipped). No external source (no Jira or Flow read), no caller, no lock, nothing written. It reads `Teams`, `People`, `Milestones`, `CapacityPeriods`, `PublicHolidays` and `PlanState` (`persistence.md` matrix). `PackageBoundaryTest` is unchanged: `planning/` names no `jira` or `flow` package.
- **Tests look rows up on an uncapped service** (`TeamLoadViewService(database, maxRows = Int.MAX_VALUE, maxWarningWeeks = Int.MAX_VALUE)`, BOTH caps: on a shared database earlier rows can spend the week budget); the cut itself is pinned by a test that seeds 201 throwaway teams, and the 2,000-week budget by four throwaway teams of 520 overloaded weeks, hard-deleted in a `finally`, asserted as properties.

Pinned by: `TeamLoadKernelsTest`, `TeamLoadViewTest`, `HomeViewSizeTest`.

## The dependencies view

Files: `planning/DependencyListKernels.kt`, `DependencyListView.kt`, `DependencyListViewService.kt`.

`GET /views/dependencies` (any authenticated user, no parameter: an unknown query name is ignored; `200`/`401`/`500`; no audit, no lock, no bucket, a read) answers the document of "The view documents", behind the Dependencies page and Home's last attention figure. The SAME for every caller except each row's `can` (what THIS caller may do with the link); the page offers no write of its own, so there is no document-level `can`.
Nothing is stored; the checks are derived per request.

### The row, its ends named once

`DependencyListRow` is `ProjectDependency` (`planning/ProjectView.kt`) minus `critical`, with each end an `EndpointRef{kind, id}` and the check the existing `DependencyCheck` (`DependencyKernels.check` on the working calendar). An end carries no dates (`startDate`/`endDate`); the check keeps its two.

- **Three name lists** hold exactly what the LISTED rows name, each entry once, by ascending id: `milestones` (`DependencyListMilestone{id, name, projectId, teamId}`: every milestone end), `projects` (`DependencyListProject{id, name}`: every project end and the project of every listed milestone) and `teams` (the existing `RoadmapTeam{id, name}`: the team of every listed milestone).
- **Every reference resolves,** no entry is unnamed by a row, and a row the cap cut contributes nothing (the names of cut links never leak back into the size). The SPA joins the names back once (`utils/dependencyListRows.ts` `resolveDependencyList`, in the page's query function; an unresolvable reference is a failed read).
- **Two code paths compute a check:** the project view from resolved ends, the list from the roadmap's `RoadmapKernels.checkedLinks`. They agree, and `DependencyListViewTest` is what keeps them so: every seeded row, with its ends RESOLVED through the lists, equals the item `GET /views/project/{id}` answers for the same link (on BOTH projects' views for a cross-project link) and `GET /views/team/{id}`; the shared test join is `DependencyListResolve.kt`.

| Figure | Derived by | The page that says the same |
|---|---|---|
| a row's `check` | `RoadmapKernels.checkedLinks` over the roadmap's loaders (`milestoneFacts()`, `linkFacts()`, and the projects' ids from `activeProjectNamesAndChains()`) | the project page's Dependencies table; the team page's `dependencies[]` |
| `totals.violated` | `DependencyListKernels.totals(checked).violated`, the ONE function `HomeKernels.plan` calls for `conflicts` | Home's `plan.conflicts` (a link inside one project counts once; a test pins the equality on the same snapshot) |
| `totals.links`, `.unscheduled` | every checked link; those whose status is `UNSCHEDULED` | the list's facts line |

### Order, cap and which links

- **Order.** `dependencyOrder(check, successorName, predecessorName, id)` (`ProjectViewDependencies.kt`; `DEPENDENCY_ORDER` is its `ProjectDependency` instance, so ONE rule): VIOLATED first (the largest shortfall first), then OK, then UNSCHEDULED, within a group by the successor's name, the predecessor's name (case-insensitive) and the id.
- **Cap.** At most `MAX_DEPENDENCY_ROWS` = 1,000 rows. `truncated` says the list was cut, which drops the kept and unscheduled links first; `totals` always count every link. The filters (status, team, project) are the browser's, over the rows that arrived.
- **Which links.** Every ACTIVE link whose two ends resolve to a project of the set "every active project" (`activeProjectNamesAndChains()`, whose row set is `activeProjectNames()`'s), a link inside one project included. That set equals the roadmap's ("an active project under an active program and work stream") because a program with active projects, and a work stream with active programs, cannot be deleted (`ProgramService.delete`, `WorkStreamService.delete`).
  A deleted link, and a link of a deleted milestone or project (the cascades), is in no row and no total.

### The caller's `can`

- **Rule.** `edit` and `delete` are `ProjectDependencyCan`, the project view's own member (one spec schema, `DependencyCan`, for both): `PlanPermissions.canEditDependency` / `canDeleteDependency` over the owner chain of the SUCCESSOR's project (`CheckedLink.successorProjectId`): an owner of that project, its program or its work stream, or an administrator.
  The predecessor's owner alone, a team manager, a stranger and a login without a person get `false`, and so does any link whose successor project has no chain (its program or work stream is gone: the write answers `404`).
- **Where it is computed.** The route resolves the caller once as the plan view's does (`d.actor(caller)`: the administrator flag and the login's person, outside the snapshot) and hands the actor to the service. The owner chain (person ids) stays inside the kernel; only the two booleans reach the wire, and nothing else of the document differs between two callers.
- **Service** (`DependencyListViewService(database, maxRows)`): ONE read-only REPEATABLE READ transaction (`SNAPSHOT`): `readPlanRevision()` FIRST, `loadWorkingCalendar()`, `milestoneFacts()` (every active milestone with its name and its team's name), `linkFacts()`, `activeProjectNamesAndChains()`;
  then `RoadmapKernels.projectSpans` and `checkedLinks` (the projects handed over as `PlanProjectFact(id, null, null)`: the kernel reads their ids only) and `DependencyListKernels.view(revision, checked, milestones, projects, actor, maxRows)`. The rows are cut, the lists are built from the cut rows, and each KEPT row's `can` is computed last.
- **Five statements.** The fifth is `projects ⟕ programs ⟕ work_streams` in ONE select: every active project's name plus, when its program and work stream are active, its owner chain; an active project under a deleted program stays in the set with a null chain. No external source, no lock, nothing written. It reads `Milestones`, `Teams`, `Dependencies`, `Projects`, `Programs`, `WorkStreams` (their owner ids), `PublicHolidays` and `PlanState`.
- **Tests look rows up on an uncapped service** (`DependencyListViewService(database, maxRows = Int.MAX_VALUE)`), because the endpoint cuts at 1,000 rows and a CI fork's shared database holds the links of hundreds of other classes; plan-wide figures are deltas.

Pinned by: `DependencyListKernelsTest`, `DependencyListViewTest`, `PlanPermissionsTest`, `HomeViewSizeTest`.

## The team view

Files: `planning/LoadKernels.kt`, `TeamView*.kt` (`TeamViewService.kt`, `TeamViewRows.kt`).

`GET /api/v1/views/team/{id}` (tag `plan`; any authenticated user; 404 when the team is deleted, for every caller; **no audit**, a read) answers ONE document: `{revision, team{…TeamResponse fields, can{schedule, editCapacity, editOrder}, flags[]}, order{custom, revision, milestoneIds[]}, capacity{periods[]}, weeks[], weeksTruncated, scheduled[], unscheduled[], dependencies[], idleGaps[]}`.
Bound: one team's milestones (about 100), their links and at most 520 weeks.

- **Snapshot.** `TeamViewService` runs ONE READ ONLY REPEATABLE READ transaction (`ProjectViewService`'s snapshot): the plan revision FIRST, then the team ⋈ its manager's name; the team's ACTIVE milestones ⋈ project ⋈ program ⋈ work stream ⋈ `roadmap_entries` (left: `rankPosition`; `TeamViewRows.kt`); the order positions (`positionsOf`, looked up FROM the active milestones, never by iterating the order table) and the order revision;
  the capacity periods and the links; then the pure kernels.
- **Capacity periods** are read through `teams/TeamCapacityRows.kt` (`teamCapacityRows(teamId)` in `TeamViewRows.kt` calls `activeCapacityPeriods`, ordered by `effectiveFrom` then id, and maps rows with `toCapacityPeriodResponse`, the ONE row-to-wire mapping `TeamCapacityService` shares).
- **Two revisions.** `revision` is the PLAN revision (the schedule PUT's); `order.revision` is the TEAM's order revision (0 when never written; the `expectedRevision` of `PUT /teams/{id}/milestone-order`).
- **A `TeamMilestone`** is `MilestoneResponse` + `projectName`, `programName`, `workStreamName`, `rankPosition` (null = unranked), `slackDays` (null while unscheduled) and `critical` ("The critical path"). There is no per-milestone `can`: the three team-level flags apply to every bar.
- **The `can` flags: three names, one arithmetic.** `canSchedule`, `canEditCapacity` and `canEditTeamOrder` (`PlanPermissions`) are all "ADMIN, or the caller is the ACTIVE manager of THIS team" (`requireTeamManagerOrAdmin`; the actor's managed teams resolved once, `withManagedTeams = true`). Three flags so a later version may split the rights without a wire change.
- **Order** (`effectiveOrder`, "The team milestone order"): `scheduled[]` and `unscheduled[]` are the team's milestones in the effective order: the team's own override first, the global project rank as the default of the unlisted tail.
- **`dependencies[]`** takes the project view's `ProjectDependency` shape for every ACTIVE link with a MILESTONE end among the team's milestones (`viewDependencies`, generalised from the project view's `projectDependencies`): both ends resolved, `DependencyKernels.check`, violated first, `can.edit` and `can.delete` on the SUCCESSOR's project chain, and `critical` per "The critical path".
  The far end of a link may lie in another team or project; it is resolved (name, project, team, dates), not listed as a row: **no ghost rows**.
- **The Flow capacity flag.** `team.flags[]` carries at most ONE flag, `FLOW_CAPACITY` (`count` = the team's OPEN Flow capacity deviation rows, the worst severity among them; empty without a Flow link, with a disabled connection or when every row is acknowledged). A `weeks[]` row gains `flowCapacity: WARNING|INFO` when the held days `[effectiveFrom, end]` of an open row meet the week `weekStart..weekStart+6` (the worst severity among the rows that meet it).
  The member is absent otherwise, and always absent on the proposal's and the check's weeks (`@EncodeDefault(NEVER)`).
- **Where it comes from.** Both come from the `ExternalFlagSource` seam (`FlowFlagSource`; "The roadmap view" › "The external flag seam"; `flow-sync.md` "Deviations"), read in the view's own snapshot after the calendar. A team with nothing scheduled has no weeks to mark; the header still counts.

### Weeks and load

- **Weeks and working days.** A week is an ISO week keyed by its Monday (`weekStart`); its working days are the calendar's (Monday-Friday minus the holidays). The capacity divisor stays **5** in a holiday week: the holiday is an uncovered day, so a 10 MD/week team has 8.00 in the week of 2027-01-04 (Epiphany, Wednesday 01-06) and a 10 MD milestone dated 01-04..01-08, spread over the four remaining days, loads 10.00: overloaded by +2.00.
- **The window.** `weeks[]` runs from the Monday of the earliest scheduled start to the Sunday of the latest scheduled end (`loadWindow`; empty while nothing is scheduled), capped at **520 weeks** counted from the start (`MAX_LOAD_WEEKS`; `weeksTruncated` then true).
  A week row is `{weekStart, load, capacity|null, overloaded, overloadMd|null, maxWip, wipExceeded}` (+ `flowCapacity`).
- **The spread (load).** A scheduled milestone's estimate `E` is spread evenly over its `n = calendar.workingDaysBetween(start, end)` working days (`W(prevWorkingDayOnOrBefore(end)) - W(nextWorkingDayOnOrAfter(start)) + 1`): a milestone's share of a week is the EXACT fraction `E x (its working days inside the week) / n` (never divided first, so no digit is lost).
  A week's `load` = the shares of every milestone summed exactly (as a fraction over a common denominator) and rounded ONCE to two decimals `HALF_UP`.
- **Examples.** 7.25 MD over six working days loads 3.63 into each of two weeks, 3 days apiece; two 0.01 MD milestones Friday → Monday load 0.01 into the first week, not 0.02. A weekend inside a span costs nothing. 10 MD Wednesday → next Tuesday (5 working days) loads 6.00 and 4.00; 10 MD over Friday + Monday + Tuesday loads 3.33 and 6.67.
- **Prorated capacity.** `capacityOn(day)` = the `mdPerWeek` of the ACTIVE period with the greatest `effectiveFrom <= day` (null before the first). `weekCapacity(monday)` = null when no period is in force on ANY working day of the week ("no capacity", never zero, never flagged); otherwise the sum over Monday-Friday of `(capacityOn(day) ?: 0) / 5` (each share at scale 6, exact for a two-decimal figure), rounded to two decimals `HALF_UP`.
  A weekend `effectiveFrom` needs no special case (only the calendar's working days are summed).
- **Overload.** `overloaded = capacity != null && load > capacity` on the ROUNDED figures (what is shown is what is flagged); `overloadMd = load - capacity`, only when overloaded. 0.80 against 0.80 is not overloaded, 0.81 is, by 0.01; a capacity of 0.00 (on hold) flags every loaded week; a null capacity never flags.
- **WIP.** A scheduled milestone is IN PROGRESS on the working days of its EFFECTIVE span `[nextWorkingDayOnOrAfter(start), previousWorkingDayOnOrBefore(end)]` (a weekend-only edge counts nothing). `wipLimitOn(day)` = the WIP limit of the period in force THAT day (null = no limit: before the first period, or a period without one).
- **Per week.** `maxWip` = the peak over the week's working days (0 when nothing runs); `wipExceeded` = some working day has a limit and exceeds it, **evaluated per day**, so a limit that changes mid-week judges each day by its own limit. There is no per-week limit on the wire; the periods table is where limits are read.
- **Kernels** (`LoadKernels.kt`, pure; Flow's `CapacityKernels.kt` idiom, ported; the file itself is not in this repo): `LoadItem`, `CapacityPeriod`, `WeekLoad`, `periodOn`/`capacityOn`/`weekCapacity`/`wipLimitOn`, `loadWindow`, `weeklyLoad` (working days counted by `WorkingCalendar.workingDaysBetween`); the wire form is `WeekLoadView`. Cost: at most 520 weeks x 5 days x (100 milestones + a handful of periods), milliseconds.

### Hand-counted vectors

`LoadKernelsTest` has all of them; 2027-02-01 is a Monday.

| Periods (`effectiveFrom` → `mdPerWeek`) | Week of 2027-02-01 | Week of 2027-02-08 |
|---|---|---|
| 02-01 → 10, Thu 02-04 → 20 (mid-week boundary) | 3x2 + 2x4 = **14.00** | 20.00 |
| 02-01 → 10, Tue 02-02 → 20, Thu 02-04 → 5 | 2 + 4 + 4 + 1 + 1 = **12.00** | 5.00 |
| Wed 02-03 → 10 (the first period mid-week) | 0 + 0 + 2 + 2 + 2 = **6.00** (the week of 01-25: null) | 10.00 |
| Sat 02-06 → 20 (the first period on a weekend) | **null** | 20.00 |
| 02-01 → 1.33, Thu 02-04 → 0 (rounding) | 3 x 0.266 = 0.798, so **0.80** | 0.00 |

WIP, with milestones A 02-01..02-05, B 02-03..02-10, C 02-04..02-04 (daily WIP, week of 02-01: 1 1 2 3 2; week of 02-08: 1 1 1 0 0):

| Limits | Week of 02-01 | Week of 02-08 |
|---|---|---|
| limit 2 from 02-01 | maxWip 3, **exceeded** (Thu 3 > 2) | 1, not |
| limit 2 from 02-01, limit 3 from Thu 02-04 | maxWip 3, **not exceeded** (Wed 2 <= 2, Thu 3 <= 3) | 1, not |
| limit 3 from 02-01, limit 2 from Thu 02-04 | **exceeded** (Thu 3 > 2) | not |
| limit 1 from Sat 02-06 as the FIRST period | no limit on any day: not exceeded, maxWip 3 | Mon 1 <= 1: not |
| + E dated Sat 02-06 → Sun 02-14 (effective Mon 02-08 → Fri 02-12), limit 1 | unchanged: E counts on no day of this week | Mon 2 (B, E) > 1: **exceeded** |

Pinned by: `LoadKernelsTest`, `TeamViewTest`, `TeamViewFlowFlagTest`, `PlanPermissionsTest`.

## View validators

Files: `plugins/ResponseValidators.kt`.

Ten view reads answer `ETag` and `304` (`security.md` "Caching" owns the mechanism: a weak hash of the caller's user id and the rendered document; it saves the transfer, not the view's work: the statements and kernels run before the tag can be known, so a `304` is only milliseconds under a `200`).
`respondRevalidated` writes the same bytes as `call.respond`, always as UTF-8 `application/json` whatever `Accept-Charset` asks (`ViewValidatorsTest` pins it).

- **Order of evaluation.** `call.caller()` (`401`), the parameters (`400`), the view (its own `404`/`400`), the tag, `If-None-Match`, then `304` or `200`. A malformed or unauthorised request is never a `304`, a `404`/`400`/`401` never carries a tag, and `If-None-Match: *` answers `304` once the view has succeeded.
- **The hash is of the ANSWER.** The ledger below lists what each view reads beyond plan state (the tables whose every write runs in `withPlanWrite`); hashing the answer covers every cell without naming it.

| Read | Beyond plan state | The caller's own | A clock |
|---|---|---|---|
| plan | `people` (owner names) | every node's `can` | none |
| home | `teams`, `people`, `team_capacity_periods`; the Jira side for the plan; the Flow side of EVERY bound team (the project rows' flag and the managed teams' flags, one batched read) | all of `me` | the Jira sites' states, the deviations' "today" |
| team-load | `teams` with managers, `team_capacity_periods` | none | the current week (UTC; midnight Monday changes the tag) |
| dependencies | `teams` (a milestone's team name) | each row's `can{edit, delete}` (the successor project's owner chain, `PlanPermissions`) | none |
| roadmap (`?baseline`, `?criticalPath`) | `people`, `teams`, the Jira side, the Flow side of every bound team (the project rows' capacity flag); its `revision` is the RANKING's | `can.editRank`, each project's `can.editTargetWindow` | as home |
| programs | the roadmap's (the Flow side included) plus the owners of streams and programs | each project's `can.editTargetWindow` | as home |
| project (`?baseline`) | `people`, `teams` (names, the managers behind `can.schedule`), the Jira side | `can` on the project, each milestone and dependency | as home |
| team (`?baseline`) | the team row, its manager, `team_capacity_periods`, the Jira side, the Flow side | `team.can`, each milestone's and dependency's `can` | as home, Flow's "today" |
| baseline (`?against`) | `teams` (deleted too), `users`/`people` (who took it) | none | none |
| jira-links | `jira_connections`, `jira_bindings` with `jira_observations.gone`; no plan revision | none | none |

- **Left out, each with its reason** (`ViewValidatorsTest.LEFT_OUT`): `GET /views/deviations` and `GET /views/capacity-deviations` list their connections with `status.nextPollAt`, which is the read's own instant while a poll is due, so two reads are never equal and the test database always holds such connections; they stay full answers until that member is stable. `GET /integrations/flow/teams` is not a view document.
- **The rule for a new view:** answer through `respondRevalidated` and declare the `IfNoneMatch` parameter, the `ETag`/`Cache-Control` headers and `'304'` in the spec, or join `LEFT_OUT` with its reason; the sweep over every `/api/v1/views/` GET of the spec fails otherwise.
- **A pre-check** ("nothing this view reads has changed, skip it") would save the view's work too, but it needs this ledger kept complete for ever; it is not built (a `BACKLOG.md` line, to be justified by a measurement). While anyone writes the plan, every plan page's next read is a `200`, rightly: the plan's revision is in every plan document.

Pinned by: `ViewValidatorsTest`, `ViewValidatorInputsTest`, `ViewNotModifiedWireTest`.
