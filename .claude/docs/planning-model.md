### Planning model (placeholder — to be written in v0.2)

Not built yet. This file carries the **sketch** agreed in the bootstrap plan so the first planning increment (v0.2.0, plan structure) starts from it; the v0.2 plan confirms or amends each
line, and this document is then rewritten as the binding reference (entities, invariants, endpoints, kernels, decisions) in the commit that lands the first planning migration.
The product intent and the user's domain decisions are in `product.md`.

## Sketch (v0.2–v0.5, to be confirmed in the v0.2 plan)

- Flow conventions: SERIAL ids, epoch-millis timestamps, `SoftDeletable`, partial unique indexes, a migration + checksum pin per change (`persistence.md`, `conventions.md`).
- Dates as Postgres `DATE` via a repo-local `infra/db/LocalDateColumn.kt` (a spike test first; the fallback is Flow's `VARCHAR(10)` ISO-date idiom).
- `plan_state` singleton (revision + `FOR UPDATE` write lock) → race-free rank and cycle checks, view ETags, the baseline anchor.
- `people` (optional `user_id`); `teams.manager_person_id` replaces `manager_user_id` — **built in V10 (v0.2.0), see "People" below**.
- `user_permissions(user_id, permission)` grant set (`ROADMAP_EDITOR`), checked in the database per request — **not** the feature-flag disabled-set (default-on, rides the JWT).
- `work_streams`, `programs`, `projects` (`target_start`/`target_end` both-or-neither), `milestones` (null dates = unscheduled, `estimate_md NUMERIC(8,2)`).
- `roadmap_entries(project_id, position)` and `team_milestone_orders(team_id, milestone_id, position)` — dense integers, `UNIQUE … DEFERRABLE`, wholesale PUT with `expectedRevision` (409 on stale).
- `dependencies`: nullable `pred_milestone_id|pred_project_id` and `succ_milestone_id|succ_project_id` with `num_nonnulls = 1` CHECKs, `type` FS/SS/FF/SF, `lag_days` (working days), `UNIQUE NULLS NOT DISTINCT`.
- Cycle detection on a start/end time-point graph including containment edges (DFS under the lock; reused by the critical path and the scheduler).
- `team_capacity_periods(team_id, effective_from, md_per_week)`.
- Derived spans, drift and load are computed at request time in pure kernels (`planning/`, the `CapacityKernels.kt` idiom), with shared JSON test vectors for Kotlin and vitest.
- API: resource CRUD per `list-endpoints.md` with the parents in the path for guards; one **view endpoint** per timeline (`/views/project/{id}`, `/views/team/{id}`, `/views/roadmap`,
  `/views/programs`) returning everything the page needs including `can:{…}` flags, like Flow's `/reports/home`.

## People (built — V10, v0.2.0)

The binding part of this document so far; the rest of the sketch is rewritten as its migration lands.

- **Table `people`** (`people/PersonService.kt`, `SoftDeletable`): `id SERIAL`, `name VARCHAR(100) NOT NULL`, `email VARCHAR(254) NULL`, `user_id BIGINT NULL REFERENCES users(id)`,
  epoch-millis `created_at`/`updated_at`, `marked_as_deleted`. A person is NOT a login: `user_id` links the optional account (an external owner has none).
- **Constraints** (partial, active rows only, the V6 shape): `uq_people_email_active ON (LOWER(email)) WHERE email IS NOT NULL` (an optional email, unique when set) and
  `uq_people_user_id_active ON (user_id) WHERE user_id IS NOT NULL` (one active person per login). Names are NOT unique (two real "Anna Nowak"s). `409` wording lives in `ErrorHandling.kt`.
- **The link** (§ person-to-user): set by an ADMIN through `userId` on the person create/update bodies; must be an ACTIVE user (`400`), not linked to another active person (`409`). A soft-deleted
  user leaves the person and the link in place, inert (reads resolve the login through ACTIVE users and show it as unlinked; the caller's person is `people.user_id = caller AND people.active()`).
  Name and email edits never cascade between the user and the person — they are separate records, and the person's name is the display name on the plan. `person.link_changed` is audited only on change.
- **Teams**: `teams.manager_person_id` replaced `manager_user_id` (V10 backfilled one person per ACTIVE user managing an ACTIVE team, linked to that user; a soft-deleted manager stayed unset).
  `isActiveManager(teamId, userId)` = an active team whose manager is an active person with `user_id = userId`.
- **Delete**: `409` ("Person is still an owner or a team manager") while the person manages an ACTIVE team; the plan tables (V12) join the check. Reads are open to every authenticated user,
  emails included (the owner pickers need them); writes are ADMIN only (`authorization.md`).
- **Tests**: `PersonTest`, `PersonMigrationTest` (V10's backfill on V9-era data in a scratch database), `TeamTest`, `TestPeople` (the fixture).

## To write here in v0.2

The entity list with columns and constraints; the invariants (derived-span rules, drift definition, the global-rank vs team-order relation); the guard matrix per route (also in `authorization.md`);
the audit events (also in `observability.md`); the `plan_state` locking protocol and the 409 contract; the shared test vectors; the cross-feature read/write list additions (`persistence.md`).
