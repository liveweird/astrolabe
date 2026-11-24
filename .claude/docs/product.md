# Product, roadmap and donors

Owns: what Astrolabe is, the scope of every version, the decisions the user took, the defaults taken without asking, what each donor gave, and the release history (newest first). Not here: the binding one-liners (the hierarchy, the current version, "Port, don't reinvent") are in `CLAUDE.md`; the domain model is `planning-model.md`; the timeline component is `timeline.md`; how an area works now is its own doc, and git keeps what happened step by step. The plans of each increment live outside the repository.

Read on demand when you need the product intent, the scope of a version, a decision the user already took or what a donor contributed. A decision recorded here is the user's unless it is filed under "Assumptions" (taken without asking, change on request).

## What Astrolabe is

A planning and roadmapping app in the spirit of Jira Plans: better UX, more opinionated, Gantt-centred, for a multi-stream / multi-program / multi-team environment. It keeps its **own** plan data. It reads Jira and Flow only to **detect deviations** and, on request, to import items; corrections are made in Astrolabe, never written back. The name is the instrument: a tool for reading where everything stands against time.

Scale assumed: about 15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones.

- **Gantt.** A custom shared timeline component: DOM rows, SVG arrows, dnd-kit, TanStack Virtual (`timeline.md`).
- **Brand.** Deep cyan / ocean (the `astrolabe` colour tuple, primary `#0b7285` light, `#095c6b` dark); the logo is a stylised astrolabe (limb ring with ticks, rete star pointers, alidade). Success is green, red = blocking, orange = warning (`web/CLAUDE.md`).

## Roadmap

Each increment gets its own plan (architect) before implementation; only v0.1.0 was specified up front. **Current version: 1.25.1.** Version numbers are not strictly roadmap milestones (`app-releases.md`): a user-visible fix between two increments is a patch bump. One row a version (patches ride their minor's row); the scope only, the detail is in "Release history".

### 0.1 to 0.9: the plan

| Ver | Scope |
|---|---|
| **0.1.0 Foundation** | Flow trimmed: auth and email MFA, password reset, users and feature flags, teams with a manager, EN/PL, light/dark, changelog, telemetry panel, cyan brand and logo |
| **0.2.0 Plan structure** | People; work streams, programs and projects with owners and owner-scoped guards; the `ROADMAP_EDITOR` grant; the Plan page; the ranked Roadmap list |
| **0.3.0 Timeline and project view** | The shared `Timeline*` component; milestones; `PUT /milestones/{id}/schedule` for the team's manager or ADMIN; the Unscheduled tray; derived project span and target band |
| **0.4.0 Dependencies** | FS/SS/FF/SF plus lag between milestones and projects; SVG arrows; cycles answer 409; violations in red and listed; ghost rows for outside ends |
| **0.5.0 Team view and capacity** | Capacity periods, the weekly load strip and overload, the team's own milestone order, scheduling from the team page, the deterministic scale dataset `sample-data/plan/` |
| **0.6.0 Roadmap and programs timelines** | The Roadmap as a timeline (row drag ranks), the Programs tree, spans derived upward, the target window by drag, draw and dialog, drift and rank-inversion flags, Year zoom |
| **0.7.0 Calendar and critical path** | The ADMIN public-holiday dictionary (V19) behind every working-day figure; the per-project critical path with slack; idle gaps of 3+ working days |
| **0.8.0 Auto-proposal** | "Propose schedule": a pure kernel places a team's not-started milestones (order, dependencies, capacity, WIP, holidays); a diff preview; accept all or some in one batch; nothing stored |
| **0.9.0 Baselines** | Named, immutable plan-wide snapshots (V20); a `?baseline=` overlay on the four timelines, a Movement table, a comparison page; a scope check on the proposal's accept |

### 1.0 to 1.9: the checkup and the connectors

| Ver | Scope |
|---|---|
| **1.0.0 Checkup** | Doc drift and the docs-budget gate; the OrbStack k8s overlay and a hardened compose app; a password-change lock and an MFA live-code limit; a11y lint and axe; coverage floors raised |
| **1.1.0 Jira connection, bindings, deviations** | The guarded Jira client, the ADMIN registry (token encrypted), mapping, Peek, 1:1 bindings, manual Refresh, the Deviations page and chips, the stub (V21); stub-proven |
| **1.2.0 Import from Jira** | Preview, then apply into ONE picked work stream by the Jira parent; same-name nodes linked, estimates by a declared unit, one plan write; the stub's `IMP` project |
| **1.3.0 Polling, status, acknowledge, markers** | The in-process scheduler (5..1440 minutes, default 15), five derived connection states, acknowledge per binding, Jira flags and a Jira dates bar on the timelines (V22) |
| **1.4.0 Coverage and roll-ups** | The run mirrors the child level (V23); three coverage deviation kinds on a bound parent; the story roll-up on the chip; the `COV` stub project |
| **1.5.0 Flow** | The ADMIN Flow registry (token encrypted, polled as `SyncKind.FLOW`), team binding by name, the capacity import, the roster panel, the Flow stub (V24); 1.5.1 fixed the first real connections |
| **1.6.0 Capacity deviation** | `GET /views/capacity-deviations`, the Deviations page's "Capacity from Flow" section and the team page's "Capacity vs Flow" line: per sprint, a 0.5 man-day threshold; nothing stored |
| **1.7.0 Planning features** | The critical path on the team page and the Roadmap, per-link slack, the pin (V25), two baselines compared, rank movement against a baseline |
| **1.8.0 Cross-team run** | `POST /schedule-proposals` over a set of teams in dependency order to a fixed point; one accept in one plan write; a check of the ticked subset; the `/schedule-proposals` page |
| **1.9.0 Flow follow-ups** | The per-sprint acknowledge of the capacity deviation (V26) and the team view's Flow capacity flag and weeks-strip mark |

### 1.10 to 1.24: follow-ups, views and fixes

| Ver | Scope |
|---|---|
| **1.10.0 Sync follow-ups** | The gone-probe retried until Jira answers (V27); acknowledgements live only while their row is listed; acknowledge all; the Home landing; `::/96` refused; 1.10.1 fifteen small fixes |
| **1.11.0 Withdraw all** | `unacknowledge-all` and "Withdraw all (N)"; the Netty read timeout re-armed per interval |
| **1.12.0 Jira deviation polish** | Per-line acknowledgement of Jira deviations (V28); a team manager may acknowledge their team's milestone bindings; acknowledge all / withdraw all |
| **1.13.0 Jira tail** | The gone probe follows the key Jira answers with (`NOT_LISTED`, V29); V22's acknowledgement columns dropped (V30). Patches 1.13.1 to 1.13.4: fixes, the import filter, a login creates its person, the preview search |
| **1.14.0 Import under a linked node** | The import starts from a linked program or project and reads only what Jira lists under it; the connection's Coverage table; a per-row owner; `CHILDREN_OPEN`; a project's target window copied from Jira |
| **1.15.0 Import entry points, suggested matches** | The rooted import from the Plan page and the links list; `GET /views/jira-links`; suggested links for renamed items; slimmer Jira blocks in the timeline views |
| **1.16.0 Timeline extras** | A dashed read-only row for an unscheduled milestone whose Jira item holds both dates; `jiraSites[]` with `state` and `mappingOk`; rolled-up arrows and the critical path on Programs |
| **1.17.0 Follow-ups, deploy notice** | Web only: the critical-path pick announced once, one staleness rule, "Schedule on Jira's dates", a deploy notice with a Reload button |
| **1.18.0 Home figures and "Yours"** | `GET /views/home`: the plan's own figures and what the caller owns directly or manages ("Yours"), linked from Home's cards |
| **1.19.0 Home links, Milestones, Team load** | Home's figures link to filtered views; a Milestones page; a Team load page (`GET /views/team-load`); the Roadmap's filters in the address |
| **1.20.0 Dependencies** | A Dependencies page (`GET /views/dependencies`, the violated first, at most 1,000 rows) with filters in the address; links into it from Home, the Roadmap, Programs and the team page |
| **1.21.0 Filters, Team load by week** | The Programs pick in the address; "unranked only" and a severity filter on the Roadmap; a Project select and every team on Milestones and Dependencies; Team load per week; a slimmer Dependencies document |
| **1.22.0 View ETags, dependencies edited from the list** | Ten view reads answer an `ETag` and `304`; "Edit..." and "Delete" on a Dependencies row the caller may change; Team load from this week on (`?past=true`) |
| **1.23.0 Database time limit, Flow capacity flag, Home "Yours"** | A 15 s statement limit (`POSTGRES_STATEMENT_TIMEOUT_SECONDS`), the focus after "edit, then delete", the Flow capacity flag on the Roadmap and Programs, everything you manage on Home (no migration) |
| **1.24.0 Technical release** | No feature: docs in Rules and sections with a guard, the spec's descriptions as contract, shared Jira and Flow pieces, two CI forks, a named e2e target; the item-level `acknowledgement` leaves `GET /views/deviations` |
| **1.25.0 Reliability and navigation** | Complete Flow sprint snapshots (V31), atomic project edits, consistent API reads, grouped navigation and refreshed Home; 1.25.1 a new logo |
| **1.26.0 Saved proposals, frozen links and capacity** (built, not yet released) | Cross-team runs saved and read by every signed-in user (V32); baselines freeze links and capacity (V33); paged `GET /work-streams` and `/programs`; docs under byte ceilings, fewer test sleeps |

## Domain decisions taken with the user

An answer is the user's own, including "all recommended" (the user chose the recommended option). The answers that shaped only one version's build are in "Release history"; each topic below says where its later answers are.

### Hierarchy and ownership

- **Hierarchy.** Work stream (start, owner; end set only on close) → program (owner; span derived from its projects) → project (owner; **optional target window**; real span derived from milestones; drift flagged) → milestone (start/end, man-day estimate, exactly one team, no owner). All have a name and a description.
- **Owners.** A **people directory** (name, email, optional link to a login); owners are people, not necessarily users.
- **Permissions (owner-scoped).** ADMIN may do everything. Ownership cascades down (work stream → program → project). A project owner edits the project and its milestones' plan fields (name, description, team, estimate, dependencies) but **not dates**. **Milestone dates are set only by the team's manager** (or ADMIN). The global rank is edited by ADMIN and by users with the per-user **ROADMAP_EDITOR** grant. A team manager edits the team's capacity and team order. Reads are open to every authenticated user.
- **Plans.** One live plan; plan-wide baselines to compare it with (0.9.0); no scenarios.

### Auto-proposal, pin and the cross-team run

- **Scheduling.** Manual drag/resize first. The auto-proposal (0.8.0): rank + dependencies + capacity give a proposal the manager accepts or adjusts; it never writes by itself.
- **Auto-proposal (0.8.0; the user's answers of 2026-11-01 and 11-02).** (1) What may move: **not yet started**: unscheduled milestones and scheduled ones whose start is after today; in-progress and past ones are fixed. (2) **Duration from the estimate**: ceil(estimate / capacity share), share = capacity / WIP limit; greedy in the team's milestone order, after dependencies, within capacity and WIP, on the holiday calendar. (3) **One team per run**, by the team's manager or ADMIN from the team page;
  other teams' dates are fixed constraints.
- **Its six questions (0.8.0).** Q1 **re-plan every not-started milestone from the earliest possible day, pulling earlier**. Q2 **a link into another team's fixed milestone is placed anyway** and shown red "would be violated", never reordered. Q3 **days with no capacity period, or on hold, are not usable**; a team with none gets "add a capacity period first". Q4 **a milestone changed since the proposal is skipped, the rest are written**.
  Q5 **a 0 MD checkpoint takes one working day after its dependencies and counts toward WIP that day**. Q6 **the target window is a target, not a constraint**. The algorithm: `scheduling.md` "The auto-proposal".
- **Pin (1.7.0; "all recommended", 2026-11-09).** The pin is **stored** (V25 `milestones.pinned`; a pin needs dates), not per run, so every reader of the plan sees it. The proposal treats a pinned milestone as **fixed**: its dates stand, its load is booked, its dates bound its successors. The pin is **advice to the planner, not a lock**: a drag or the schedule dialog still moves it and the pin stays; **an unschedule clears it**; the batch accept writes what it is told.
  Who may pin is **who may set the dates** (the team's manager or ADMIN, `can.schedule`); the project owner may not. Details: `planning-model.md` "Milestones".
- **Cross-team run (1.8.0; the 1.7 plan's Q9a-Q13a of 2026-11-09 and the 1.8 plan's Q1a).** (1) The run places the chosen teams **in dependency order**, **each by today's per-team kernel with the teams placed so far as fixed facts**, repeated until a pass changes no back edge's source or `MAX_CROSS_TEAM_PASSES` = 5; the answer says `passes` and `settled`. (2) A **pinned milestone is fixed everywhere**. (3) **Every team of the run must be the caller's**:
  ADMIN, or the ACTIVE manager of EVERY listed team (a missing or deleted team is a 404 for everyone, then the first failing guard is the 403).
- **Its accept and check (1.8.0).** (4) **One accept across teams**: ONE plan write, ONE revision bump, a whole-batch 403/409 first, then the per-item rules (GONE, NOT_ON_TEAM, NO_WORKING_DAY, STALE). (5) The run's **`scopeHash` is over the team SET** ("foreign" means outside the run set): a colleague's drag of a ticked item skips that item, a drag of an unticked milestone of any run team refuses the accept (`stale-scope`; the page re-proposes at once and keeps the ticks).
  (6) **The check** (`POST /schedule-proposals/check`) answers "what if only THESE moves were accepted": ONE plan-scoped check, called by BOTH pages (the per-team path could not judge a cross-team link against the other sections' ticks); the client never recomputes a verdict. (7) A proposal stores nothing and a run is page state until it is saved (1.26: a saved run is every signed-in user's to read, "v1.26.0"). Details: `scheduling.md` "The cross-team run".

### Dependencies, calendar and critical path

- **Dependencies.** milestone↔milestone (cross-project), milestone↔project, project↔project. Types FS/SS/FF/SF plus a lag. Violations **warn only** (a red link and a conflict list), never cascade-move anything.
- **Dependencies as built (0.4.0; defaults the user confirmed on 2026-11-01).** (1) Who may link: the **successor's** project chain or ADMIN (the predecessor's owner sees the arrow and its warning but cannot remove it). (2) The lag is an integer of **working days, negative allowed (a lead), |lag| ≤ 365**. (3) An **unscheduled end is not evaluated**: status UNSCHEDULED, no warning, no arrow, "Not scheduled yet" in the table.
  (4) A link is created **on the successor's project page** (`POST /projects/{id}/dependencies`; the predecessor is a free search). (5) The project's **summary row** shows only while the project itself is an endpoint. (6) **At most one active link per unordered pair** of ends (a reverse pair answers the same 409 "already linked"); the type and lag are edited in place, the ends never: pointing a link at another end = delete + add. The start-to-finish rule is `W(A.effStart) − 1 + lag`.
- **Calendar and critical path (0.7.0; the user's answers of 2026-11-01).** (1) **One global holiday list**, curated by ADMIN, for every team: entered by hand plus an "Add Polish public holidays for <year>" preset (idempotent; the table starts empty). (2) **Monday–Friday, fixed**; a holiday inside a milestone never moves its dates: its estimate spreads over the remaining working days, and load, capacity proration, WIP, dependency checks and lags count the calendar's working days.
  (3) The critical path is **per project, on the planned dates, over the WHOLE chain** (the user overturned the one-hop recommendation): the chain of zero-slack milestones and links through every project it passes; nothing moves. (4) **Slack** per milestone: the working days it could slip before this project's end moves. (5) A toolbar toggle, off by default, remembered in the browser; the highlight is **monochrome emphasis**, no new hue. (6) **Idle gaps**:
  3 or more working days with nothing in progress, hatched bands plus a table, on the project and team pages.
- **Rulings with them (0.7.0).** A holiday write bumps the plan revision; the schedule PUT's "at least one working day" counts holidays, but a milestone that later loses its last working day to a new holiday keeps its dates (flagged `NO_WORKING_DAY` since 1.10); a holiday week's capacity divisor stays **5**; violated links are excluded from driving and slack; the page shows direct neighbours as ghost rows and farther members in a "Critical chain" list. Details:
  `planning-model.md` "The calendar", "Idle gaps", "The critical path".
- **Critical path reach (1.7.0; "all recommended", 2026-11-09).** On the team page a milestone's slack is measured **toward its OWN project's end**, so the team page and the project page say the same, and a link is critical when it lies on the chain of a project one of the team's milestones belongs to. On the roadmap the chain is measured **toward a PICKED project** (`?criticalPath=<projectId>`), not toward the plan's end nor the union of every chain; the document is byte-identical without the parameter.
  The **per-link slack** (`actual - required`, working days; `-shortfallDays` when violated) is in.

### Capacity

- **Capacity.** A team has man-days per week with effective-from periods. A milestone's estimate is **spread evenly** over its working days; the weekly load is compared with capacity.
- **As built (0.5.0; the user's answers of 2026-11-01).** A period takes effect on **any date** (a weekend date applies from the next working day; the week it starts in counts each working day at the figure in force that day), carries an **optional WIP limit** (the most milestones in progress on one working day; parallel work is allowed, too much of it only warns) and is added, edited and deleted by the team's manager or ADMIN.
  The team page (`/teams/:id`) shows it as a sticky strip under the dates, orange badges on the facts line and a Weekly load table (the accessible surface); overload and WIP are orange warnings, nothing moves. **Override UI (Q8b):** the row menu (Move up / down / to top / to bottom) and a "Reset order" button are the deterministic path; the row handle's pointer drag followed in its own commit.
- Capacity from Flow (the import, the deviation) is under "The Flow sync".

### Ranking and the timelines

- **Ranking.** **One global project rank**. A team's milestone order follows it by default; the team may override locally (and reset).
- **Two ranks (0.5.0, V17; the user's confirmed reading "A", 2026-11-01).** The PROJECT rank is the top-down SUGGESTION of the order in which projects should be delivered; the MILESTONE order is the order of ACTUAL EXECUTION and is per TEAM (each team's manager orders their own team's milestones; a lower-ranked project's milestone may come before a higher-ranked project's). The project rank is only the DEFAULT of a team's order, used until the team overrides it and again after a Reset.
  **A manager's override is never reshuffled by a later project-rank change**: the stored positions are the team's own, and only milestones the team did not list (new, or moved onto the team) slot in after the listed ones, in project-rank order. The order is written wholesale (`PUT /teams/{id}/milestone-order`, `[]` = reset) against the team's OWN order revision, so only that team's order write stales a reorder.
- **Roadmap and programs timelines (0.6.0; the user's answers of 2026-11-01).** (1) The Roadmap is a **Timeline** (one row per project in rank order; rank by row drag and the row menu; unranked projects under an "Unranked" divider, a drag across it = Rank/Unrank). (2) A project row = its derived span bar over the **target window as a band**, no milestone segments.
  (3) `/programs` is a collapsible tree work stream → program → project, a program's bar its derived span, **no target window on programs**, a roll-up count of its projects' flags. (4) The **program pick** is a multi-select on both pages, default all, remembered in the browser (one key for both pages). (5) **Drift:** ending later than the target end = WARNING, a late start or finishing ahead = INFO.
- **Its flags, edits and zoom (0.6.0).** (6) **Rank inversion** = WARNING: A ranked above B, both with scheduled work on team T, B's work on T starting before A's, **raised for adjacent pairs per team** (the volume decision: 184 flags on the sample plan against 1,038 for all pairs), and an INFO for an adjacent pair that shares no team. (7) Flags show as a row icon (orange warning / grey info) and a collapsible panel; a click scrolls to the row.
  (8) The **target window by drag** (move/resize the band, draw across a row with none) and by the row menu's dialog / Clear as the keyboard path, on both pages, by ADMIN, an owner above the project or a `ROADMAP_EDITOR` (no new rights). (9) **Arrows:** direct project↔project links plus one rolled-up arrow per project pair for their milestone links (red when any is violated). (10) **Month / Quarter / Year** zoom on these two pages (no Week, default Quarter, no time-axis virtualisation).
  (11) Roadmap filters besides the pick: work stream, team, owner, flagged only. Nothing is stored for any of it: spans, drift and flags are derived at request time.

### Baselines

- **Baselines (0.9.0; the user's answers of 2026-11-02, all nine with the recommended option).** (Q1a) A baseline **captures** every active milestone (name, project, team, dates, estimate) and every active project (name, program, work stream, target window, rank position, derived span); holidays and team orders are not copied (nor, before 1.26, links and capacity periods). (Q2a) **ADMIN or a `ROADMAP_EDITOR`** takes, renames and deletes; reads are every authenticated user's. (Q3a) **Plan-wide only**:
  one object at one plan revision, which every page filters to its own rows. (Q4a) It shows **everywhere, two ways**: a thin gray shadow bar under the current bar on all four timelines, a Movement table on the project and team pages ("Changed only" on by default), and a plan-wide comparison page per baseline (`/baselines/:id`).
- **Baselines, continued (0.9.0).** (Q5a) **No baseline by default**: a Baseline picker on the toolbar lists them newest first (the newest marked "latest"), one pick remembered in the browser for every timeline page. (Q6a) Movement is **working days, start AND end, on the current calendar**; a later end is an orange "Later" badge, an earlier one gray. (Q7a) **Rows for everything**: an added milestone keeps its bar and reads "new since the baseline";
  a removed or unscheduled one gets a dimmed appended row with only its shadow bar (on the team page also "moved to {team}"). (Q8a) **A cap of 100 active baselines** (a `409` at the cap; delete makes room; a delete is a soft delete). (Q9a) A **change to the team's plan since a proposal** writes nothing and the page proposes again at once, keeping the ticks for the milestones that still move (the per-milestone STALE rule stays). Details: `planning-model.md` "Baselines", `timeline.md` "The baseline overlay".
- **Two baselines compared (1.7.0; "all recommended", 2026-11-09).** (Q7a) The SAME comparison document and page, `GET /views/baseline/{id}?against=N` (the path id is "then", `against` is "now", any order, `against == id` is a `400`), with a "Compare against" picker (the live plan, or any other baseline, newest first with their plan revisions); the "Show on timeline" overlay stays one baseline against the live plan.
  (Q8) The **rank movement** against a baseline shows on the roadmap's rank cell ("5 (was 3)") and totals line and on the comparison page's project row ("rank 3 → 5").
- **Links and capacity (1.26; the user's Q3 b, 2026-11-23).** A baseline also freezes every active link and every active capacity period (not holidays, not team orders); the comparison page lists the changed links and the capacity ranges that differ, the team page shows the capacity as it was, the project page marks a link "New since the baseline". An older baseline reads "not captured", not "no changes".

### The Jira sync

Later answers on this topic: Release history 1.2.0, 1.3.0, 1.12.0, 1.13.0 to 1.13.2, 1.14.0, 1.15.0.

- **Decided 2026-11-06** (nine questions, all answered with the recommended option; the six decisions are the user's own). (1) Work streams are categories and never live in Jira (nothing maps, binds or imports one). (2) Programs, projects and milestones each map to ONE configurable Jira hierarchy level per connection (milestone = Epic by default; the mapping names the integer `hierarchyLevel`, not a type list).
  (3) Bindings are 1:1 per node and per Jira item, and the plan can later be IMPORTED from Jira (preview, then apply; never overwriting). (4) The field mappings are configurable and the defaults come from Jira Plans ("Target start"/"Target end", then "Start date"/`duedate`). (5) Everything is proven against a stub first, so the first real test is cheap. (6) From Flow, capacity and team membership "for now".
- **The cut and the rules (same answers).** 1.1 connection + mapping + manual bindings + Refresh + Deviations, 1.2 import, 1.3 polling/acknowledge/markers, 1.4 coverage, 1.5 Flow. **Estimates convert only with a declared unit or factor** (otherwise the Jira figure is only shown). **Linking** is the node's owner chain or ADMIN. **Import** is ADMIN or an owner of every target, dates copied only where the caller may schedule; re-import never overwrites; orphans go under a default parent, else are skipped;
  a milestone's team on import is a name match, else the default team, else skipped. The sync **detects**; deviations warn only and nothing is written to Jira.
- **Kept by the user on 2026-11-07 (the overnight defaults).** One link per site across connections (D1); deleting a connection unlinks its bindings (D2); discovery stored even if other probes fail (D3); the empty-sweep default (an empty listing of a non-empty bound set flags the bound items gone with a WARN; the next good run clears them); a disabled connection's bindings stay visible.
- **Coverage (1.4; decided 2026-11-07, all six answered with the recommended option).** The run observes the census into a mirror and the views read only the database (Q1a). Coverage surfaces as three deviation KINDS on the parent's binding, not a page of its own (Q2a). The child level is re-listed once a day by an id sweep and in full on every full read (Q3a). `UNLINKED_IN_JIRA` is a warning, `UNLINKED_IN_PLAN` and `CHILDREN_DONE` infos (Q4a). The roll-up is compact dimmed text after the Jira key (Q5a).
  The `jira-test` bucket became configurable instead of spending the tenth call (Q6a).
- **Coverage, the rest (1.4; the same answers).** Done Jira children are not "unlinked"; "linked" is an active binding on the same site (D1); program coverage shows on the Deviations page only; a disabled connection's link carries no roll-up and raises no flag; a binding that gains a new kind reopens only that line, the others keep their acknowledgement.
- **The four overnight items of 1.10 (confirmed 2026-11-10: "defaults confirmed, all recommended").** (1) **Holiday-only milestone flag** `NO_WORKING_DAY`, WARNING: a scheduled milestone covering no working day loads nothing and is a zero-length point in the dependency check, so the planner has to move it; raised on milestone rows of the project and team views only (no roll-up on the roadmap or programs, no weeks-strip mark, the bar unchanged), computed from the view's own calendar, nothing stored;
  the sentence is "Covers no working day: only weekends or holidays".
- **The four items, continued.** (2) **Removed projects on the roadmap and programs overlays.** On the roadmap they are appended after every current row: rank cell "-", dimmed "(removed)", the frozen span as the shadow bar, no flags, no menu; they honour the work-stream filter and the program pick and are hidden while a team or owner filter is active. On programs a removed row sits under its live, shown, expanded program (a gone, hidden or collapsed program draws nothing; the totals line counts it);
  a removed project with no frozen span gets no row.
- **The four items, continued.** (3) **Import from Jira on the Plan page** (supersedes the 1.2 decision B): "Import from Jira..." on the work-stream row's menu, gated on the stream's `can.edit`, the server staying the authority; the offered connections are enabled with the mapping OK, one preselected, several picked in the scope step, none an inline note; the work stream is preset and read-only.
  (4) **`DELETED` vs `OUT_OF_SCOPE`** by a per-issue probe of the bindings a run flags gone (at most 100 a run, `GET /issue/{id}?fields=id` through the run's guarded client; 404 `DELETED`, 403 `FORBIDDEN`, 200 `OUT_OF_SCOPE`, any other failure a WARN that never fails the run), no new audit event; the phrase widened to "Deleted in Jira (or no longer visible to the connection's account)".
- **Superseded in 1.10 (the user's clause is replaced, not kept).** Two clauses of (4), "rows flagged by earlier versions stay `OUT_OF_SCOPE` until seen again" and "any other failure leaves the row `OUT_OF_SCOPE`" (never retried), gave way to the promoted backlog item that a probe which did not answer is retried (V27 `gone_probed_at`, no backfill; so every row already gone gets its first probe in the first 1.10 run, up to 100 a run until drained).
- **The item-level acknowledgement summary is removed (decided 2026-11-15, the 1.24 checkup's Q5).** A Jira deviation item no longer carries `acknowledgement`; only its lines do. This is an accepted exception to API-VER-002 (a removed response member stays inside `/api/v1`) and to API-VER-004's headers: the member was `deprecated: true` with a migration note from 1.12 to 1.23, its one client is the first-party SPA, which has read only the lines since 1.12, and no `Deprecation`/`Sunset` header was ever sent. The 1.24.0 changelog names the removal.

### The Flow sync

Later answers on this topic: Release history 1.6.0, 1.9.0, 1.10.0, 1.11.0 (withdraw all), 1.23.0.

- **Decided 2026-11-08** (the user answered "all recommended"). (Q1a) The transport is an **operator allow-list** (`FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE`, the production path for a TLS Flow behind a private CA) plus a **development-only plain-http allowance** (`FLOW_INSECURE_ORIGINS`: the stub and a Flow on OrbStack); a connection's base URL must be one of the listed origins, so an admin can never widen the list.
  (Q2a) **Every authenticated user sees a team's Flow roster** (display names and dates; account ids never leave the server). (Q3a) **The team's manager or ADMIN links a team to its Flow team** (ADMIN alone gets "Link all suggested").
- **Same decision, continued.** (Q4a) **`mdPerWeek = round2(5 x sprint man-days / working days)`** on Astrolabe's calendar, one capacity period per sprint, so the weekly capacity adds up to what Flow says; Flow-sourced periods are owned by the import (updated on re-import, offered for removal when their sprint is gone or re-dated); **hand-entered periods are never changed or deleted**.
  (Q5a) The **capacity deviation** (1.6.0) warns when the plan has more capacity than Flow (a gap of 0.5 man-days or more), is info when it has less, and flags a Flow team that left the document; per current or future sprint over the days the sprint holds (the import's own windows and figures, both sides rounded to two decimals), `CAPACITY_MISSING` per sprint, `LONG_WINDOW` and skipped sprints silent. (Q6a) 1.5.0 = connection + stub + run/mirror + binding by name + roster + capacity import;
  1.6.0 = the capacity deviation. (Q7a) A Flow connection polls **every 60 minutes** by default.
- **Acknowledge and the flag (1.9.0; the user's answers of 2026-11-10, the 1.9 plan's Q1-Q4, as Q8a-Q11a).** The capacity deviation is acknowledged **per sprint** by the team's manager or ADMIN; a closing sprint reopens nothing, a new sprint arrives open. The team view carries a header flag and a weeks-strip marker over the OPEN rows only: acknowledged rows do not flag (they stay listed under the Status filter).
  Roadmap and programs carried none until 1.23 (a per-team flag on project rows, "v1.23.0 — what shipped"). Nothing is ever written to Flow.
- **The project rows' flag (decided 2026-11-15, 1.23 Q2 a; reverses 1.9 "team view only" in part).** A project row of the Roadmap and Programs carries ONE Flow capacity flag per team, only when a scheduled milestone of the project on that team lies in days an OPEN capacity difference covers; a WARNING when the plan holds more capacity than Flow, an INFO otherwise. Acknowledged differences, a disabled connection, a gone Flow team and unscheduled milestones raise nothing.

### Home and the lists

The standing rules the pages after 1.16 follow; the answers with their rejected alternatives are in "Release history" 1.17.0 to 1.23.0.

- **Home.** The Plan and Roadmap cards show the plan's own figures, including two capacity figures (teams with an overloaded week, teams over the WIP limit; the one answer off the recommended option, 1.18 Q1 b). "Yours" is what the person linked to the login owns and the teams that person manages;
  since 1.23 (Q3 b) it lists everything under a work stream or program you own, each row names its owner, and a switch "Only what I own myself" (off by default, remembered in this browser) narrows both tables to the rows you own yourself. A login without a person gets one plain sentence. Home's figures are links to the filtered view behind them; a badge or link shows only when its count is positive (zero is not a claim).
- **Filters live in the address.** The address always holds the filters shown; a link naming a filter is shown as written and not remembered; opening a page from the menu restores what the user last set; only the user's own change is remembered (Roadmap 1.19 Q1 a, Programs 1.21 Q1; Milestones, Team load and Dependencies keep theirs in the address only).
- **One staleness rule.** A Jira source is stale when its server-derived state is not `CURRENT` or its mapping does not fit; the chips, the Deviations banner, the dated "no deviations" claim, Flow's section and the plan pages' facts line ("Jira data may be out of date") all use it (1.17 Q1 and Q2).
- **A deploy notice.** The build writes its commit into `index.html`; the shell compares it with the bundle's own and shows a notice with a Reload button at the top of every page, with no way to dismiss it (1.17 Q4, Q5).
- **Dependencies page.** One list of every active link, the violated first, at most 1,000 rows, filters in the browser and the address (1.20 Q1); a row says what the caller may do (`can`) and offers "Edit..." and "Delete" only then (1.22 Q3, reversing 1.20 Q2 "read-only").
- **Team load.** Per week, "Weeks with a warning" under the table (1.21 Q4); it opens on the weeks from this week on and an "Include past weeks" switch (`?past=true`) brings the earlier ones back (1.22 Q4).
- **View validators.** Ten view reads answer a weak `ETag` and `304`; the tag is a hash of the rendered document and the caller's user id, so it cannot go stale; the two Deviations documents are left out (1.22 Q1, Q2).
- **A database time limit.** One statement limit of 15 seconds on the whole pool, 0 = off (1.23 Q1 a). **Flow capacity on project rows.** One flag per team, only when a SCHEDULED milestone of the project on that team lies in days an OPEN capacity difference covers (1.23 Q2 a; reverses 1.9 Q3 "team view only" in part).

### Releases

- A release is cut only on the user's word; the bump rules are `app-releases.md`. ONE changelog entry covers everything since the last release.
- **The caveat sentence.** A Jira-touching release keeps the repo's binding sentence ("Proven against a built-in Jira stub; not yet tested against a real Jira site."); the Flow line says the same of the built-in Flow stub. Both stub sentences stay in the changelog. 1.14.0 was released without the real-site check of `parent in (...)` on the user's word.
- **When the user is absent** (1.16, 1.20, 1.21 were built overnight): every question of the plan is answered with the recommended option (a), listed in the version's history for review; the user confirms or reverses afterwards.

## Assumptions (not asked — change on request)

Taken without a question, each a one-place change. Day-precision dates; Monday–Friday working days, fixed, minus the public-holiday dictionary (0.7.0); week / month / quarter zoom (month / quarter / year on the roadmap and programs pages); EN and PL kept; the scale above. The defaults of 1.10.1 and later are in "Release history", under their version.

### Defaults taken for v0.8.0

- A scheduled milestone the proposal cannot place keeps its stored dates and its load (listed as unplaced; the run repeats to a fixed point, so accepting never overloads a week through it).
- Capacity is checked per ISO week as well as per day. No toast on accept: the outcome note under the table carries the message ("3 scheduled", "2 scheduled · 1 skipped: rescheduled in the meantime").
- The proposal's link check shows the plan after ALL moves (the 1.8 check answers the ticked subset). Each run reaches its own fixed point; other teams' dates are constraints, so a later run after another team accepted may move milestones again.
- v0.8 saw only writes to the milestones IN the batch; the v0.9 scope check closed that (the user's Q9a: a `scopeHash` plus a `schedule_revision` sweep, `409 stale-scope`, nothing written, the page proposes again and keeps the ticks; the per-item `STALE` rule stays).
- Size budget: <= 150 KB uncompressed for the largest team (v0.8 raised it to 250 KB; back to 150 KB after v0.9 slimmed `dependencies[]` to the links violated before or after the moves).

### Defaults taken for v0.9.0

- The gated sizes follow the measured responses, which are gzip-compressed on the wire: the team view with the overlay <= 260 KB and the comparison <= 340 KB uncompressed (slimming is the `BACKLOG.md` item "Slim the baseline overlays").
- `createdBy` names the person: the creating login's linked active person's name, else the login's display name, never the email.
- The stale-scope check compares a fingerprint of the team's planning inputs (its milestone set and estimates, order, capacity periods, the links touching it with the foreign ends' spans, the holidays); the team's own milestone dates are covered by the per-milestone revision checks, so a colleague's drag of one batch item skips that item instead of refusing the whole batch.
- A pick of a deleted baseline clears itself (`400 unknown-baseline` drops the remembered pick); "Show without a baseline" appears when a view fails while a pick is set, so a broken overlay never locks the page out; the picker is disabled while a write is in flight.
- "Changed only" counts an estimate-only change (status "Re-estimated"); the comparison page's "Changed projects only" is on by default; an undated frozen milestone gets no appended timeline row (the Movement table lists it).
- Baselines are soft-deleted only and their rows are frozen at the database, so nothing purges them; a purge needs its own migration.

### Defaults taken for v1.5.0

- A per-connection IANA time zone, pre-filled Europe/Warsaw (Flow's own default), turns Flow's instants into dates. The mirror is replaced wholesale per run, `gone` is derived at read time, Test connection writes no mirror; `flow-test` is its own per-IP bucket (10 a minute); the bind, preview and apply call Flow never.
- A sprint without dates or capacity is skipped; a later sprint takes the days no earlier sprint holds and only a sprint wholly inside another is skipped (1.5.1: Flow's own rule); a gap keeps the previous sprint's figure in force; closed sprints are listed but never ticked; the WIP limit of an updated period is kept. A manual edit of a Flow-sourced period makes it manual.

### Defaults taken for v1.7.0

- **A team change KEEPS the pin** (confirmed 2026-11-09: "yes, stays pinned"): the dates carry over to the new team and so does the pin; its manager inherits it. Confirmed 2026-11-10: `ScheduleProposal.pinned` lists the pinned milestones that start after `asOf` (an in-progress pinned one is fixed regardless and not listed); `milestone.unpinned` carries a `reason` (`REQUESTED`, `UNSCHEDULED`); the team page's writes adopt the answered revision only in the cache entry they were made on.
- ONE remembered toggle `timeline.criticalPath` for the project and team pages; the roadmap's target is page state, not remembered. An unknown `criticalPath` id is a plain `400`, an unknown `against` id is the overlay's typed `unknown-baseline` `400`.
- `slackDays` on a VIOLATED link is `-shortfallDays`, null while unscheduled. The pin route answers `{revision}` and takes no `expectedRevision`; a no-op bumps the revision and audits nothing; pinning an unscheduled milestone is a `409`. The rank movement shows on the roadmap and the comparison page, not on the programs page.

### Defaults taken for v1.8.0

- `teamIds` rides the accept body and `scopeHash` is REQUIRED on it; `teams[]` is in PLACEMENT order. `settled` = after the last pass no team changed in it is the source of a back edge.
- The cycle break and the ready-node pick use ONE comparator (most movable milestones, then the name case-insensitively, then the id), and the cycle pick is restricted to the teams of a source component (a team merely downstream of a cycle is never placed before it).
- The run-level hash also covers the run teams' case-insensitive names (a rename of a run team refuses the accept); the per-team endpoints keep "outside this team", so the two hashes refuse each other by design. The check carries no `asOf`, answers `weeks` too and takes a narrower `CheckInputs`.
- The page learns its teams from `GET /schedule-proposals/teams` (ADMIN: every active team; otherwise the teams `canSchedule` allows).
- **The check is sent only while some but not all moves are ticked**; with none ticked the page shows the stored plan's standing violations and the current load, with all ticked it sends nothing.
- A GONE or NOT_ON_TEAM item appears in no team's `team.schedule_batch_applied` line; an item-less run team gets a zero line; `runTeamIds` is the one additive field. The 404 for a missing run team names the ids ("Team not found: 7, 9"); the 403 keeps the single guard's words. The size gate is <= 600,000 bytes for a 15-team run (`CrossTeamProposalSizeTest`).

### Defaults taken for v1.9.0

All confirmed by the user on 2026-11-10 ("defaults confirmed, all recommended"); D1, D3 and D6 were taken overnight.
- (D1) **`TEAM_GONE` is acknowledgeable as the team's own row** (`sprintId: null`; the DELETE names it by omitting `sprintId`). (D2) Hard rows: an un-acknowledge deletes, a re-acknowledge rewrites the stamp (1.10 added pruning).
- (D3) **The fingerprint hashes `{kind, severity, detail minus sprintName}`**: any change of a sprint's dates, held days, working days, either figure, the gap or the severity reopens it; **a rename in Flow does not**.
- (D4) The write is the Jira acknowledge's protocol with the import's guard; `409 urn:astrolabe:problem:stale-deviations` is the ONE URN of both connectors. (D5) The listing is the Jira view's: OPEN rows by default, `acknowledged=true|false`, `all=true` or `teamId` also lists acknowledged rows; a team with an OPEN WARNING sorts first.
- (D6) **ONE header flag, `FLOW_CAPACITY`, at the WORST severity of the open rows** (`count` = the open rows; a no-capacity sprint counts as info; a gone team as a warning with no days); the weeks strip marks a week with the worst severity of the open rows whose held days meet it.
- (D7) A DISABLED connection raises no team flag while its rows list and can be acknowledged. (D9) `can.acknowledge` is ADMIN or the team's active manager. (D10) Audit events `flow.capacity_deviation_acknowledged` and `…_unacknowledged`. (D11) One `CapacityAckCell` on both surfaces; the Deviations page's ONE Status select applies to both lists. (D12) An acknowledge refreshes the deviations and the plan views. (D13) `sprintId` is REQUIRED (nullable) in the POST body, optional in the DELETE query.
  (D14) Both items ship in ONE release.
- *Decided while building:* a gone team's acknowledgement does not outlive its absence; the header sentence counts "open differences", not sprints; acknowledged rows' badges are dimmed; a proposal preview's strip shows no Flow marks; the team page's Capacity vs Flow fact counts OPEN rows ("No open difference · N acknowledged", never "In line with Flow", while acknowledged rows remain).

### Defaults taken for v1.10.0

No question round; the user said "go-go".
- *Jira probe marker.* (D1) A nullable column `jira_observations.gone_probed_at` (V27), not an `UNKNOWN` reason: no enum, spec or UI vocabulary change; NULL = Jira has not answered yet for this vanish. (D2) "Answered" = 200, 404 or 403; a failure, a cut and an over-cap binding stay NULL and are retried by every later run while the sweep still judges the binding gone; at most 100 a run, **the newly flagged first, then the retries, each by binding id**. (D3) No backfill:
  a row flagged gone before 1.10 gets its first probe in the first 1.10 run (supersedes the clause the user confirmed earlier). (D4) An answer is final for that vanish; a clear and a new vanish probe afresh; the column is in no API.
- *Acknowledgement lifetime.* (D5) **An acknowledgement lives only while its row is listed**: deleted when the sprint is in line, closed, skipped or no longer in Flow's document, when the team is back (the `TEAM_GONE` row), when the binding is unlinked or its team deleted, and with its connection; a stale acknowledgement (its row still listed) stays.
- (D6) The prune runs at the run's mirror replace (in the replace's transaction), at the acknowledge write (that binding, under its lock) and at the connection delete; the acknowledge's own prune never judges "gone from the document" (the stored document's truncation is not recorded). Residual: a sprint brought in line and back to the same figures by plan-side edits alone, with no run and no acknowledge between, still reads acknowledged.
- (D7) A team ABSENT from Flow's document keeps its sprint acknowledgements; **a document with `sprintsTruncated` judges no sprint key**; a COMPLETE document listing a team with zero sprints clears that team's sprint rows. (D8) Every write of a binding's acknowledgement rows holds that binding's row lock (`FOR NO KEY UPDATE`, id order, after the connection row). (D9) Audit `flow.capacity_acknowledgements_cleared` and `acknowledgementsDeleted` on `flow.connection_deleted`.
- *Acknowledge all.* (D10) `POST /integrations/flow/team-bindings/{id}/acknowledge-all` takes `{items[1..2,000] of {sprintId, fingerprint}}` and is **all or nothing**: any named row that is not listed now or has another fingerprint is the shared `409 stale-deviations` (its text names the first offending row); a key named twice is a `400`. (D12) "Acknowledge all (N)" heads a team's list on BOTH surfaces, shown when the caller may acknowledge and at least two listed rows are open; the page's filters apply.
- *Home.* (D13) An intro line and three cards, Plan, Roadmap, Deviations, each with a real link. (D14) The only live figures are the OPEN deviation counts: "Open differences from Jira:" and "Open capacity differences from Flow:" (PL "Otwarte różnice względem Jiry:" / "Otwarte różnice przepustowości względem Flow:"); positive counts only; `staleTime` 60 s; a failed read is the inline `ErrorAlert` inside the Deviations card; no new endpoint.
- *Outbound and release.* (D15) The whole `::/96` is refused for every genuine host through one helper both address predicates call (the SIIT form followed in 1.10.1). (D16) 1.10.0 is a minor bump with ONE changelog entry; the Jira caveat keeps the repo's binding sentence.

## Donors

Astrolabe's repository started as an exact copy (git archive) of Flow @ `e9c3b726` (`~/Sources/flow`, Flow 1.35.0), trimmed. Flow itself was copied from Covenant and trimmed; Lettuce and Toadie came in indirectly through it. **Port, don't reinvent**: when Astrolabe needs a capability a sibling repo already has, port its implementation.

- **Flow** (`~/Sources/flow`, the primary donor): the whole foundation: stack, API design, UI/UX, testing, gates, versioning, deployment, the telemetry panel.
- **Covenant** (`~/Sources/covenant`): the scaffold Flow was cut from; its `toadie/` connector is the template for an external-API connector (encrypted config, scoped read-only credentials, bounded reads).
- **Lettuce** (`~/Sources/lettuce`): `infra/mail`, `infra/crypto`, `infra/paging`, the connection pool, the WireMock stub pattern (stub port 8096 here).
- **Toadie** (`~/Sources/toadie`): the `UrlFetch` SSRF guard, the password-reset-by-link design.

What was ported later, and what was left in Flow on purpose:

| What | Where in Flow | Landed as |
|---|---|---|
| Transport, Jira client slice, encrypted-at-rest registry, WireMock stub (1.1) | `fetch/`, `jira/JiraClient.kt`/`JiraHttp.kt`/`JiraJql.kt`/`JiraTime.kt`, `EncryptedAtRest`/`Reencrypt`, `JiraStubServer.kt`, Lettuce's stub pattern | `infra/fetch/`, `jira/`, `infra/crypto/`, the stub on port 8096 |
| Public holidays and the working calendar (0.7) | `metrics/PublicHoliday*`, `WorkingCalendar.kt`, `WorkingDayIndex.kt` | `planning/PublicHoliday*.kt`, `infra/time/WorkingCalendar.kt` (replaced the Monday–Friday `WorkingDays.kt` of 0.4; Flow's V25 seed is not ported, the Polish preset is the path) |
| Timeline prior art (0.3) | `DeepDiveMatrix.tsx`, `utils/deepDiveCalendar.ts`, `hooks/useRovingGrid.ts` | the `Timeline*` components, `utils/timelineScale.ts`, `useRovingGrid` (`timeline.md`) |
| Pure-kernel idiom (0.5) | `CapacityKernels.kt` | the capacity and load kernels (`LoadKernels`, `planning/`) |
| Preview-then-apply batch (0.8) | `TeamMembershipSeed*.kt`, `JiraSeedModal.tsx` | the batch accept's `{accepted, skipped}` with a per-item reason and the table of ticked rows (Flow's scheduler loop followed in 1.3) |
| Fork balancing (after 1.4.0) | `balancedCandidateOrder`, `server/test-weights.tsv`, `local-times.mjs test-weights` | `server/build.gradle.kts` + `server/test-weights.tsv` (`test-fixtures.md` "Fork balancing"; figures in `build-times.md`) |
| Ingestion framework, streams, raw store, role switch: deliberately NOT ported | `ingest/` (worker, leases, streams), `plugins/Role.kt` | one process; `sync/` is the run registry cut to what two connectors need (the claim is a partial unique index; the 1.3 scheduler ports only the loop shape of Flow's `IngestWorker` tick, its `backoffMillis` and its five states, not the leases, heartbeats or stored `next_sync_at`) |


## Release history

Newest first. Each version: its scope, the user's answers, the defaults that still bind and what was not built; the commits, the plans (they live outside the repository) and the test runs are in git. "No migration" means the preceding schema still applies. Every release leaves "nothing is written to Jira or Flow" true.

### v1.26.0 — saved proposals, frozen links and capacity

Built 2026-11-23 to 11-24, **not yet released** (the release commit flips this section to "what shipped"); a minor bump, the API only gains members. It carries the 1.25 review's fixes too.

**Scope:**
- **Saved proposals (V32).** A cross-team run is saved explicitly (a name, at least one move ticked), listed on `/schedule-proposals` and opened at `/schedule-proposals/saved/:id`. The server stores its own re-computation, never a client's document; the state is derived at read: CURRENT, CHANGED (the plan moved, or a team is gone) or UNREADABLE (another stored format).
- **Baselines freeze links and capacity (V33).** Sections on the comparison page, counts on `/baselines`, the team's capacity "as it was", a link "New since the baseline" on the project page; older baselines read "not captured".
- **Paged lists.** `GET /work-streams` and `GET /programs` (filter `name`; `workStreamId` on programs); the Jira bind dialog's program picker searches the server.
- **The cross-team run re-places only stale teams:** a team is placed again only when a team with a link into it changed (wire-identical).
- **Technical, no behaviour change:** every instruction doc under a byte ceiling, held by limit 9 of `scripts/check-docs-shape.mjs` (the new `scheduling.md` holds the auto-proposal and the cross-team run); nine main files split below 360 lines; the unit tests' sleeps cut, a guard each side. The CI budget re-baseline (G5) is its own commit.

**On the wire:**
- `GET`/`POST /saved-schedule-proposals` (`{items}`, newest first, at most 20, no documents), `GET`/`DELETE /saved-schedule-proposals/{id}`; audit `schedule_proposal.saved` and `.deleted`.
- `GET /work-streams`, `GET /programs` (`ProgramListItem` adds `workStreamName`).
- `dependencyCount` and `capacityPeriodCount` on `Baseline` (null = not captured); `links` and `capacity` on `GET /views/baseline/{id}` (also with `?against=`); `capacity {captured, periods}` in the team view's baseline overlay; `newSinceBaseline` on the project view's dependency rows; both counts on `baseline.created`.
- From the 1.25 review: `totals.pending` on `GET /views/capacity-deviations`, the `FLOW_CAPACITY_PENDING` flag, `flowPendingTeamIds`.

**Upgrade effect:** V32 and V33 are additive (a table, two frozen tables, two nullable count columns). A baseline taken before 1.26 has null counts and reads "not captured", never "no changes".

**The answers (the user's, 2026-11-23):**
- Q1 (a) every signed-in user may read a saved proposal. Q2 (a) the newest 20 are kept, the oldest dropped on the 21st save. Q3 (b) the wider option: the comparison page AND the team page's "was" capacity and the project page's "new since the baseline". Q4 (a) the bind dialog's program picker over `GET /programs`; work streams stay API-only.
- Q5 and Q6 were not asked; defaults: (a) the CI re-baseline runs last on the then-last ten green master runs, (a) the byte ceilings become limit 9.
- The 1.25 review's calls: an incomplete Flow sprint snapshot stays listed with a neutral marker on the Roadmap and the team page; a disabled connection's consequence is documented in `flow-sync.md`.

**Defaults taken for v1.26.0:**
- The list filter is `name` (the shared `NameQuery`).
- A save is not plan state: no plan lock, no revision bump. Any save removes the globally oldest saved row (Q2); the delete guard (ADMIN or the manager of every stored team) stops a targeted delete only. The save has its own bucket of 10 a minute per user.
- A saved run is acceptable only while CURRENT, with `can.accept` and `asOf` equal to today; "Propose again" shows with `can.delete`.
- The team overlay's "was" capacity is `baseline.capacity {captured, periods}` inside the existing overlay; `newSinceBaseline` is absent when links were not captured (unknown, not "all new").
- Links compare as added, removed or changed (type, lag); capacity as date ranges of the figure in force, so splitting a period in two equal ones is no change. Capacity is team data outside the plan revision: a capacity-only change leaves the comparison's `revision` equal, and the page's "plan has not changed" note says the capacity has.
- The e2e cross-team world gains a third team with its own single-team login.

### v1.25.1 — a new logo

Released on the user's word ("release 1.25.1", 2026-11-23), a patch: the logo and favicon redrawn (a mariner's astrolabe with a wind rose; the favicon a simplified version). Built outside the planned-release workflow (the brand-refresh branch); no migration, endpoint or wire change. Its version was already on `master` when the 1.25 review's fixes were made, so those ship as the next patch (`app-releases.md`: an entry is never reopened).

### v1.25.0 — reliability and navigation

The quality checkup adds V31 to track whether a Flow team's sprint snapshot is complete. Capacity import and comparisons wait for a complete refresh,
and a partial refresh preserves sprint acknowledgements. Project fields and target dates can be replaced together with `PUT /projects/{id}/details`.
Paged registry reads share a database snapshot, and successful creates return a projection taken within the write transaction.

The app shell groups work by task and Home separates plan figures, risks and actions. Very wide timelines window their date headers.

Built outside the planned-release workflow (PR #41) and released 2026-11-22, a minor bump; the questions put to the user were not recorded here.

**On the wire:** `PUT /projects/{id}/details` (the fields and the target window in one write); `truncated` on `GET /schedule-proposals/teams` (at most 1,000 teams, ordered by the accent-folded name); `sprintsComplete` on the capacity-import preview; `openapi: 3.0.3` published as is. **Upgrade effect:** V31 starts every mirrored Flow team incomplete, so its comparisons and capacity import wait for the next complete run of its connection.

### v1.24.0 — what shipped

A technical release, built 2026-11-15 and released on the user's word ("release 1.24", 2026-11-15), `1.24.0` (a minor bump: the API removes a member). No feature, migration (V30 stays the last), endpoint, audit event, Jira or Flow call, or dependency.

**Scope:** every large doc restructured to `## Rules` plus sections, with a guard (`scripts/check-docs-shape.mjs`) and the new `sync.md`; the spec's descriptions as contract, named enums, one `TeamRef`; refactors without a behaviour change; CI with two forks; Playwright only against a named stack.

**On the wire:**
- **API removal:** the items of `GET /views/deviations` no longer carry the deprecated item-level `acknowledgement` (Q5); each line's own, the filters, the counts and the acknowledge routes are unchanged.
- The other wire changes (three `409` problem types, the declared `SyncFailureCode` list) are in `authorization.md` and `sync.md`.

**The answers (the user's, 2026-11-15):**
- Q1 (a) reword the lines that quoted a real installation's figures; history and tags stay in Git.
- Q2 (b) restructure all nine large docs plus the guard; "Rules first".
- Q3 (a) two forks in CI, find why vitest is slow, then re-baseline.
- Q4 (a) no implicit `8086`: an explicit target.
- Q5 (a) remove the deprecated item-level `acknowledgement` now.
- Q6 all four refactors. "Build all of it."

**Defaults that still bind:**
- Docs: history is deleted, not archived (the guard's limits: `ci.md`); `README.md` and `BACKLOG.md` are outside the guard.
- Spec: a nullable enum used twice is a `Nullable<Name>` twin; `ProblemDetail.type` stays a string listing every slug; `SyncFailureCode` is declared in the spec only, so a stored code is never renamed or removed and a new one is a constant and an enum value in one commit.
- Code: a split keeps ONE public service; "shared" means identical after renaming the connector, never a registry or a `kind` switch.
- e2e: all four `E2E_*` URLs required, none defaulted; the flaky list never gates (`retries` stays 2).
- CI: budgets are re-baselined from the last ten green master runs; two forks stay only if the first five master runs are 20 % under the one-fork time; no vitest shard.
- A release that changes the API contract is at least a minor bump.

**History kept here:** the item-level summary was deprecated since 1.12 and read by no client; its removal is an accepted exception to API-VER-002 and API-VER-004 (The Jira sync, above), and the release's changelog (EN and PL) MUST name it.

**Not built:** the checkup's lower tiers, the schema twins, the spec items left alone, the flow-sync.md nits, the gate cells no test backs and the docs over their ceilings are each a `[new]` BACKLOG line marked (1.24); the CI budgets wait for ten green master runs on the final workflow.

### v1.23.0 — what shipped

Released on the user's word (2026-11-15), a minor bump (a new configuration key, a new flag kind, new members on Home's rows): a database time limit, the focus after "edit, then delete", the Flow capacity flag on the Roadmap and Programs, everything you manage on Home. The user picked five `BACKLOG.md` items and was PRESENT. No migration, new endpoint, write, audit event, rate bucket, Jira or Flow call, stub data or dependency. On the wire:
`POSTGRES_STATEMENT_TIMEOUT_SECONDS`, the problem type `urn:astrolabe:problem:database-timeout` on the existing `500`, the `FlagKind` value `FLOW_CAPACITY_MILESTONES`, and `ownerName` and `direct` on the program and project rows of `GET /views/home`.

**The answers:**
- Q1 (a) one statement limit of 15 seconds on the whole pool, 0 = off, covering the views and everything else (not (b) only the reads that change nothing, 10 s, at two extra round trips a read; not (c) no limit).
- Q2 (a) a project gets one flag per team, only when a SCHEDULED milestone of it on that team lies in days an OPEN capacity difference of that team covers, naming the team and the number of milestones, a warning when the plan holds more than Flow and an info otherwise (not (b) whatever the dates; not (c) one flag per project without the team). Reverses 1.9 Q3 ("team view only") in part.
- Q3 (b) "Yours" lists everything under a work stream or program you own, each row names its owner, and a switch "Only what I own myself" (off by default, remembered in this browser) narrows both tables to the rows you own yourself (not (c) a third table). Reverses 1.18 Q2a (direct ownership only) in part.

**What binds** is stated where it lives: the limit's mechanics and its typed `500` in `persistence.md`, `security.md` and `web-internals.md`; the flag's rules (counts like any flag; nothing for an acknowledged difference, a disabled connection, an unscheduled milestone or a gone Flow team) in `planning-model.md` and `timeline.md`; Home's owner-chain rows in `planning-model.md` "The home view".

**Defaults taken:** the 15 s value is whole seconds, 0..300, boot-validated (the test harness boots with 60 s); the two `sync` readers assign `queryTimeout` only when positive and the telemetry reads keep their own budgets; a cancelled request's EARLIER committed step stays (a create's re-read runs in a second transaction, so a cut re-read leaves the row and a retry may meet a `409`); a cancelled access-check read answers the typed `500`, never a `401`;
no new e2e for the focus rule (a Playwright walk cannot hit the render gap); days compare as calendar days, both ends inclusive; the Roadmap and Programs show the flag without a "Flow data may be out of date" note.

**Not built:** each a `[new]` `BACKLOG.md` line (Q1b, Q2b, Q2c, Q3c, and what a frozen database or the browser's own timeout would need).

### v1.22.0 — what shipped

Released on the user's word (2026-11-15), a minor bump (new headers, a new page action): view validators that cannot go stale, dependencies edited from their list, the team load from this week on. The user picked five `BACKLOG.md` items and was PRESENT; they answered Q1-Q4 with (a) and chose to BUILD the view ETags rather than only record the rule. No migration, endpoint, write, audit event, rate bucket or Jira/Flow call. `GET /views/dependencies` rows gain `can{edit, delete}`;
`GET /views/team-load` gains `currentWeekStart`; ten view GETs gained a request header, a response header and a `304`.

**The answers (all (a)):**
- Q1 the validator is a hash of the rendered document and the caller's user id, so it cannot go stale and needs no list of inputs; a `304` saves the transfer and its compression, NOT the view's work (not (b) Flow's data stamp read before the view, not (c) version counters and a V31).
- Q2 ten reads (Plan, Home, Team load, Dependencies, Roadmap, Programs, a project, a team, a baseline comparison, the Jira links), not the two Deviations documents (not (b) all thirteen by first making "next poll at" stable, not (c) only the five heaviest).
- Q3 each Dependencies row says what the caller may do (`can`), the project page's own flags (not (b) the right taken from the Plan document, not (c) the menu on every row).
- Q4 "Weeks with a warning" starts at the server's current week and an "Include past weeks" switch (`?past=true`) brings the earlier ones back (not (b) the weeks without capacity also listed as ranges, not (c) the page opening on every week).

**What binds** is stated where it lives: the validator, its order of evaluation and the SPA's memory in `security.md` "Caching", `planning-model.md` "View validators" and `web-internals.md`; the Dependencies page's `can` and its LEFT-joined chains in `planning-model.md` "The dependencies view"; Team load's weeks from this week on and the two focus rules in `web-internals.md`.

**Not built** (each a `[new]` `BACKLOG.md` line): the pre-check (Q1b, Q1c), validators for the two Deviations documents, a time zone for "this week" and the weeks without capacity as ranges (Q4b), adding a dependency from the list. **Recorded as risks:** the project page's possible focus race, the Dependencies page at its 1,000-row cap in a real browser.

### v1.21.0 — what shipped

Released on the user's word ("release 1.20 and 1.21", 2026-11-15), right after 1.20.0, a minor bump (new filters, a new table, a changed document): filters, Team load per week and a slimmer Dependencies document. The user picked five `BACKLOG.md` items ("1, 2, 4 on defaults; then 3 & 5") and went away, so **the user was ABSENT** and every question was answered with the recommended option (a), listed here for review. No new endpoint, parameter or migration;
`GET /views/team-load` gained `warningWeeks` per row and `warningWeeksTruncated` (additive); `GET /views/dependencies` names its ends once (breaking for the page only: the endpoint was unreleased).

**The answers taken (all (a)):**
- Q1 the Programs pick follows the Roadmap's 1.19 rule unchanged (not (b) the address alone, not (c) a link replacing the memory).
- Q2 a "Flag severity" select (Any / Warning / Info) and an "Unranked projects only" switch beside "Flagged projects only", in the address and remembered; Home's "N unranked" links to `?unranked=true` and the warnings and infos badges each open their own severity (not (b) one "Flags" select, not (c) the flag panel following the severity).
- Q3 a Project select fed by the plan document with the chip kept, and the Team select reading every team (100 a page, to the end), shared with the Deviations panel; an id the lists lack shows as "Team N" / "Project N" (not (b) search pickers, not (c) the select replacing the chip).
- Q4 a second table "Weeks with a warning" under the Team load table: one row per team and overloaded or over-WIP week with the team page's own cells, following the "Show" filter, at most 2,000 weeks in team order, oldest first (not (b) a disclosure per row, not (c) a heat map).
- Q5 the slimmer document built last (not (b) skipped, not (c) the check's null members dropped).

**Defaults taken:** `programId` written canonical (de-duplicated, ascending, at most 100) on both pages; `severity` and `unranked` as exact words only; the focus helper takes the menu it came from; `listEveryTeam` reads at most 20 pages; the Dependencies page resolves names in its query function, not in `select` (a throwing `select` looped in TanStack Query 5.105.3), so a document that names something it does not hold is a `MalformedAnswerError`, never retried.
**Not built:** the alternatives of Q2b to Q4c, each a `[new]` `BACKLOG.md` line; warning weeks from today and the focus after ranking the last unranked row were built in 1.22.

### v1.20.0 — what shipped

Released on the user's word ("release 1.20 and 1.21", 2026-11-15), a minor bump (a new page and a new read): Dependencies, plus seven small fixes. The user picked the theme and items 1-8 on 2026-11-14 ("yes, 1-8 on defaults overnight"), so **the user was ABSENT** and every question was answered with the recommended option (a), listed for review. One new read, `GET /views/dependencies`; no migration, write, audit event, rate bucket or Jira/Flow call.

**The answers taken (all (a)):**
- Q1 one list of every dependency, the ones that do not hold first, at most 1,000 rows with `truncated`, filtered by status, team and project in the browser, a page "Dependencies" under Planning (not (b) server-side filters, not (c) a paged list).
- Q2 read-only, each end names its project whose page edits the link (not (b) edit and delete in the list; 1.22 built that).
- Q3 "Dependencies" in the Roadmap's and Programs page's project row menus, "N dependencies" on the team page's facts line, the red conflicts badge opening the violated ones, no bar renamed (not (b) a per-milestone item and filter, not (c) counts in bars' accessible names).
- Q4 evidence first for the server gate beside the stack. Q5 the stricter axe sweep fixes a missing name or role and records (does not patch or waive) a contrast finding.

**What it delivers:** the page `/dependencies` (everyone): the violated first (largest shortfall first), then kept, then not scheduled yet; a cut list says so and never claims "nothing matches". Home's red "N violated dependencies" and the "Yours" conflicts badges open it narrowed (`plan.conflicts` and the list's `totals.violated` are one function).
The server gate runs beside the compose stack (`StubPortGuardTest` pins that the stubs take a free port). The Jira and Flow connection, mapping, run, team-link and refused-acknowledge writes mark Home stale; the login and password-reset pages run the deploy check. **Defaults taken:** a view, not a paged list (the order and the status are a kernel's result); a lean five-statement loader; filters only in the address; the Roadmap's item on every project row, with no count.
The `projectId` filter on `GET /milestones` already existed since 1.19 (the predecessor picker stays plan-wide on purpose). **Not built:** each a `[new]` `BACKLOG.md` line (the alternatives of Q1b to Q3c).

### v1.19.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump (two new pages, a new read, linked filters): Home's figures lead somewhere. The user picked five `BACKLOG.md` items and answered Q1 to Q4 with (a), **the user being present**. Three filters and two sorts on `GET /milestones`, one new read `GET /views/team-load`; no migration, write, audit event, rate bucket or Jira/Flow call.

**The answers (all (a)):**
- Q1 the Roadmap's filters live in the address by Flow's rule (see "Home and the lists").
- Q2 a **Milestones** page under Planning: every milestone with its project, team, estimate and dates, filtered by schedule (Not scheduled / Scheduled / All), team, project (a removable chip from a link) and name, the filters in the address only; `?scheduled=false` counts exactly Home's "not scheduled yet" set.
- Q3 a **Team load** page under Planning: every team with its manager, milestones, how many are not scheduled, its overloaded weeks, weeks over the WIP limit and weeks without capacity, filtered by warning in the address; its totals and Home's two team counts are one function over one loader; at most 200 rows with `truncated`.
- Q4 Home's read (`GET /views/home`) is kept for 60 seconds like the two deviation counts: a return within the minute makes no request, the user's own writes still show at once, another person's change or a Jira/Flow observation shows after at most a minute.

**Also:** the connection pool moved out of `Database.kt` into `ConnectionPool.kt` (a pure move). Home's figures became links ("Home and the lists"). **Defaults taken:** `GET /milestones` grows rather than a new list; both pages get a menu leaf; zero is not a claim;
a team with work and no capacity can never be overloaded, so Team load says so in gray. **Not built:** a rank sort on Milestones (`BACKLOG.md`); the violated-dependency list, the address filters and Team load per week came in 1.20 and 1.21.

### v1.18.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump (a new read and a rebuilt Home): the plan's figures and what is yours. The user picked the `BACKLOG.md` item "Home: figures of the plan and "my" items (1.10)" and answered Q1 to Q5, **the user being present**. **One new read, `GET /api/v1/views/home`** (any signed-in user; no parameter, write, migration, Jira/Flow call, audit event or rate bucket).

**The answers (2026-11-14):**
- Q1 **(b)** the plan figures plus the whole plan's capacity (teams with an overloaded week, teams over the WIP limit): the one answer off the recommended option, and it adds a team loop to every read.
- Q2 to Q5 **(a)**: "yours" is what the person linked to the login owns directly plus the teams that person manages (widened in 1.23 Q3); a managed team's row carries its capacity warnings, its Jira deviations and its Flow flag; a login without a person gets one plain sentence; worded lines and badges inside the three cards, with "Yours" as a section under them (not stat tiles, Q5b; not counts only, Q2c; not an attention-only view, Q1c; not "everything you may manage", Q2b).

**Defaults taken:** "me" is the ACTIVE person linked to the login, resolved inside the snapshot with the guards' own two lookups, **an administrator included** (the seed administrator has no person on a fresh stack); the plan block is the same for every caller; `plan.conflicts` counts every violated link once, **links inside one project included**; each of the four lists of `me` holds at most 100 rows with `truncated`, names case-insensitively, ranked projects first;
a failed first read is one inline alert in place of "Yours", a failed re-read keeps the figures. **Not built:** each a `[new]` `BACKLOG.md` line (the alternatives are in the answers above); a page for the overloaded teams, a URL for the Roadmap's filters and a list of every unscheduled milestone came in 1.19, "everything you may manage" in 1.23.

### v1.17.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump (a new menu item, a new notice and a changed warning rule): follow-ups. The user picked five `BACKLOG.md` items and answered Q1 to Q5 with (a), **the user being present this time**. **Web-only**: no server file, route, spec change or migration; the one write a new path leads into is the existing `PUT /milestones/{id}/schedule`.

**The answers (all (a)):**
- Q1 the server-derived state is the one staleness rule everywhere (`isStaleSource`: not `CURRENT`, or the mapping does not fit), and the banner keeps skipping a disabled connection while the chips count one; the Deviations banner now also shows under STALE, during a first run and during a retry after a failure, and the dated "no deviations" claim is withheld under STALE.
- Q2 one dimmed sentence "Jira data may be out of date" on the facts line of the Roadmap and Programs.
- Q3 "Schedule on Jira's dates" is one click on the dashed row's menu, through the page's one write path, only for a caller whose `can.schedule` allows it and never while a proposal previews.
- Q4 a notice at the top of every page with a Reload button, no way to dismiss it. Q5 the build writes its commit into `index.html` (`<meta name="astrolabe-build">`) and the shell compares it with the bundle's own. Also: the critical-path pick is announced once per target.

**Defaults taken:** the Deviations row's "· stale" mark keeps its own rule; the menu item shows on the dashed row and the baseline's "unscheduled since the baseline" row, left out when Jira's two dates are reversed, with no pre-check of working days; the deploy check re-reads `index.html` when the shell mounts, when the tab returns and every five minutes, never reloads by itself, compares for inequality (a rollback prompts too) and keeps its last answer when a re-check fails.
**The deploy check's limits:** it ships in 1.17's bundle, so a tab open across the 1.17 deploy needs one manual reload; a rebuilt image of the same commit goes unnoticed; a rolling deploy that serves two builds can prompt twice; an intermediary that caches `index.html` but not deep links could show a notice a reload does not clear.
**Not built** (each a `[new]` `BACKLOG.md` line): the alternatives Q3b (the Unscheduled list's row menu), Q3c (a prefilled Schedule dialog) and Q4b (a "Later" button), the plan pages' line narrowed to the projects on screen, the disabled connection that the banner and the chips treat differently, the dated claim blinking to "so far" during a routine refresh (a known limit).

### v1.16.0 — what shipped

Built overnight on 2026-11-14 (the user picked four `BACKLOG.md` items on 2026-11-13 for an unattended night) and released on the user's word the same morning, a minor bump (new timeline rows, chips and a programs-page feature). No migration, new Jira or Flow call, route, rate bucket or audit event. Delivers: an unscheduled milestone whose Jira item holds both dates gets a dashed, read-only timeline row on the project and team pages (or its Jira bar on the baseline's "unscheduled since the baseline" row);
the timeline views' `jiraSites[]` carry the connection's `state` and `mappingOk` and the project and team chips add "Jira data may be out of date" while a site behind them is not `CURRENT` or its mapping does not fit; a folded program or work stream on the programs page shows one rolled-up arrow per pair of shown rows (END to START, red when any folded link is violated); the programs page shows the critical path to a picked project (`GET /views/programs?criticalPath=N`).

**Q1 to Q5 were not put to the user before the night: the build ran on the recommended option of each** (Q1 the chip's rule is the server-derived site state, wider than the Deviations banner's, which 1.17 then unified; Q2 the qualifier shows at any count; Q3 every tray milestone with both Jira dates while "Jira dates" is on; Q4 a folded row stands for the chain project, nothing opens on its own; Q5 a rolled-up arrow counts every link, project-to-project ones included).
**Defaults taken:** one row per tray milestone, the baseline idiom exactly; the wire carries the state, not a verdict, through `planning`'s own `JiraSiteState` mirroring `sync`'s names (pinned by a test); a client-side fold of `links[]`, no `programLinks[]`; the target is page-local; a deleted or unknown target is the roadmap's plain `400`.
**Not built:** each a `[new]` `BACKLOG.md` line; scheduling a tray milestone from its Jira row came in 1.17 and a text equivalent of the arrows in 1.20.

### v1.15.0 — what shipped

More ways into the rooted import and a slimmer Jira payload (the user approved six `BACKLOG.md` items on 2026-11-13; built overnight, released on the user's word), a minor bump. No migration, no new Jira call, JQL or field, no rate bucket, no audit event. Delivers: the rooted import starts from a linked project's row on the Plan page and from the connection page's links list; the Plan page reads the narrow `GET /views/jira-links`; the preview suggests a link for a renamed item;
the Jira blocks of the timeline views are slimmer.

**The answers (all four on the recommended option):**
- Q1 a row that would land outside the root is skipped for **everyone** (one kernel rule, `OUTSIDE_ROOT`; an administrator or the stream's owner no longer re-homes those milestones from this dialog, they import from that project).
- Q2 the **strict word match**: the same words with case, accents, punctuation and order aside; the longer name may only add words; the shared words make up at least half; numbering words equal; unique both ways. A replaced word or a typo is still previewed as new.
- Q3 a suggestion is confirmed with **"Link instead", then "Preview again"** (the preview stays the exact picture of what Import will do).
- Q4 **all three cuts** of the Jira blocks: a flag's null members absent, a flag's evidence without the repeated severity, an evidence detail's null members absent (also on `GET /views/deviations`).

**Defaults taken** (`jira-sync.md`):
- The links view is open to any authenticated user, discloses nothing new, is parameterless and unpaged (2,000 links, `truncated`), has no `revision` and no `can`; the Plan page asks it on every visit (30 s stale, refetch on focus). A project row's entry is gated on the new `can.createMilestone` rather than `can.edit`.
- A suggestion attaches only to a CREATE row under an existing plan item (or a program under the picked stream); ambiguity means no suggestion. The client confirms with `matches[{jiraId, nodeId}]`; the server honours an entry only when it equals its own suggestion, recomputed under the plan lock (stale: `CHANGED`), and guards it first as the CREATE it replaces and then as the BIND it becomes.

**Not built:** each a `[new]` `BACKLOG.md` line (a tab left open across a deploy came in 1.17).

### v1.14.0 — what shipped

The import from a linked node (the user's request of 2026-11-12, after a first import of one program: importing that program's projects should be possible), released on the user's word 2026-11-13, a minor bump. No migration. An import can start from a linked program (the Plan page's program menu) or a linked project (a button on its page) and reads only what Jira lists under that item, with the same preview, apply, filter and guards.

**The answers:** Q1 projects AND their milestones, all ticked as today; Q2 the linked node's owner chain or ADMIN may start it; Q3 the Plan page's program menu plus a button on a linked project's page; Q4 the real-site check of `parent = <program key>` in Jira's issue search (ledger A18) is NOT done: the user released without it, on the stub caveat; Q5 the filter as today ("Leave out done items" on, 365 days).

**Defaults taken** (`jira-sync.md`):
- An optional `root {level, nodeId}` on the existing import endpoints (no new endpoint); the children are read by numeric id; the root takes no preview row; a rooted import lands under the root and never creates a program; defaults must stay under the root.
- An unreadable root, or one outside this connection, answers `409` `urn:astrolabe:problem:jira-root-unusable`; each rooted preview writes a `jira.import_previewed` audit line; a gone program link says so up front.

**Also in 1.14:**
- *Coverage summary:* `GET /integrations/jira/connections/{id}/coverage` and the connection page's table count, per mapped plan level, the issues in scope, linked, open and unlinked. A SEPARATE route, ADMIN only; open = not in the Done status category; linked = the Deviations view's D1 rule; counts only, never a key or name; a mapping saved after the last run began answers `MAPPING_CHANGED`; the counts are labelled "as of the last successful synchronisation".
- *A project's target window from Jira* (reverses the 1.2 decision C): "Copy Jira's dates" gives a project the import CREATES its window from the dates its level is mapped to; both dates or neither (otherwise the info `TARGET_NOT_COPIED`, the row never refused); a bound or existing project, a program and a milestone are never touched.
- *The overnight extras the user picked on 2026-11-12:* a per-row owner in the import (`overrides.ownerPersonId`); the deviation `CHILDREN_OPEN` (INFO, milestones only: the plan's end is before today and some of the bound epic's children are open; acknowledgeable, reopens when the counts change; may fire beside `PROGRESS_MISMATCH`, about a different fact); the `useDialogFocus` fix (no pull back once the user moved to another row).

### v1.13.4 — what shipped

The import preview's search (the user's request of 2026-11-12, to cherry-pick an item by id or text; released on the user's word), a patch bump: web only, no migration. A box above the preview table filters the rows by a case- and accent-insensitive substring of the Jira key, id, summary or plan name; hiding a row never changes its tick or team override, and the selected count, **Import (n)** and the apply stay global.
While a query is active "Tick shown" / "Untick shown" and the header checkbox act on the shown rows through the parent/child rules. **Defaults:** a row with no Jira key (redacted for a non-admin under a filter) never matches; the search is page state, not remembered. Mechanics: `web-internals.md` "The preview search".

### v1.13.3 — what shipped

The overnight batch (the user's choice, 2026-11-11: eight `BACKLOG.md` items for an unattended run), a patch bump; no migration; additive members only (`POST /users` `alsoCreatePerson`, `personId` on every user read, `DeviationJira.previousKey`, a nullable `JiraImportItem.issueKey`). Shipped: a new login can create its linked person in the same transaction (a login without one gets "Create a person"); the roadmap's flag panel filters All / Warnings / Infos; a moved Jira item shows "was OLD-1";
the 1.13.2 audit's LOW-1; a capacity write locks the team's binding row before the team and prunes the acknowledgements in its own transaction; no `X-RateLimit-*` header on admitted answers (`Retry-After` only on a 429); the image's `apt-get update` fails when an index cannot be fetched; `checkVerificationMetadata` fails `check` on a superseded entry.

**Defaults taken** (the overnight rule: the recommended answer, recorded): the "Also create a linked person" switch is ON by default (the request default stays false); the severity filter is the roadmap's only (the programs page has no flag panel); LOW-1 conceals a redacted row's key, id and parent for a non-admin under an active filter (one residual, a lone issue's group count, is in `authorization.md` and `BACKLOG.md`); a database failure in the capacity prune aborts the write with a `500`.

### v1.13.2 — what shipped

The Jira import's filter (the user's request of 2026-11-11: leave out done items and items updated longer ago than a configurable number of days; released on the user's word), a patch bump: no migration; the additive `filter` request member and two row infos. It exists because a Jira project with more than 2,000 items at the mapped levels could not be imported at all (the browse stops at 2,000).

**The answers:** Q1 the filter narrows EVERY mapped level inside the search query; a left-out direct parent of an item that is read is fetched by id and kept (`KEPT_AS_PARENT`; at most 200 reads a browse, past that the preview is `truncated`); a parent Jira answers `404` for skips its child (`PARENT_UNREADABLE`), while a `403`, `401`, `429` or `5xx` on that read fails the preview as the `502`.
Q2 the filter is set per import in the dialog (Leave out done items on, Updated within 365 days, 1..3,650, empty = no limit), nothing stored. Q3 the version is 1.13.2. **Only the import reads through the filter** (Refresh, the Deviations page and the roll-ups read everything; an item imported earlier that later becomes done stays linked). **Defaults:** the window is sent in minutes (`updated >= "-<N x 1440>m"`); the preview does not count what was left out; the stub does not evaluate the filter (the isolated `IMF` project proves the by-id read and the `404`);
`jira.import_applied` carries `excludeDone` and `updatedWithinDays`; ledger rows A16 and A17 stay stub-only.

### v1.13.1 — what shipped

The fixes batch (the `[next]` items the user promoted on 2026-11-11; released on the user's word), a patch bump: every item is a fix or hardening; no migration. **The answers:** item 7 the proposal's accept **looks again** instead of refusing (a changed holiday dictionary refuses only when it changes a date being accepted; otherwise the same 409 `stale-scope`); item 2 **Refresh now** rides a per-user `sync-run` bucket, **10 a minute**; the version is 1.13.1; the verification-metadata prune is included.

**Also shipped:** a capacity write (a manual period POST, a changed PUT, a DELETE, the import apply) clears the capacity acknowledgements of the sprints it brings in line, after its commit, through the `teams/` listener seam.
**Defaults:** the 1.13 key and re-ask stay stub-only (a `[new]` item asks for the by-hand walk); the capacity prune runs after the commit in its own transaction, binding row first; one audit vocabulary, `via=capacity`; the focus fix only after a red unit test. **Upgrade note:** a proposal open during the upgrade carries the old `scopeHash` layout and is refused once (409 `stale-scope`), then proposed again by the page.

### v1.13.0 — what shipped

The Jira tail (the five items the user promoted on 2026-11-11, plus the moved-out e2e; released on the user's word), a minor bump; **V29** `jira_observations.gone_probed_key` and **V30**, which drops V22's `jira_bindings.ack_*` (1.11 and older can no longer run on the schema; 1.12 can). **The answers:** D3 the binding's key follows the key the gone probe's 200 carries, and a key inside the connection's project keys reads `NOT_LISTED` (archived, a changed type, a false-empty listing);
D4 the header splits the gone total (`totals.stillInJira`, "N still in Jira, out of scope"); D5 the V22 columns are dropped now. **Defaults** (`jira-sync.md`): a readable gone item is asked again once per `jira.censusHours` on scheduled runs and at once on Refresh now; an in-memory per-connection back-off (`GoneProbeDamper`: three runs in a row without one answer trip it; a new vanish is still asked at once) with the retry order rotated. After the security audit:
the key pattern on the three response key members, `isInScope` refuses a non-key.

### v1.12.0 — what shipped

The Jira deviation polish (three items the user promoted on 2026-11-11; released on the user's word), a minor bump; **V28** `jira_deviation_acknowledgements`. **The answers:**
- Q2 a milestone's team manager may acknowledge and withdraw every deviation of a milestone binding of their team, whoever stamped it (project and program bindings unchanged; reverses 1.3 Q4 in part).
- Q3 the earlier whole-list acknowledgements are **reset** by the upgrade.
- Q4 per line plus "Acknowledge all (N)" / "Withdraw all (N)" (reverses 1.3 Q3's whole-list key).
- Q5 a line that leaves and returns identical stays acknowledged (no pruning).

**Defaults** (`jira-sync.md`): `MOVED_OUT` is a wire reason derived from the stored `OUT_OF_SCOPE` plus `gone_probed_at` (a known over-claim after a type change or a false-empty sweep); the API stays additive (`kind` optional on the existing POST/DELETE; the kind-less POST stamps the open lines, the kind-less DELETE clears every row; totals count open lines); a kind/severity chip matches the lines in the selected Status. After the security audit the DELETE refuses any query parameter but `kind`.

### v1.11.0 — what shipped

Overnight part 2 of 2026-11-11 (released on the user's "Feel free to release"), a minor bump; no migration. **Withdraw all:** `POST /integrations/flow/team-bindings/{id}/unacknowledge-all` and "Withdraw all (N)" beside "Acknowledge all (N)" (supersedes 1.10 D12's "no withdraw all"; sprints only, all or nothing with the `409 stale-deviations`, `204`, shown at two or more acknowledged rows). **The Netty read timeout re-armed per interval** (`security.md` "Slow requests"): a stalled request is cut with `408` on a reused or once-idle connection too.

### v1.10.1 — what shipped

Fifteen small fixes of the overnight run of 2026-11-10/11, a patch bump at the user's request; no migration. User-visible: the ADMIN "All teams" shortcut on `/schedule-proposals` (the first 50, the run's `teamIds` cap); the account menu's theme as three `Menu.Item`s; a per-user `password-change` bucket (10/min) on `PUT /users/{id}/password`, its 429 typed `urn:astrolabe:problem:password-change-locked`; the outbound guard refuses the IPv4-translated SIIT range `::ffff:0:0:0/96` whole, never unwrapped;
a run claim locks its connection row `FOR SHARE`, so a claim racing a connection delete leaves no orphan `sync_runs` row. **Defaults taken overnight:** SIIT refused rather than unwrapped; the claim-time lock rather than an orphan sweep.

### v1.10.0 — what shipped

The sync follow-ups (2026-11-10), a minor bump; **V27** (`jira_observations.gone_probed_at`); proven against the stubs only. The four overnight items are in "Domain decisions"; the rest is "Defaults taken for v1.10.0". Delivers the gone-probe stamp and retry, the pruned acknowledgements and `acknowledge-all`, the `::/96` refusal, the Home landing, "Import from Jira..." on the work-stream menu. **Consequences:** the first 1.10 run probes every row already gone (up to 100 a run) and an acknowledged `GONE` whose reason changes reopens once;
the first Flow run deletes every stored acknowledgement whose row is not listed.

### v1.9.0 — what shipped

The 1.6 follow-ups (2026-11-10); **V26** (`flow_capacity_acknowledgements`: one row per Flow team binding and sprint, `sprint_id NULL` is the team's own `TEAM_GONE` row); proven against the Flow stub only. The answers (Q1-Q4 of 2026-11-10) are Q8a-Q11a in "Domain decisions";
the defaults are "Defaults taken for v1.9.0". Delivers the per-sprint acknowledge `POST|DELETE /integrations/flow/team-bindings/{id}/acknowledge` (audited, `409 stale-deviations`), the OPEN-by-default listing and the team view's `FLOW_CAPACITY` flag and `weeks[].flowCapacity`. **Consequence:** a later release that changes a kernel rule or the deviation's figures un-acknowledges everything, by design, and its notes say so.

### v1.8.0 — what shipped

The cross-team schedule proposal run (the release commit of 2026-11-10), a minor bump; no migration. The user's answers Q9a-Q13a of 2026-11-09 are in "Domain decisions"; the 1.8 plan added (Q1a) ONE plan-scoped check called by BOTH pages (the user's answer of 2026-11-09, "go ahead with 1.8, all recommended"); the defaults are "Defaults taken for v1.8.0". The page learns the caller's teams from `GET /schedule-proposals/teams`; the e2e is `cross-team-proposal.spec.ts` and the team page's check is covered by vitest only;
the nav leaf sits after Baselines. **Consequences:** a run is page state (lost on navigation; `BACKLOG.md`); a drag of any run team's unticked milestone refuses the accept and the page re-proposes at once with the ticks kept; an unsettled run (a loop between teams) may be accepted, its dates are the last pass's.

### v1.7.0 — what shipped

The planning features (the release commit of 2026-11-09), a minor bump; **V25** (`milestones.pinned`, and `ck_milestones_pinned_scheduled`: a pin needs dates). **The answers** ("all recommended", 2026-11-09): (Q1a) **1.7.0 = the critical path on the team page AND the roadmap (with the per-link slack), the stored pin, the baseline-vs-baseline diff (with the rank movement)**; the cross-team run goes to 1.8.0 (the pin comes first, so managers can protect dates before a run moves them);
Q2a-Q7a and Q8 are in "Domain decisions"; (Q8) **out:** the ticked-subset link check (went with 1.8) and keep-what-fits with the target-window start bound (the pin covers "keep this one"). The pin writes `milestone.pinned` and `milestone.unpinned`; the pin is inside the proposal's scope hash.

### v1.6.0 — what shipped

The capacity deviation (released 2026-11-08); no migration, nothing stored. **The answers** ("all recommended", 2026-11-08):
- (Q1a) **no acknowledge** in 1.6.0 (the remedy is one click, the horizon is rolling, a store would need a migration; reversed in 1.9.0: per sprint).
- (Q2a) the Deviations page gains a second section "Capacity from Flow" and the team page's Flow section a "Capacity vs Flow" line, both from the SAME document (`GET /views/capacity-deviations`, `flow/`); no timeline flag (reversed in 1.9.0 and 1.23.0).
- (Q3a) **per sprint over the days it holds**, current or future (`end >= today` in the connection's zone), `flowMd = round2(mdPerWeek x W / 5)` beside Flow's raw `flowTotalMd`, both sides rounded before the 0.5 threshold, skipped and `LONG_WINDOW` sprints silent.
- (Q4a) `CAPACITY_MISSING` per sprint (the web folds a team's rows into one line); (Q5a) a second endpoint beside the Jira one (`jira/` and `flow/` may not name each other); (Q6a) the e2e flips `flow-day2` under the lock `flow-stub-scenario`.

**Defaults taken:** `today` in the connection's zone, `asOf` the UTC date; only deviating teams are items, no `all`; caps 1,000 teams / 100 connections; the section hides itself without a Flow connection; no `revision` (team data). **Decided while building:** a sprint with no plan period against Flow's 0 is silent; a `ZERO_CAPACITY` sprint carried by an earlier period is a WARNING whose remedy is ticking it by hand in the preview;
Flow's per-sprint figures and the connection's zone are disclosed to every login (`authorization.md`). **Consequence:** a team imported under 1.5.0 may show differences until imported again.

### v1.5.1 — what shipped

The fixes from the first connections to a real Jira Cloud site and a real Flow; no migration (D1-D5 "all recommended"). **Jira:** the development stub serves only sites whose tenant label starts with `stub-` (`JiraStubRouting`); every other site reaches Atlassian, and the test result, the connection response and `jira.connection_tested` carry `stub`. **Flow:** the base-URL refusal names its cause, ADMIN reads the allowed origins (`GET /integrations/flow/origins`), `docker-compose.real-flow.yaml` reaches a Flow compose stack;
the capacity import counts Flow's days (`flow-sync.md` F3, F11, F12). **Consequence:** an existing development connection to `sample.atlassian.net` reaches the real Atlassian until deleted.

### v1.5.0 — what shipped

Flow teams, capacity and membership (released 2026-11-08), proven against the Flow stub only (walk-through and ledger F1-F10: `flow-sync.md`). **V24** (additive): `flow_connections`, the mirror `flow_teams` / `flow_sprints` / `flow_members` (one Flow document, replaced wholesale per run), the 1:1 `flow_team_bindings`, and `team_capacity_periods.source` (`MANUAL`|`FLOW`).
Delivers the ADMIN registry with Test connection, `SyncKind.FLOW` through the 1.3 scheduler, binding by name, `GET /teams/{id}/flow`, the capacity import (preview then apply, one transaction under the team lock), the team page's Flow section and the Flow stub (host port 8097). The answers Q1a-Q7a are in "Domain decisions"; the defaults are "Defaults taken for v1.5.0". **Consequences:** an import is a snapshot (a re-import updates Flow-sourced periods;
removals are listed and never preselected; the last imported sprint's figure stays in force until the next import); the roster is information only (`BACKLOG.md`); a revoked or expired token fails the runs with `AUTHENTICATION_FAILED` until a new token is saved.

### v1.4.0 — what shipped

Coverage and roll-ups, proven against the stub only (walk-through step 9 and ledger A11 to A14: `jira-sync.md`). **V23** (additive): the mirror `jira_issues` and `jira_connections.census_at`; the EXISTING run observes the census in the same pass. Three deviation kinds on the PARENT's binding (`UNLINKED_IN_JIRA`, `UNLINKED_IN_PLAN`, `CHILDREN_DONE`, declared last so older fingerprints hold), `jira.rollup` on every milestone `JiraLink` and the Deviations item from ONE `GROUP BY`;
the views make no outbound call. `JIRA_TEST_RATE_LIMIT_PER_MINUTE` (1..100, blank = 10) pins the Test/Peek bucket (30 on the compose stack and the OrbStack overlay). The answers Q1a-Q6a (the user's "all recommended, go ahead", 2026-11-07) are in "Domain decisions".

**Defaults taken** (any can be reversed):
- Done Jira children are not `UNLINKED_IN_JIRA` (closed work the plan never had is history) but count in roll-ups; every non-sub-task type at the child level counts.
- Coverage pairs a bound node with its DIRECT plan children against the mapping's level for that plan level (none when unmapped); "linked" is an ACTIVE binding on this or another active connection of the same site (D1).
- A detail lists at most 10 keys or names, ascending by id, plus `count`; Jira items by key only, never a summary.
- Roll-up points are the discovery's `storyPoints` marker, never converted to man-days, null when absent; the roll-up reads `done/children · points pt`, and a project link's `rollup` is always null.
- `CHILDREN_DONE` only while the epic itself is not DONE (else `PROGRESS_MISMATCH` alone) and the plan's end is after today.
- A disabled connection's link carries no roll-up and raises no flag; no census without bindings; no audit event for census writes; a children read past the page ceiling keeps what it read, prunes nothing and warns, and any other failure of the children pass leaves the run SUCCEEDED, unstamped, with a WARN. `jira.censusHours` is 24, bounds 1..168. Program-level coverage shows on the Deviations page only.

**Consequences:** a binding that gains one of the new kinds reopens (a new fingerprint); a story deleted in Jira can inflate a roll-up for up to `censusHours`; a site whose stories point at their epic through Epic Link shows no children (A12); the first run after the upgrade reads every connection in full once. **Not in 1.4:** program and work-stream coverage flags on the timelines, a drill-down from the roll-up.

### v1.3.0 — what shipped

Polling, status, acknowledge and the timeline markers, proven against the stub only. **V22** (additive): `jira_connections.poll_interval_minutes` (default 15, `CHECK` 5..1440 or null) and the acknowledgement columns on `jira_bindings` (dropped in 1.13). The in-process scheduler (`sync/SyncScheduler.kt`, `SYNC_SCHEDULER_ENABLED`, `SYNC_TICK_SECONDS`; it claims through the ordinary run claim, so two replicas never double-run) over the pure `SchedulePolicy.decide` (nothing stored);
`SyncStatus` (NEVER_SYNCED, CURRENT, STALE after 3 intervals, FAILED, DISABLED); `POST`/`DELETE /integrations/jira/bindings/{id}/acknowledge`; the four timeline views fold Jira in through `planning`'s `ExternalFlagSource` seam (a `JIRA_DEVIATION` flag per open deviation, one `JIRA_MILESTONES` roll-up per project, `jira{}` links, `jiraSites[]`); acknowledged items, disabled connections and `ESTIMATE_NOT_COMPARABLE` raise nothing. The web adds the Polling group, a status badge and filter, Jira flags and the "Jira dates" toggle with the shadow bar `jira:<id>` on all four pages.

**The answers** (the user: "yes, recommendations are fine, feel free to go ahead", 2026-11-07; any can be reversed):
- (Q1) a per-connection `pollIntervalMinutes`, default 15, 5..1440, `null` = manual only; existing connections start polling at the upgrade.
- (Q2) Flow's five states derived per read from `sync_runs` and `enabled`, nothing stored; an untested connection is told by `discoveredAt == null`.
- (Q3) an acknowledgement keys on the sha256 of the binding's whole deviation list (replaced per line in 1.12). (Q4) the node's owner chain or ADMIN may acknowledge, like the bind.
- (Q5) a server-side fold: one flag per open deviation on the project's own binding, one roll-up per project for its milestones. (Q6) the Jira shadow bar is on by default with a remembered toggle.
- (Q7) Flow's back-off from `sync_runs`, capped at six hours, a config change making the connection due at once. (Q8) a disabled connection is not polled, raises no flag and draws no bar, but its bindings stay visible. (Q9) the poll's run lock and the import's plan lock are independent.

**Rulings while building:** the back-off is `max(interval, min(interval x 2^(n-1), 6 h))`; a run that outlives `sync.maxRunMinutes` without a claim reads FAILED (interrupted); the Jira dates bar is drawn only inside the plan's own dates padded by a year; a binding through a disabled connection stays a link (no dates, no flags) so its owner can still unlink it. **Consequence:** a later release that changes a deviation rule changes every fingerprint and un-acknowledges everything.

### v1.2.0 — what shipped

Import from Jira, proven against the stub only (walk-through and ledger A10: `jira-sync.md`). **No migration.** `POST /integrations/jira/connections/{id}/import-preview` (a read, nothing stored) and `POST …/{id}/import` (the ticked rows, re-browsed and re-decided under ONE `withPlanWrite`: programs, projects and milestones created under the picked work stream, each bound to its Jira item, one revision bump, one `jira.import_applied` audit line); the `jira-import` bucket (5/min per user); up to 2,000 items (a truncated scope is a `400` on the apply);
a 170 s browse deadline; a three-phase modal on the connection page; the stub's isolated `IMP` project.

**The decisions** (the user's, on the plan's recommended options; any can be reversed):
- (A) the e2e imports an isolated `IMP` stub project, not `E2E`: program names are globally unique, so importing `E2E` would collide with the user's own demo import and with the specs that bind it.
- (B) the modal is on the connection page only (ADMIN); superseded in 1.10 by the Plan page's work-stream menu.
- (C) a project's target window is not copied from Jira (reversed in 1.14).

**Rulings while building:** for a non-admin every skipped row but `ALREADY_BOUND` is redacted and `unmatchedTeams` counts the created rows only; the apply's rights are the ticked rows' targets, narrower than a full preview's; redaction exists so an owner of one node cannot read every summary in scope (reversible if node owners may read everything in scope); a milestone whose dates cannot be copied is created unscheduled, never skipped. **Consequences:** linking is by name, so an unlinked item renamed in Jira previews as a new one (1.15 suggests a link);
the planner reads only the direct Jira parent, so an item under an unmapped intermediate level goes to the default parent, else is skipped `NO_PARENT`.

### v1.1.0 — what shipped

The Jira sync's first release, proven against a built-in stub only (walk-through and ledger A1–A8: `jira-sync.md`). V21; `infra/fetch/`; the guarded Jira client; the ADMIN registry (token encrypted at rest); probes, discovery, mapping, Peek; 1:1 bindings; the connector-agnostic run registry (`sync/`); the deviation kernel and `GET /views/deviations`;
the stub on compose and the Kubernetes overlay (port 8096). **Not in 1.1:** polling, acknowledge, import, coverage, Flow. `ingest/`, the raw store and the role switch were deliberately not ported (see "Donors"). The five overnight defaults were ruled on and kept ("The Jira sync" above).

### v1.0.0 — what shipped

The checkup: no new domain feature, no migration. Doc drift fixed, coverage floors raised to the measured actuals, a11y lint and axe, the OrbStack Kubernetes overlay and a hardened compose app, a password-change lock and an MFA live-code limit; performance re-measured at scale, no fix justified (`BACKLOG.md`).

**Defaults taken (the user accepted a, b and c):**
- (a) **Kubernetes stays local on OrbStack** and its overlay sets `KTOR_DEVELOPMENT=true` and `HTTP_BEHIND_PROXY=false`, so no deployment target runs production mode and only the server suite proves it (`security.md` "Everything development mode relaxes").
- (b) **The MFA limit replaces the oldest code** (default 3, 1..100, the user's choice after the reviews) rather than answering 429, which blocked an honest retrier and let a password holder keep the block going.
- (c) **The password-change lock is one `LoginThrottle` per user id on the login lockout's knobs** (5 attempts, 15 minutes; login is unaffected): a stolen session can keep the lock active, and the exits are an email or an admin reset.

### v0.9.0 — what shipped

Baselines (V20) on the answers in "Domain decisions", plus four carried items: the telemetry e2e waits for the NEWEST live process, one theme-owned table hover tint, the proposal's `dependencies[]` slimmed to the links violated before or after the moves, and the batch accept's scope check (`scopeHash`, `409 stale-scope`). Database triggers refuse any update or delete of the frozen rows; take, rename and delete are plan writes audited as `baseline.created|updated|deleted`;
`?baseline=` on the four timelines (`400 unknown-baseline`) and `GET /views/baseline/{id}`. **Not built** (`BACKLOG.md`): baselines of links and capacity, per-team baselines, an automatic baseline at a release.

### v0.8.0 — what shipped

Auto-proposal (no migration), on the answers in "Domain decisions": the pure `ScheduleKernels` place ONE team's not-started milestones (`scheduling.md` "The auto-proposal"). `POST /teams/{id}/schedule-proposal {asOf}` (the team's manager or ADMIN;
a read-only snapshot, no lock, no audit event) and the accept `POST /teams/{id}/milestone-schedules {expectedRevision, items}` (N schedule PUTs in one plan write, per-item `skipped` reasons, one revision bump, audited as `milestone.scheduled` per change plus `team.schedule_batch_applied`). The team page previews dashed on the same timeline and is read-only while a proposal is open.

### v0.1.0 to v0.7.0 — foundation to calendar

The Roadmap tables above hold each version's scope; the answers behind them are in "Domain decisions", the mechanics in `planning-model.md` and `timeline.md`. v0.1.0 was Flow @ `e9c3b726` (1.35.0) renamed and trimmed: Jira and GitLab ingestion, the metrics layer, reports, the role switch and the worker process were removed; one process serves everything.
