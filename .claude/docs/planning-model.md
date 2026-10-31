### Planning model (placeholder — to be written in v0.2)

Not built yet. This file carries the **sketch** agreed in the bootstrap plan so the first planning increment (v0.2.0, plan structure) starts from it; the v0.2 plan confirms or amends each
line, and this document is then rewritten as the binding reference (entities, invariants, endpoints, kernels, decisions) in the commit that lands the first planning migration.
The product intent and the user's domain decisions are in `product.md`.

## Sketch (v0.2–v0.5, to be confirmed in the v0.2 plan)

- Flow conventions: SERIAL ids, epoch-millis timestamps, `SoftDeletable`, partial unique indexes, a migration + checksum pin per change (`persistence.md`, `conventions.md`).
- Dates as Postgres `DATE` via a repo-local `infra/db/LocalDateColumn.kt` (a spike test first; the fallback is Flow's `VARCHAR(10)` ISO-date idiom).
- `plan_state` singleton (revision + `FOR UPDATE` write lock) → race-free rank and cycle checks, view ETags, the baseline anchor.
- `people` (optional `user_id`); `teams.manager_person_id` replaces `manager_user_id`.
- `user_permissions(user_id, permission)` grant set (`ROADMAP_EDITOR`), checked in the database per request — **not** the feature-flag disabled-set (default-on, rides the JWT).
- `work_streams`, `programs`, `projects` (`target_start`/`target_end` both-or-neither), `milestones` (null dates = unscheduled, `estimate_md NUMERIC(8,2)`).
- `roadmap_entries(project_id, position)` and `team_milestone_orders(team_id, milestone_id, position)` — dense integers, `UNIQUE … DEFERRABLE`, wholesale PUT with `expectedRevision` (409 on stale).
- `dependencies`: nullable `pred_milestone_id|pred_project_id` and `succ_milestone_id|succ_project_id` with `num_nonnulls = 1` CHECKs, `type` FS/SS/FF/SF, `lag_days` (working days), `UNIQUE NULLS NOT DISTINCT`.
- Cycle detection on a start/end time-point graph including containment edges (DFS under the lock; reused by the critical path and the scheduler).
- `team_capacity_periods(team_id, effective_from, md_per_week)`.
- Derived spans, drift and load are computed at request time in pure kernels (`planning/`, the `CapacityKernels.kt` idiom), with shared JSON test vectors for Kotlin and vitest.
- API: resource CRUD per `list-endpoints.md` with the parents in the path for guards; one **view endpoint** per timeline (`/views/project/{id}`, `/views/team/{id}`, `/views/roadmap`,
  `/views/programs`) returning everything the page needs including `can:{…}` flags, like Flow's `/reports/home`.

## To write here in v0.2

The entity list with columns and constraints; the invariants (derived-span rules, drift definition, the global-rank vs team-order relation); the guard matrix per route (also in `authorization.md`);
the audit events (also in `observability.md`); the `plan_state` locking protocol and the 409 contract; the shared test vectors; the cross-feature read/write list additions (`persistence.md`).
