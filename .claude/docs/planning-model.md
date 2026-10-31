### Planning model

The binding reference for the planning domain as it is built (v0.2.0: people, permissions and dates, the plan structure, the roadmap ranking). The product intent and the user's domain
decisions are in `product.md`; the parts not built yet stay a **sketch** at the end (milestones, dependencies, capacity — the v0.3+ increments confirm or amend each line and rewrite it here when
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

Hierarchy **work stream → program → project**; every node has an OWNER, a person of the people directory, REQUIRED (`owner_person_id NOT NULL`: ownership-scoped rights need an owner). Parents are
immutable — a node is created under its parent and its update body carries no parent (a reparent endpoint is deferred to v0.3, when milestones make delete-and-recreate expensive; adding
`POST /projects/{id}/move` later is purely additive). Nothing hangs under a project yet.

### Entities (V12)

| Table | Columns beyond `id`, `created_at`, `updated_at`, `marked_as_deleted` | Constraints |
|---|---|---|
| `plan_state` | `id SMALLINT` (the single row, `CHECK id = 1`), `revision BIGINT`, `updated_at` | the revision lock, below |
| `work_streams` | `name`, `description`, `owner_person_id → people`, `start_date DATE NOT NULL`, `end_date DATE NULL` (set only when the stream is CLOSED) | `ck_work_streams_end_after_start` (end ≥ start); `uq_work_streams_name_active ON LOWER(name)` (global) |
| `programs` | `work_stream_id → work_streams`, `name`, `description`, `owner_person_id → people` | `uq_programs_name_active ON LOWER(name)` (global, ≈20 programs each named once) |
| `projects` | `program_id → programs`, `name`, `description`, `owner_person_id → people`, `target_start`/`target_end DATE NULL` | `ck_projects_target_window` (both or neither), `ck_projects_target_order` (end ≥ start); `uq_projects_program_name_active ON (program_id, LOWER(name))` (per program: "Discovery"/"MVP"/"Rollout" recur) |

All three uniqueness indexes are partial over ACTIVE rows, so a deleted or renamed node frees its name; the 409 wording is in `UNIQUE_CONSTRAINT_DETAILS` (`ErrorHandling.kt`). A program's span is
derived from its projects and a project's real span from its milestones (later) — nothing is stored for them. A closed work stream (end date set) still accepts new programs and projects in v0.2 (the
timeline will show it closed later). The owner is changed through the ordinary full-replace PUT.

### The `plan_state` lock protocol and the 409 contract (`planning/PlanState.kt`)

`R2dbcDatabase.withPlanWrite { revision -> … }` = one transaction: `SELECT revision FROM plan_state WHERE id = 1 FOR UPDATE`, run the block, `UPDATE plan_state SET revision = revision + 1`. **Every
mutation of `work_streams`, `programs`, `projects` and `roadmap_entries` (V13) runs inside it** — people and teams are not plan state. A block that throws (404/409/400 found after the lock) rolls
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
`PUT /projects/{id}/target-window`; `GET /views/plan`; and the ranking (below): `GET /views/roadmap`, `PUT /roadmap/ranking`. PUTs are full replaces (omitted optional = unset; `204`); creates answer `201` + `Location` + the record. **No paged lists** for
streams/programs/projects in v0.2 — a list lands with its first consumer (the v0.4 dependency pickers); the plan view is the read surface. `WorkStreamResponse` etc. carry `ownerPersonId` +
`ownerName`; a project also carries `workStreamId`.

**The plan view** (`GET /views/plan`, any authenticated user; the documented view-endpoint shape exception of `list-endpoints.md`, bounded by the scale ≈5 streams / 20 programs / 100 projects):
`{revision, can{createWorkStream}, workStreams[]{…, can{edit, delete, createProgram}, programs[]{…, can{edit, delete, createProject}, projects[]{…, can{edit, delete, editTargetWindow}}}}}`, open work streams
first then closed ones, each level by name (case-insensitive, then id).

### Authorization (the matrix in `authorization.md`)

ADMIN everything; ownership cascades down (an owner at ANY level of a node's chain acts on the node); a project's own owner edits the project but does NOT set its target window (ADMIN, an owner above
it, or a `ROADMAP_EDITOR` do); reads open to every authenticated user; creating a work stream is ADMIN only. Plan routes are **read-before-guard**: chain → 404 → guard 403 → body 400 → validate 400 → write.
Any owner on the chain, the node's own included, may reassign the node's owner (a hand-over; the ancestors can always take it back). The `can:{}` flags come from the pure kernel
`planning/PlanPermissions.kt`, which uses the SAME arithmetic as the guards (`authz/Guards.kt`); `PlanPermissionsTest` pins the agreement table-driven.

### Audit events (`observability.md`)

`work_stream.created/updated/deleted`, `work_stream.owner_changed`, `work_stream.closed` / `work_stream.reopened` (end-date transitions), `program.created/updated/owner_changed/deleted`,
`project.created/updated/owner_changed/deleted`, `project.target_window_changed` (start/end from/to). Owner changes and window changes are their own trail lines (rights paths). The ranking adds `roadmap.ranked` (below).

### Tests

`PlanStructureTest` (the HTTP matrix: every route × every kind of caller, 404-before-403, 403-before-body, owner hand-over, name uniqueness per scope, delete 409s, audit), `PlanViewTest` (ordering, the
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

## Not built yet — the sketch (v0.3–v0.5, confirmed by each increment)

- `team_milestone_orders(team_id, milestone_id, position)` — the roadmap's sibling (above): dense integers, `UNIQUE … DEFERRABLE`, wholesale PUT with `expectedRevision` (409 on stale) under the `plan_state` lock.
- `milestones` (null dates = unscheduled, `estimate_md NUMERIC(8,2)`, exactly one team, no owner).
- `dependencies`: nullable `pred_milestone_id|pred_project_id` and `succ_milestone_id|succ_project_id` with `num_nonnulls = 1` CHECKs, `type` FS/SS/FF/SF, `lag_days` (working days), `UNIQUE NULLS NOT DISTINCT`.
- Cycle detection on a start/end time-point graph including containment edges (DFS under the plan lock; reused by the critical path and the scheduler).
- `team_capacity_periods(team_id, effective_from, md_per_week)`.
- Derived spans, drift and load are computed at request time in pure kernels (`planning/`, the `CapacityKernels.kt` idiom), with shared JSON test vectors for Kotlin and vitest (deferred to the first
  kernel that needs them; `PlanPermissions` is the first pure kernel and is tested against the guards instead).
- More view endpoints (`/views/project/{id}`, `/views/team/{id}`, `/views/programs`; `/views/plan` and `/views/roadmap` are built), each one document with `can:{…}` flags and a revision, like Flow's `/reports/home`.
