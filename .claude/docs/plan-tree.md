# Plan tree

Owns: the shared order of the work streams and of each stream's programs: the order tables (V34), the two PUTs, the revision guard, the delete and move hooks, the stale-row repair, the audit, the effective order and what the views read, and the Plan page's tree table (rows, folds, menu). Not here: the DDL (`persistence.md`), the lock protocol and the plan view (`planning-model.md`), the guard order (`authorization.md` "Rules"), the event catalogue (`observability.md`), the ranking and the team order this order copies (`planning-model.md` "The global project rank", "The team milestone order").

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

## The Plan page's tree

`/plan` is ONE native table (`PlanTree`), not a `treegrid`: row headers, disclosure buttons and ordinary links, "+" buttons and menus in cells. Pure model `utils/planTree.ts` (`planRows`, `foldableKeys`, `toggledCollapsed`; no React, no i18n); the page only composes ("Plan" in `web-internals.md`).

- **Rows.** One `<tr>` per visible node in the server's order, keyed `ws:<id>` / `pg:<id>` / `pj:<id>` (kind + id, never an index). A row carries `data-key`, `data-parent` (the parent's key), `data-kind`, `data-scope` and, once filters exist, `data-context`; `PlanTreeRow` takes a `scope` ("tree" or "pinned") so the pinned section can reuse it.
- **Name cell** (`<th scope="row">`): indent 1.25rem a level, then a disclosure button (chevron and name, `aria-expanded`, `aria-label` "Work stream X" / "Program X", no `aria-controls`) when the node has children, plain text with a hidden kind word when it has none, the project link ("Open X") for a project. After it: the count with its unit ("3 programs", dimmed, outside the button's name), a gray "Closed" badge, one clamped dimmed description line (the full text in the DOM and in `title`). Weights 600 / 500 / 400; a 2px rule above each work stream row; no tints, no per-level colours.
- **Other cells.** Owner; Dates (a stream "From ..." or its range, a program none, a project's window behind a hidden "Target window:" or a dimmed "Not set"); actions (an icon-only "+" under today's names "New program in X" / "New project in X", and the row menu). The table is `layout="fixed"` with a `colgroup` and scrolls in the house `ScrollRegion` (min width 800); the actions column (its `col` too), the toolbar and the chevron icons are `data-print="hide"`.
- **Sticky actions.** The actions cells are `position: sticky` at the scroller's right edge (an opaque surface, the row's hover tint laid over it, a hairline below 48em). The plan table sets `overflow: visible`: the theme's `overflow: hidden` frame would make the table, not the ScrollRegion, the sticky container.
- **Row menu** (`PlanRowMenu`): groups with a divider between the groups that exist: view (Show only this, a real link, for a work stream or program that is not the focus root; Pin or Unpin), edit (Edit, Close or Reopen, Move to..., Import from Jira...), then delete. The order group (move up, down) goes after the view group. Every item keeps its `aria-label` and its `can` gate. Everyone may focus and pin, so every tree row has a menu, read-only viewers included; its button carries `data-operations-for` (`tree:pg:12`, `pin:ws:3>pg:12`).
- **Folds** (`usePlanFolds`, `astrolabe.viewSettings.plan.collapsed`): the stored set holds the FOLDED keys, so a first visit shows everything open and a new node is open. A key of a node the plan no longer holds matches nothing and is dropped at the user's next change. Expand all stores `[]`, Collapse all the keys of the nodes that have children. A node created, moved or imported (an apply's answer) under a folded parent opens that parent and its stream, so it is never out of sight.
- **Filters** (`usePlanFilters`, `utils/planTreeParams.ts`): `q` (a name search, trimmed, at most 100 characters), `ownerPersonId` and `hideClosed=true`, in the ADDRESS only (a `replace`; never remembered, every other parameter kept; a malformed value or an owner the plan does not hold is ignored).
- **The search box.** At most 100 characters; it keeps the text as typed and writes the address 300 ms after the last keystroke, through the LATEST `setParams` so a Hide closed or owner change made meanwhile is not undone; an address changed from outside replaces the text, and the next change drops an owner the plan does not hold. The panel's open state is `astrolabe.viewSettings.plan.filtersOpen`.
- **The filter pass** (`planRows(view, collapsed, filter)`): a node matches when its name contains the search (`foldDiacritics`, so case- and accent-insensitive) AND its owner is the one picked. Shown: the matches, their ancestors as CONTEXT rows (`context: true`, `data-context`, dimmed text and a hidden "Contains a match", so colour is not the only cue) and everything under a match.
- **Match rule.** A search that folds to nothing (a lone accent mark) is no search. Hide closed drops the closed streams, searched or not. Counts stay the document's own. `foldedMatchRange` (`utils/text.ts`) marks the matched letters of a name (`<mark>`, bold and underlined: no new colour).
- **Folds under a search.** The stored folds neither apply nor change while a search or owner is on (hide closed alone is not a search): the rows start fully open, so the way to every match shows `aria-expanded="true"`, and the user's folds, Expand all and Collapse all go to a TRANSIENT set that starts afresh with every change of the filter. Clearing the search brings the stored folds back untouched. Expand all and Collapse all touch the shown nodes only, so Hide closed alone never drops the fold of a hidden closed stream.
- **Empty and print.** No row left: an empty state "No row matches" with a "Clear filters" button (clears all three, says so and moves the focus to the search box). A filtered plan prints a `data-print="only"` line saying not every row is shown.
## Focus, pins and the pinned section

- **Focus** ("Show only this"): `workStreamId=<id>` or `programId=<id>` in the address, set by the row menu's link and the breadcrumb (`planFilterPath`, `usePlanFilters.focusHref`: the filters and other parameters kept; a program wins over a work stream, but one the plan does not hold falls back to a valid work stream of the same address; a node the plan does not hold is ignored). `planRows` restricts the table to the subtree (a program focus starts at the program, with no work stream row); 
- **Focus: the table.** A search under a focus is bounded to it, hide closed never drops the stream that holds it, and the root is always open (`locked`: no disclosure button, never in Collapse all). Clear filters keeps the focus.
- **Breadcrumb.** `PlanBreadcrumb` ("All work streams" > stream > program) is a nav of real links; the last step is `aria-current`.
- **Focus after a link.** "Show only this" leaves the focus on the row's menu button (the row persists). A breadcrumb step (any step: the node it leaves is the deepest one) says "Showing only X" / "Showing the whole plan" and, once the address has changed, focuses the first control of the row of the node it left, else the page title (`usePlanFocusReturn`). A ctrl, cmd, shift, alt or middle click (`isPlainClick`) opens the link elsewhere: nothing is said and no move is left pending.
- **Pins** (`usePlanPins`, `utils/planPins.ts`): the pinned node keys, in pin order, in `astrolabe.viewSettings.plan.pins`; the folds inside the section are composite `root>key` keys in `plan.pinnedCollapsed`, apart from the tree's; `plan.pinnedOpen` is the section's own fold (open by default). A pin may be a work stream, program or project. 
- **Pins: storage.** A key of a deleted node draws nothing and is pruned only at the user's next pin change, against a settled view; that change also drops the folds of a root no longer pinned, and a pin opens a folded section. The tree row of a pinned node carries a dimmed marker.
- **The Pinned section** (`PlanPinned`): a plain wrapper, not a landmark, with an h3 whose button folds it, then a `ScrollRegion` (`min(40vh, 20rem)`, its own scroll) of the same rows (`scope="pinned"`, the tree's colgroup, a visually hidden header).
- **Pinned section: behaviour.** It ignores the filters, the focus and hide closed. It is `position: sticky` under the app header (`--app-shell-header-offset`), static below 48em, with a shadow when stuck (a named `scroll-state` container query); the tree's rows (not the pinned ones, which scroll inside their own region) keep `scroll-margin-top` clear of its measured height. Known limits: the visually hidden header of the pinned table is not tested in Safari; a work stream and its program both pinned show the program twice.
- **Pinned section: rows and names.** Its rows have no Pin item; a root has a visible Unpin button; every accessible name is wrapped "X (pinned)" (`scopedLabel`) so no two controls share a name. Unpin there moves the focus to the next pinned root's Unpin, else the previous, else the node's menu button in the tree, else the title; from the tree's menu the focus stays on the menu button. It does not print.
- **Announcements.** The page's one polite status region says "X pinned" / "X unpinned", "Showing only X" / "Showing the whole plan", "1 row matches" / "No row matches" after a search or owner change (the focus stays in the box), "X expanded, 3 programs", "X collapsed", "Every work stream and program expanded / collapsed". A toggle never moves the focus: the row stays in the list, so the button is the same DOM node.

## Pinned by

`PlanOrderTest` (the guard matrix and its order, the 400s, both 409 directions, each list's own revision, a partial list and the reset, the audit), `PlanOrderLifecycleTest` (the hooks and the dense positions, create and close writing nothing, the deferrable constraints, the same-revision race, a stream deleted or an owner demoted at the lock, the stale-row repair), `PlanStateTest` (the one bump a PUT), `MigrationChecksumTest`.

The Plan page: `planTree.test.ts` (rows, folds, pruning), `planTreeParams.test.ts`, `Plan.rows.test.tsx`, `Plan.tree.test.tsx` (the table, the folds, their storage, the announcements, a reader with no rights) and `Plan.filters.test.tsx` (the address, the search, context rows, folds under a search, the owner, hide closed, the empty state, print), `planPins.test.ts`, `Plan.pins.test.tsx` (pins, the wrapped names, the section's folds, the focus after Unpin) and `Plan.focus.test.tsx` (the address, the breadcrumb, Show only this), `PlanMove.test.tsx`.

The read side: `PlanOrderKernelsTest` (the comparator against the old one, closed last, the stale slot), `PlanOrderViewTest` (both views follow, the revisions, the flags against the PUTs), `ProgramsTreeTest`, `ViewValidatorInputsTest`.
