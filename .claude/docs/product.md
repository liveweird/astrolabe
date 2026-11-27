# Product, roadmap and donors

Owns: what Astrolabe is, the scope of every version, the decisions the user took, the defaults taken without asking, and what each donor gave. Not here: what each version shipped (`release-history.md`); the binding one-liners (the hierarchy, the current version, "Port, don't reinvent") are in `CLAUDE.md`; the domain model is `planning-model.md`; the timeline component is `timeline.md`; how an area works now is its own doc, and git keeps what happened step by step. The plans of each increment live outside the repository.

Read on demand when you need the product intent, the scope of a version, a decision the user already took or what a donor contributed. A decision recorded here is the user's unless it is filed under "Assumptions" (taken without asking, change on request).

## What Astrolabe is

A planning and roadmapping app in the spirit of Jira Plans: better UX, more opinionated, Gantt-centred, for a multi-stream / multi-program / multi-team environment. It keeps its **own** plan data. It reads Jira and Flow only to **detect deviations** and, on request, to import items; corrections are made in Astrolabe, never written back. The name is the instrument: a tool for reading where everything stands against time.

Scale assumed: about 15 teams, 5 work streams, 20 programs, 100 projects, 1,000 milestones.

- **Gantt.** A custom shared timeline component: DOM rows, SVG arrows, dnd-kit, TanStack Virtual (`timeline.md`).
- **Brand.** Deep cyan / ocean (the `astrolabe` colour tuple, primary `#0b7285` light, `#095c6b` dark); the logo is a stylised astrolabe (limb ring with ticks, rete star pointers, alidade). Success is green, red = blocking, orange = warning (`web/CLAUDE.md`).

## Roadmap

Each increment gets its own plan (architect) before implementation; only v0.1.0 was specified up front. **Current version: 1.36.0**. Version numbers are not strictly roadmap milestones (`app-releases.md`): a user-visible fix between two increments is a patch bump. One row a version (patches ride their minor's row); the scope only, the detail is in `release-history.md`.

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
| **1.8.0 Cross-team run** | `POST /schedule-proposals` over a set of teams in dependency order to a fixed point; one accept in one plan write; a check of the ticked subset; its page (gone in 1.33) |
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
| **1.22.0 View ETags, dependencies edited from the list** | Ten view reads answer an `ETag` and `304`; "Edit..." and "Delete" on a Dependencies row the caller may change; Team load from this week on (`?past=true`; removed 1.36) |
| **1.23.0 Database time limit, Flow capacity flag, Home "Yours"** | A 15 s statement limit (`POSTGRES_STATEMENT_TIMEOUT_SECONDS`), the focus after "edit, then delete", the Flow capacity flag on the Roadmap and Programs, everything you manage on Home (no migration) |
| **1.24.0 Technical release** | No feature: docs in Rules and sections with a guard, the spec's descriptions as contract, shared Jira and Flow pieces, two CI forks, a named e2e target; the item-level `acknowledgement` leaves `GET /views/deviations` |

### 1.25 onwards: one tree, one Roadmap, the Gantts

| Ver | Scope |
|---|---|
| **1.25.0 Reliability and navigation** | Complete Flow sprint snapshots (V31), atomic project edits, consistent API reads, grouped navigation and refreshed Home; 1.25.1 a new logo |
| **1.26.0 Saved proposals, frozen links and capacity** | Cross-team runs saved and read by every signed-in user (V32); baselines freeze links and capacity (V33); paged `GET /work-streams` and `/programs`; docs under byte ceilings, fewer test sleeps; 1.26.1 dependency updates (`dependencies.md`) |
| **1.27.0 Finding and linking work** | A dependency added from its list; Milestones by program, work stream and rank; the whole critical chain on the team page; the last untested timings measured; 1.27.1 dependency updates (`dependencies.md`) |
| **1.28.0 The Plan page as one tree** | One tree table with folds, search and filters in the address, Show only this, pins on top, work streams and programs re-arranged and shared with the Programs page (V34) |
| **1.29.0 One Roadmap, Projects, team colours** | Roadmap and Programs in two modes on one page, a Projects view (picker; its Milestones table was removed 2026-11-27, below), dependency lists beside the timelines, team colours (V35); the Milestones and Dependencies pages folded in |
| **1.30.0 The 1.29 follow-ups** | Header sizes, the focus ring, forced colours, the Roadmap's dependency panel outside the timeline, milestones in the picker, Team load's total; `GET /milestones` trimmed |
| **1.31.0 Names as links** | Every work stream, program, project, milestone, team and user name links to its page (a milestone to its row on the project page, a work stream or program to the Roadmap overview narrowed to it); the views carry the ids |
| **1.32.0 Team load folded into Teams** | One Teams table with every team's load (`GET /views/team-load` gains `description`), its filters and "Weeks with a warning" (removed 1.36); the Team load page and nav leaf gone, `/team-load` redirects |
| **1.33.0 Schedule proposals on the Gantts** | The project page and the Roadmap overview preview a cross-team proposal as dashed bars (everyone previews, a manager accepts only their teams' moves, `projects[]` in the run); saved proposals live on the overview; the Schedule proposals page and nav leaf gone |
| **1.34.0 Collapsible Gantt columns, Scroll to today** | Every Gantt can hide the columns between the name and Operations (one toggle and a menu per column, remembered per page in the browser); Today reads "Scroll to today"; web and e2e only |
| **1.35.0 The 1.34 walkthrough fixes** | The Teams figures whole; no sideways scroll at 390 px (the tray scrolls in its box, a narrow Gantt fits its columns, session only); "N hidden" on Choose columns; clipped Gantt headers; web and e2e only |
| **1.36.0 Less repetition, a compact header** | The project page's Milestones table and the Teams page's warning weeks removed (Home's link lands on Unscheduled; the badges open the team's weekly load at the week); titles compact, descriptions behind an ⓘ, facts visible; web and e2e only |

## Domain decisions taken with the user

An answer is the user's own, including "all recommended" (the user chose the recommended option). The answers that shaped only one version's build are in `release-history.md`; each topic below says where its later answers are.

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
  ADMIN, or the ACTIVE manager of EVERY listed team (a missing or deleted team is a 404 for everyone, then the first failing guard is the 403). **Superseded in 1.33.0:** every login runs and checks; only the accept's teams (`acceptTeamIds`) need the guard.
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
- **Finding and linking work (1.27; the user's answers of 2026-11-25).** (U1) The team page draws the **whole chain as rows**: every member of another team, near or far, is a dimmed read-only row with its arrows. (U2) Only while the Critical path toggle is on. (U3) "Add dependency" on the Dependencies page shows to whoever can manage at least one project; the successor picker offers only those projects, the predecessor is anything; the server's rule is unchanged. (U4) A rank sort puts the milestones of unranked projects last in BOTH directions, by project name.
  Built on the recommendation and confirmed by the user the same day: (Q1 a) the chain is the members on a zero-slack path THROUGH one of the team's milestones, not every critical milestone of its projects; (Q2 a) Milestones keeps opening by project name, rank is one more sortable column.

### The Jira sync

Later answers on this topic: `release-history.md` 1.2.0, 1.3.0, 1.12.0, 1.13.0 to 1.13.2, 1.14.0, 1.15.0.

- **Decided 2026-11-06** (nine questions, all answered with the recommended option; the six decisions are the user's own). (1) Work streams are categories and never live in Jira (nothing maps, binds or imports one). (2) Programs, projects and milestones each map to ONE configurable Jira hierarchy level per connection (milestone = Epic by default; the mapping names the integer `hierarchyLevel`, not a type list).
  (3) Bindings are 1:1 per node and per Jira item, and the plan can later be IMPORTED from Jira (preview, then apply; never overwriting). (4) The field mappings are configurable and the defaults come from Jira Plans ("Target start"/"Target end", then "Start date"/`duedate`). (5) Everything is proven against a stub first, so the first real test is cheap. (6) From Flow, capacity and team membership "for now".
- **The cut and the rules (same answers).** 1.1 connection + mapping + manual bindings + Refresh + Deviations, 1.2 import, 1.3 polling/acknowledge/markers, 1.4 coverage, 1.5 Flow. **Estimates convert only with a declared unit or factor** (otherwise the Jira figure is only shown). **Linking** is the node's owner chain or ADMIN. **Import** is ADMIN or an owner of every target, dates copied only where the caller may schedule; re-import never overwrites; orphans go under a default parent, else are skipped;
  a milestone's team on import is a name match, else the default team, else skipped. The sync **detects**; deviations warn only and nothing is written to Jira.
- **Kept by the user on 2026-11-07 (the overnight defaults).** One link per site across connections (D1); deleting a connection unlinks its bindings (D2); discovery stored even if other probes fail (D3); the empty-sweep default (an empty listing of a non-empty bound set flags the bound items gone with a WARN; the next good run clears them); a disabled connection's bindings stay visible.
- **Coverage (1.4; decided 2026-11-07, all six answered with the recommended option).** The run observes the census into a mirror and the views read only the database (Q1a). Coverage surfaces as three deviation KINDS on the parent's binding, not a page of its own (Q2a). The child level is re-listed once a day by an id sweep and in full on every full read (Q3a). `UNLINKED_IN_JIRA` is a warning, `UNLINKED_IN_PLAN` and `CHILDREN_DONE` infos (Q4a). The roll-up is compact dimmed text after the Jira key (Q5a).
  The `jira-test` bucket became configurable instead of spending the tenth call (Q6a).
- **The four overnight items of 1.10 (confirmed 2026-11-10: "defaults confirmed, all recommended").** (1) **Holiday-only milestone flag** `NO_WORKING_DAY`, WARNING: a scheduled milestone covering no working day loads nothing and is a zero-length point in the dependency check, so the planner has to move it; raised on milestone rows of the project and team views only (no roll-up on the roadmap or programs, no weeks-strip mark, the bar unchanged), computed from the view's own calendar, nothing stored;
  the sentence is "Covers no working day: only weekends or holidays".
- **The four items, continued.** (2) **Removed projects on the roadmap and programs overlays.** On the roadmap they are appended after every current row: rank cell "-", dimmed "(removed)", the frozen span as the shadow bar, no flags, no menu; they honour the work-stream filter and the program pick and are hidden while a team or owner filter is active. On programs a removed row sits under its live, shown, expanded program (a gone, hidden or collapsed program draws nothing; the totals line counts it);
  a removed project with no frozen span gets no row.
- **The four items, continued.** (3) **Import from Jira on the Plan page** (supersedes the 1.2 decision B): "Import from Jira..." on the work-stream row's menu, gated on the stream's `can.edit`, the server staying the authority; the offered connections are enabled with the mapping OK, one preselected, several picked in the scope step, none an inline note; the work stream is preset and read-only.
  (4) **`DELETED` vs `OUT_OF_SCOPE`** by a per-issue probe of the bindings a run flags gone (at most 100 a run; 404 `DELETED`, 403 `FORBIDDEN`, 200 `OUT_OF_SCOPE`, any other failure a WARN that never fails the run; `jira-sync.md` "The gone probe"), no new audit event; the phrase widened to "Deleted in Jira (or no longer visible to the connection's account)".
- **Superseded in 1.10 (the user's clause is replaced, not kept).** Two clauses of (4), "rows flagged by earlier versions stay `OUT_OF_SCOPE` until seen again" and "any other failure leaves the row `OUT_OF_SCOPE`" (never retried), gave way to the promoted backlog item that a probe which did not answer is retried (V27 `gone_probed_at`, no backfill; so every row already gone gets its first probe in the first 1.10 run, up to 100 a run until drained).
- **The item-level acknowledgement summary is removed (decided 2026-11-15, the 1.24 checkup's Q5).** A Jira deviation item no longer carries `acknowledgement`; only its lines do. This is an accepted exception to API-VER-002 (a removed response member stays inside `/api/v1`) and to API-VER-004's headers: the member was `deprecated: true` with a migration note from 1.12 to 1.23, its one client is the first-party SPA, which has read only the lines since 1.12, and no `Deprecation`/`Sunset` header was ever sent. The 1.24.0 changelog names the removal.

### The Flow sync

Later answers on this topic: `release-history.md` 1.6.0, 1.9.0, 1.10.0, 1.11.0 (withdraw all), 1.23.0.

- **Decided 2026-11-08** (the user answered "all recommended"). (Q1a) The transport is an **operator allow-list** (`FLOW_ALLOWED_HOSTS` / `FLOW_ALLOWED_CIDRS` / `FLOW_CA_BUNDLE`, the production path for a TLS Flow behind a private CA) plus a **development-only plain-http allowance** (`FLOW_INSECURE_ORIGINS`: the stub and a Flow on OrbStack); a connection's base URL must be one of the listed origins, so an admin can never widen the list.
  (Q2a) **Every authenticated user sees a team's Flow roster** (display names and dates; account ids never leave the server). (Q3a) **The team's manager or ADMIN links a team to its Flow team** (ADMIN alone gets "Link all suggested").
- **Same decision, continued.** (Q4a) **`mdPerWeek = round2(5 x sprint man-days / working days)`** on Astrolabe's calendar, one capacity period per sprint, so the weekly capacity adds up to what Flow says; Flow-sourced periods are owned by the import (updated on re-import, offered for removal when their sprint is gone or re-dated); **hand-entered periods are never changed or deleted**.
  (Q5a) The **capacity deviation** (1.6.0) warns when the plan has more capacity than Flow (a gap of 0.5 man-days or more), is info when it has less, and flags a Flow team that left the document; per current or future sprint over the days the sprint holds (the import's own windows and figures, both sides rounded to two decimals), `CAPACITY_MISSING` per sprint, `LONG_WINDOW` and skipped sprints silent. (Q6a) 1.5.0 = connection + stub + run/mirror + binding by name + roster + capacity import;
  1.6.0 = the capacity deviation. (Q7a) A Flow connection polls **every 60 minutes** by default.
- **Acknowledge and the flag (1.9.0; the user's answers of 2026-11-10, the 1.9 plan's Q1-Q4, as Q8a-Q11a).** The capacity deviation is acknowledged **per sprint** by the team's manager or ADMIN; a closing sprint reopens nothing, a new sprint arrives open. The team view carries a header flag and a weeks-strip marker over the OPEN rows only: acknowledged rows do not flag (they stay listed under the Status filter).
  Roadmap and programs carried none until 1.23 (a per-team flag on project rows, "v1.23.0 — what shipped"). Nothing is ever written to Flow.
- **The project rows' flag (decided 2026-11-15, 1.23 Q2 a; reverses 1.9 "team view only" in part).** A project row of the Roadmap and Programs carries ONE Flow capacity flag per team, only when a scheduled milestone of the project on that team lies in days an OPEN capacity difference covers; a WARNING when the plan holds more capacity than Flow, an INFO otherwise. Acknowledged differences, a disabled connection, a gone Flow team and unscheduled milestones raise nothing.

### Home and the lists

The standing rules the pages after 1.16 follow; the answers with their rejected alternatives are in `release-history.md`, 1.17.0 to 1.23.0.

- **Home.** The Plan and Roadmap cards show the plan's own figures, including two capacity figures (teams with an overloaded week, teams over the WIP limit; the one answer off the recommended option, 1.18 Q1 b). "Yours" is what the person linked to the login owns and the teams that person manages;
  since 1.23 (Q3 b) it lists everything under a work stream or program you own, each row naming its owner, and a switch "Only what I own myself" (off by default, remembered in this browser) narrows both tables. A login without a person gets one plain sentence. Home's figures are links to the filtered view behind them; a badge or link shows only when its count is positive (zero is not a claim).
- **Page descriptions behind an info button (decided 2026-11-27).** Pages opened with a title and a dimmed description that took a lot of room; the title is now smaller, on one row with the actions, and the free text (a page's generic intro, a project's or team's own written description) opens from a small "About this page" button beside the title, never shown until clicked; entity facts (a project's program · work stream · owner links, a team's manager, a person's email and login) stay visible on one compact line, and entity pages keep their name (`web-internals.md` "Page chrome").
- **Links in tables and Gantt left panes are the brand colour (decided 2026-11-27, 1.37).** Since 1.31 every entity name is a link, but in a table or a Gantt's left pane a link read as plain text. Those links are now deep cyan with an underline on hover and on keyboard focus; header and summary links (a page's facts line) stay text-coloured and underlined; a badge link keeps its badge look and a link is never dimmed (`web-internals.md` "Entity links").
- **Filters live in the address.** The address always holds the filters shown; a link naming a filter is shown as written and not remembered; opening a page from the menu restores what the user last set; only the user's own change is remembered (Roadmap 1.19 Q1 a, Programs 1.21 Q1; Dependencies keep theirs in the address only, as Team load did before 1.32 folded it into Teams, whose filters work the same way).
- **One staleness rule.** A Jira source is stale when its server-derived state is not `CURRENT` or its mapping does not fit; the chips, the Deviations banner, the dated "no deviations" claim, Flow's section and the plan pages' facts line ("Jira data may be out of date") all use it (1.17 Q1 and Q2).
- **A deploy notice.** The build writes its commit into `index.html`; the shell compares it with the bundle's own and shows a notice with a Reload button at the top of every page, with no way to dismiss it (1.17 Q4, Q5).
- **Dependencies page.** One list of every active link, the violated first, at most 1,000 rows, filters in the browser and the address (1.20 Q1); a row says what the caller may do (`can`) and offers "Edit..." and "Delete" only then (1.22 Q3, reversing 1.20 Q2 "read-only"). Since 1.29 the list is the Roadmap's panel; the page is gone.
- **The project page's Milestones table is removed (the user's word of 2026-11-27: "remove it, point Home's link at the Unscheduled table").** It repeated the Gantt and the Unscheduled tray and had no action of its own (1.29's table, with its Schedule/Team/Name filters, sort and remembered show/hide). Home's project "not scheduled" figure keeps `/projects/N?milestones=unscheduled`, which now brings the Unscheduled section into view and focuses it once (`projects-view.md` "The page's address words"); `?milestones=scheduled|all` is ignored. `release-history.md` keeps the 1.29 text.
- **A person's page lists what they are responsible for (the user's walkthrough item, decided 2026-11-27).** Under the name and facts line: "Teams managed", "Work streams owned", "Programs owned" and "Projects owned", each a short list of links to their pages, a count and an empty sentence ("Manages no team"). Ownership is direct, as in Home's "Only what I own myself"; a closed work stream reads "(closed)". No endpoint or filter was added: the lists are read off the plan view and the every-team read the pages already make (`web-internals.md` "People").
- **`GET /milestones` is trimmed (decided 2026-11-26, 1.30).** Removed, not deprecated (the 1.24 Q5 exception to API-VER-002 again; one client, the first-party SPA): the filters `scheduled`, `teamId`, `programId`, `workStreamId`, the sorts `rankPosition`, `projectName`, `teamName`, `startDate`, the row's `rankPosition`. An old tab's removed filter is ignored (API-LIST-004) and lists every milestone; a removed sort is `400`.
- **Teams' weeks (Team load until 1.32, then folded into Teams).** Per week, "Weeks with a warning" under the Teams table (1.21 Q4); it opens on the weeks from this week on and an "Include past weeks" switch (`?past=true`) brings the earlier ones back (1.22 Q4). **Removed in 1.36, on the user's word of 2026-11-27 ("yes, remove it and link the badges"):** it duplicated each team page's weekly load table; the Teams table's week badges now link to that table (`/teams/:id?load=overloaded|wip|nocapacity`, opened, focused, the first such week marked).
- **View validators.** Ten view reads answer a weak `ETag` and `304`; the tag is a hash of the rendered document and the caller's user id, so it cannot go stale; the two Deviations documents are left out (1.22 Q1, Q2).

### Releases

- A release is cut only on the user's word; the bump rules are `app-releases.md`. ONE changelog entry covers everything since the last release.
- **The caveat sentence.** A Jira-touching release keeps the repo's binding sentence ("Proven against a built-in Jira stub; not yet tested against a real Jira site."); the Flow line says the same of the built-in Flow stub. Both stub sentences stay in the changelog. 1.14.0 was released without the real-site check of `parent in (...)` on the user's word.
- **When the user is absent** (1.16, 1.20, 1.21 were built overnight): every question of the plan is answered with the recommended option (a), listed in the version's section of `release-history.md` for review; the user confirms or reverses afterwards.
- **The docs' sizes (decided 2026-11-27).** The release history lives in `release-history.md`, the one instruction doc without a byte ceiling: no entry is trimmed to make room. The other ceilings were re-based once after 1.34, each to its doc's size plus about 5,000 bytes (`ci.md` "Docs shape").

## Assumptions (not asked — change on request)

Taken without a question, each a one-place change. Day-precision dates; Monday–Friday working days, fixed, minus the public-holiday dictionary (0.7.0); week / month / quarter zoom (month / quarter / year on the roadmap and programs pages); EN and PL kept; the scale above. The defaults of 1.10.1 and later are in `release-history.md`, under their version.

### Defaults taken for v0.8.0

- A scheduled milestone the proposal cannot place keeps its stored dates and its load (listed as unplaced; the run repeats to a fixed point, so accepting never overloads a week through it).
- Capacity is checked per ISO week as well as per day. No toast on accept: the outcome note under the table carries the message.
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
- (D1-D4, D6, D9, D10, D13) The acknowledge's rules are `flow-sync.md` "Acknowledge" (the `TEAM_GONE` row acknowledgeable as the team's own with `sprintId: null`; hard rows; the fingerprint over `{kind, severity, detail}` without the sprint's name, so a rename in Flow does not reopen; the Jira acknowledge's protocol, whose `409 urn:astrolabe:problem:stale-deviations` is the ONE URN of both connectors; `can.acknowledge`; the two audit events; `sprintId` required-nullable in the POST) and "The team view's flag" (ONE `FLOW_CAPACITY` flag at the worst severity of the open rows).
- (D5) The listing is the Jira view's: OPEN rows by default, `acknowledged=true|false`, `all=true` or `teamId` also lists acknowledged rows; a team with an OPEN WARNING sorts first. (D7) A DISABLED connection raises no team flag while its rows list and can be acknowledged. (D11) One `CapacityAckCell` on both surfaces; the Deviations page's ONE Status select applies to both lists. (D12) An acknowledge refreshes the deviations and the plan views. (D14) Both items ship in ONE release.
- *Decided while building:* a gone team's acknowledgement does not outlive its absence; the header sentence counts "open differences", not sprints; acknowledged rows' badges are dimmed; a proposal preview's strip shows no Flow marks; the team page's Capacity vs Flow fact counts OPEN rows ("No open difference · N acknowledged", never "In line with Flow", while acknowledged rows remain).

### Defaults taken for v1.10.0

No question round; the user said "go-go".
- *Jira probe marker.* (D1) A nullable column `jira_observations.gone_probed_at` (V27), not an `UNKNOWN` reason: no enum, spec or UI vocabulary change; NULL = Jira has not answered yet for this vanish. (D2) "Answered" = 200, 404 or 403; a failure, a cut and an over-cap binding stay NULL and are retried by every later run while the sweep still judges the binding gone; at most 100 a run, **the newly flagged first, then the retries, each by binding id**. (D3) No backfill:
  a row flagged gone before 1.10 gets its first probe in the first 1.10 run (supersedes the clause the user confirmed earlier). (D4) An answer is final for that vanish; a clear and a new vanish probe afresh; the column is in no API.
- *Acknowledgement lifetime.* (D5-D9) **An acknowledgement lives only while its row is listed**; where the prune runs, the `sprintsTruncated` rule, the lock order and the audit (`flow.capacity_acknowledgements_cleared`, `acknowledgementsDeleted` on `flow.connection_deleted`) are `flow-sync.md` "The lifetime of an acknowledgement". D6's residual (a sprint brought in line and back by plan-side edits alone still read acknowledged) ended in 1.13.1 with the capacity write's prune.
- *Acknowledge all.* (D10) `POST /integrations/flow/team-bindings/{id}/acknowledge-all` is **all or nothing**, a stale or unlisted row the shared `409 stale-deviations`, a key named twice a `400` (`flow-sync.md` "Acknowledge all and withdraw all"). (D12) "Acknowledge all (N)" heads a team's list on BOTH surfaces, shown when the caller may acknowledge and at least two listed rows are open; the page's filters apply.
- *Home.* (D13) An intro line and three cards, Plan, Roadmap, Deviations, each with a real link. (D14) The only live figures are the OPEN deviation counts: "Open differences from Jira:" and "Open capacity differences from Flow:"; positive counts only; `staleTime` 60 s; a failed read is the inline `ErrorAlert` inside the Deviations card; no new endpoint.
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
