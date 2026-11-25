# Plan tree

Owns: the shared order of the work streams and of each stream's programs: the order tables (V34), the two PUTs, the revision guard, the delete and move hooks, the stale-row repair, the audit events, the effective order and what the views read of it. Not here: the DDL (`V34__plan_tree_order.sql`, `persistence.md`), the lock protocol and the plan view (`planning-model.md`), the guard order in general (`authorization.md` "Rules"), the event catalogue (`observability.md`), the ranking and the team order this order copies (`planning-model.md` "The global project rank", "The team milestone order").

## Rules

- **No row means "by name".** The tables hold only what someone listed; V34 wrote no data row, so a list nobody re-arranged keeps the name order it had. A work stream or program that is created, imported or moved in is unlisted until a PUT lists it. Create, close, reopen and the Jira import write no order row.
- **Two lists, two revisions, each its own.** The work stream order is guarded by `plan_state.work_stream_order_revision`, each stream's program order by `program_order_state.revision` (0 while never written). The plan revision is only their upper bound, so a plan write elsewhere, the other list or the ranking never stales a PUT ("Staleness").
- **Every order write runs in `withPlanWrite`**, the PUTs and the hooks alike. A PUT bumps the plan revision once, a no-op list and a reset (`[]`) included; a hook never stamps an order revision.
- **A PUT replaces its list wholesale**: the listed ids get positions 1..n in order, every other row of that list is removed (unlisted), `[]` is the reset. Positions stay dense 1..n (but the stale-row repair may leave a hole in the list it sweeps a row from: only the order counts); the unique constraints are `DEFERRABLE INITIALLY DEFERRED` (`persistence.md` "The roadmap rank (V13)").
- **403 before 400; the owner guard runs again under the lock** ("The two PUTs"). A 409 or a 400 found under the lock rolls the bump back and writes nothing.
- **The plan view and the programs view follow the order** ("The effective order", "What the views read"); everything else stays by name: Home, the baselines (overlay and comparison), the paged lists (`GET /work-streams`, `GET /programs`: no position member, no sort key) and every picker, which sorts explicitly. The programs view with `?baseline=N` draws its overlaid tree in the shared order too; only the removed rows and the comparison stay by name.
- `openFirstByName` (`web/src/utils/planNames.ts`: open first, then name) serves the move targets, the Deviations work stream filter and the Jira import scope step's work streams (its programs by name); the `planOptions` pickers (`workStreamOptions`, `programOptions`, `projectOptions`) sort by label.

## The tables

- `work_stream_orders (work_stream_id PK, position CHECK >= 1, uq_work_stream_orders_position UNIQUE (position))`: ONE global list.
- `program_orders (program_id PK, work_stream_id, position CHECK >= 1, uq_program_orders_position UNIQUE (work_stream_id, position))`: one list per work stream; `work_stream_id` is the stream the position belongs to.
- `program_order_state (work_stream_id PK, revision, updated_at)`: the first PUT of a stream's list inserts the row, later ones update it; never removed, inert for a deleted stream. `plan_state.work_stream_order_revision` is its twin for the stream list.
- No `ON DELETE` rule: work streams and programs are only soft-deleted, so the hooks ("Hooks") remove the rows. Hard-delete tables (`persistence.md` "Soft delete").
- Code: `planning/PlanOrder.kt` (the bodies, the shape validation), `PlanOrderService.kt` (the tables, both writes, the hooks), `PlanOrderRoutes.kt`; the helpers on `plan_state` are in `PlanState.kt`.

## The effective order

Pure kernel `planning/PlanOrderKernels.kt` (`orderWorkStreams`, `orderPrograms`; `PlanOrder` holds the stored positions, `ProgramSlot` a program's stream and position).

- **Work streams**: `compareBy(closed, position ?: unlisted, lowercase name, id)`. Closed (an end date) streams come after every open one WHATEVER their position, so a closed stream listed first is still last; among themselves they follow their positions.
- **Programs** (of one stream): `compareBy(position ?: unlisted, lowercase name, id)`. A position counts only when the order row's `work_stream_id` is the program's CURRENT stream, so the stale row of a moved program is inert.
- **Looked up FROM the active nodes**: the kernels never walk the order rows, so rows of deleted or moved nodes change nothing. With no row stored the result is today's order exactly (same comparator, open first, then name, then id). Unlisted nodes follow the listed ones, by name.
- Projects stay by name on the Plan view and as they are (ranked first) on the Programs view.

## What the views read

- **One snapshot, four selects.** `readPlanOrder` (`PlanOrderService.kt`) runs inside the view's own snapshot transaction right after the plan revision: `work_stream_orders`, `program_orders`, `program_order_state` (each whole, no per-stream round trip) and `plan_state.work_stream_order_revision`. The plan view (`PlanViewService`) and the programs view (`ProgramsViewService` into `ProgramsTree.assemble(order = …)`, default `PlanOrder.NONE`) both draw it.
- **Plan view members**: `workStreamOrderRevision` and, per stream, `programOrderRevision` are the revisions the PUTs compare (0 when never written); `can.orderWorkStreams` is `PlanPermissions.canOrderWorkStreams` (ADMIN) and each stream's `can.orderPrograms` `canOrderPrograms` (`canManage` on the stream's chain), pinned against the real PUTs and guards (`PlanPermissionsTest`, `PlanOrderViewTest`). The programs view carries no order member.
- **The tag** (`ETag`) hashes the answer, so an order write moves the plan and programs tags with no ledger entry: the order tables are plan state (`ViewValidatorInputsTest`).

## The two PUTs

| | `PUT /work-stream-order` | `PUT /work-streams/{id}/program-order` |
|---|---|---|
| Body | `{expectedRevision, workStreamIds[]}` | `{expectedRevision, programIds[]}` |
| Answer | `200 {revision}`: the plan revision the write left behind, now that list's own revision | the same |
| Who | ADMIN | the stream's owner or ADMIN (a program's or project's owner gets 403) |
| Before the lock | `requireAdmin` (before the body: a forbidden caller's malformed body stays 403) -> body -> shape 400 | stream chain ?: 404 (any caller) -> `requireOwnerOrAdmin` 403 -> body -> shape 400 |
| Under the lock | 409 stale -> 400 an id is not an ACTIVE work stream -> rewrite -> stamp | chain re-read 404 -> the guard again 403 (no bump) -> 409 stale -> 400 an id is not an ACTIVE program OF THIS stream -> rewrite -> stamp |
| Rewrite | `DELETE` every row, one `insertRows` 1..n | `DELETE WHERE work_stream_id = ? OR program_id IN (ids)`, one `insertRows` 1..n |

- **The shape 400s** (before the lock, `validateWorkStreamOrder` / `validateProgramOrder`): a negative `expectedRevision`, more than 1000 ids (`MAX_PLAN_ORDER_IDS`), an id twice. A foreign or unknown id is a 400 under the lock, never a foreign-key 500; the detail names at most a few ids.
- The program PUT's guard under the lock is `PlanRouteDeps.ownerGuard` (the caller's person re-read `FOR SHARE`), so an owner demoted while the request waited is a 403 with no bump; a stream deleted meanwhile is a 404.
- Both routes are `planning/PlanOrderRoutes.kt`; the service is `PlanOrderService.replaceWorkStreamOrder` / `replaceProgramOrder`.

## Staleness

- **Stale** = the list's stored revision is above `expectedRevision`, OR `expectedRevision` is above the plan revision read under the lock (a view from the future): `409` `urn:astrolabe:problem:stale-revision` (`STALE_REVISION_PROBLEM`), nothing written, no bump.
- A list never written has revision 0, so its first write accepts any `expectedRevision` from 0 up to the plan revision. The answered `revision` is the next `expectedRevision` of that list. A reset (`[]`) is stamped like any write.
- Two PUTs of one list with the same `expectedRevision` race at the lock: exactly one wins, the other is the 409; the other list's PUT, another stream's, a ranking and any other plan write stale neither.

## Hooks

Each runs inside the plan-locked transaction of the write that triggers it and stamps no order revision (the team order's rule: the admin's list is still the admin's list).

| Event | Effect on the order tables |
|---|---|
| `WorkStreamService.delete` | `removeFromWorkStreamOrder`: the row is deleted and the positions above it shift down in ONE `UPDATE`; an unlisted stream is a no-op |
| `ProgramService.delete` | `removeFromProgramOrder`: the same, within the program's stream |
| `ProgramService.move` to another stream | `removeFromProgramOrder`: the program leaves the source list (the gap closes) and is unlisted in the target; a move to the current stream writes nothing |
| Create a work stream or program, close or reopen a stream, the Jira import (`insertProgramRow`) | nothing: the newcomer is unlisted |

## Stale-row repair

A 1.27 build run on the V34 schema does not know the tables, so its deletes and moves leave inert rows: a deleted program's, a program's naming the stream it moved out of, a deleted stream's. Nothing breaks: the next PUT of that list removes them. The work stream PUT deletes every row; the program PUT deletes by stream OR by listed program id, so a leftover row naming another stream cannot collide with the insert on the program's primary key.

## Audit

Every accepted PUT is audited, a no-op list and a reset included; a 409, a 400 or a 404 emits nothing, a 403 is the central `authz.denied`. Fields: `byUserId`, `revisionFrom` / `revisionTo` (the plan revisions around the write), `orderFrom` (the LISTED ids before) and `orderTo` (the ids after), comma-joined text, "" = none listed.

- `plan.work_stream_order_changed` (`PUT /work-stream-order`).
- `work_stream.program_order_changed` (`PUT /work-streams/{id}/program-order`, with `workStreamId`).

The hooks emit nothing of their own: `work_stream.deleted`, `program.deleted` and `program.moved` cover them.

## Pinned by

`PlanOrderTest` (the guard matrix and its order, the 400s, both 409 directions, each list's own revision, a partial list and the reset, the audit), `PlanOrderLifecycleTest` (the hooks and the dense positions, create and close writing nothing, the deferrable constraints, the same-revision race, a stream deleted or an owner demoted at the lock, the stale-row repair), `PlanStateTest` (the one bump a PUT), `MigrationChecksumTest`.

The read side: `PlanOrderKernelsTest` (the comparator against the old one, closed last, the stale slot), `PlanOrderViewTest` (both views follow, the revisions, the flags against the PUTs), `ProgramsTreeTest`, `ViewValidatorInputsTest`.
