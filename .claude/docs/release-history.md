# Release history

Owns: what each version shipped, newest first: its scope, the user's answers, the defaults taken for it and what was not built. Not here: one row a version (`product.md` "Roadmap"); the decisions by topic (`product.md` "Domain decisions"); the defaults of 0.8 to 1.10 (`product.md` "Assumptions"); how an area works now (its own doc); how a release is cut (`app-releases.md`).

## Rules

- **Read one version, never the whole doc.** Nothing here is loaded by default: go to the version's heading (`### v1.26.0`) when a doc, a test or the user names a version, one of its questions (`Q`) or one of its defaults (`D`).
- **A release writes here:** its section at the top of "Versions" (what a section holds is said there). Its one-row scope goes to `product.md` "Roadmap" and the current version to `CLAUDE.md` "Product": its Roadmap line names that version alone, and the version before it joins the last range of that line (a range holds about five versions).
- **No entry is trimmed to make room.** This doc has no byte ceiling (`ci.md` "Docs shape"): it is the one instruction doc meant to grow. An entry stays one section, under the section limit.
- **A standing answer is filed by topic** in `product.md` "Domain decisions"; this doc keeps the answers that shaped one version's build and, from 1.10.1 on, each version's defaults.

## Versions

Newest first. Each version: its scope, the user's answers, the defaults that still bind and what was not built; the commits, the plans (they live outside the repository) and the test runs are in git. "No migration" means the preceding schema still applies. Every release leaves "nothing is written to Jira or Flow" true.

### v1.37.0 — the 1.35 walkthrough's five

The five "(1.35 walkthrough)" items the user promoted to `[next]` on 2026-11-27 ("go ahead with all five as 1.37"), with three answers (each the recommended option): every Gantt opens around today, else at its work; links in tables and Gantt left panes are brand cyan, underlined on hover and focus; every toolbar control takes the zoom switch's small size. A minor bump; web, e2e and docs only (the spec changes only in `info.version`); no migration.

- **Where a Gantt opens** (`timeline.md` "Where a Gantt opens"): `openScrollLeft` + `useTimelineOpen` in the shared Timeline; today at a quarter of the visible track, else 40 px before the first bar ahead (else the earliest), the pill never cut; applied once before paint and once after the narrow fit, then settled; arrivals win.
- **Toolbar** (`timeline.md` "The toolbar"): `TOOLBAR_CONTROL_SIZE` (Mantine xs, 30 px targets) on every toolbar control, Add dependency (both panels), Add period, Propose schedule and Reset order.
- **Links** (`web-internals.md` "The link look"): `.table .anchor, .timelineLeft .anchor` take the accent ink (at least 5.02:1 light, 6.83:1 dark, pinned), underline on hover and focus-visible, `LinkText` in forced colours; `EntityLink` no longer dims a link. Accepted: secondary names in a row are as cyan as the primary one.
- **Person page** (`web-internals.md` "People"): `PersonResponsibilities` from the plan view and the team options, no server change; axe scans it.
- **Proposals** (`web-internals.md`): one rule for every run on the three pages, the heading scrolled clear of the header and focused once per opening; Discard is no longer a focus target; the saved list marks the open record. Decided by the main session: fresh runs follow the same rule (they had the same bottom jump).

### v1.36.0 — less repetition, a compact page header

The user's requests of 2026-11-27 after 1.35: "remove it, point Home's link at the Unscheduled table" (the project page's Milestones table), "yes, remove it and link the badges" (the Teams page's "Weeks with a warning"), and a smaller page header (answers: the description behind an ⓘ button; titles kept, more compact). A minor bump; web, e2e and docs only (the spec changes only in `info.version`); no migration.

- **Project page:** `ProjectMilestonesTable` and its utils, locale keys and setting removed; `?milestones=unscheduled` (Home, the `/milestones?scheduled=false` redirect) focuses the Unscheduled heading once the view is read, then drops the parameter (`useUnscheduledArrival`; `projects-view.md`).
- **Teams:** `TeamLoadWeeks`, the "Include past weeks" switch and `?past=` removed; the Teams table's badges link to `/teams/N?load=overloaded|wip|nocapacity` (`useWeeklyLoadArrival`: waits for the view and the Flow section, opens the table for the visit without memory, marks the first week of that kind from this week on, else the latest before; `web-internals.md`). The server's `warningWeeks` stays (`BACKLOG.md`).
- **Page header:** `PageHeader`'s title is a compact h2 on the actions' row; `description` opens from a 24 px "About this page: <title>" popover; `facts` stay visible (a project's program, work stream and owner, a team's manager, a person's email and login, the Roadmap's read-only note, the 404's text); `printDescription` keeps an entity's own description in print (`web-internals.md` "Page chrome").
- **Tests:** Dismiss on a saved-proposal note no longer races the address transition (`useSavedVerdict` remembers the dismissed address); `useScheduleCheck`'s debounce tests run on a fake clock only.
- Decided by the main session: entity facts stay visible (the request was about the descriptive paragraph); written entity descriptions print; the Roadmap's read-only sentence is a visible fact.

### v1.35.0 — the 1.34 walkthrough fixes

The user's choices of 2026-11-27 from the suggestions after 1.34: an eye walkthrough of 1.31 to 1.34 on the sample plan, a sweep for the live-region test race, the count while only some columns are hidden, and room under the docs' ceilings (`product.md` "Releases"); then "fix the Teams cut-off, the 390px scrolling and the clipped headers" from what the walkthrough found. A minor bump; web, e2e and docs only (the spec changes only in `info.version`); no migration.

- **Teams:** a badge in a cell is at least as wide as its text (`miw="max-content"`): its label hides overflow, so its minimum width was next to nothing and the auto-layout table shrank the Overloaded and WIP columns into an ellipsis.
- **Phone width:** below a 600 px scroller the Unscheduled tray is a `ScrollRegion` and `useTimelineColumns` fits the left pane (`timeline.md` "Hidden columns"); the fit is session-only and never stored, the control describes the drawn pane, a column the viewer ticks is drawn and the pane gives way. Decided: an untick of a column drawn only because it was asked for stores nothing; a drag cannot leave the tray below 600 px (Schedule is the way).
- **Choose columns** says "N hidden" (in its name too, EN/PL plural keys); the Gantt's Operations header is `iconOnly` (its text for assistive tech only); Prioritization's Flags column is 120 px.
- **Docs:** the release history moved here; `CLAUDE.md`'s roadmap line is in ranges; every ceiling re-based to the doc's size rounded up to a thousand plus 5,000.
- **Tests:** two unit tests no longer race `useLiveText`'s status region; one no longer lets a read escape its fetch stub after `afterEach` (the `localhost:3000` noise in every run).
- Not built (`BACKLOG.md`, from the walkthrough, for the user to triage): where the Gantts open, link styling in tables, toolbar text sizes, the person page's content, opening a saved proposal.

### v1.34.0 — collapsible Gantt columns, Scroll to today

The user's request of 2026-11-27: "In all Gantt charts, can we: 1. make all the columns on the left (before the Gantt bars), EXCEPT the first (name), and operations (three dots), collapsible/extendable? 2. add a button 'scroll to Today'".
Built overnight on top of 1.33.0, a minor bump; web and e2e only (the spec changes only in `info.version`); no migration; 1.31.0 to 1.34.0 were released and deployed on 2026-11-27 (tags v1.31.0 to v1.34.0).

- **The user's answers:** collapse BOTH ways (a toolbar toggle for every extra column and a menu for single columns); remembered per page in this browser, expanded on a first visit; Today renamed "Scroll to today" with a target icon, same place and behaviour.
- **Defaults taken overnight:** D1 Roadmap Prioritization keeps its rank and project name (the mode's subject and the grid's row header); only Flags hides. D2 a collapsed column is removed and the pane narrows, no stub. D3 the toggle collapses and restores, and the per-column pick survives a collapse. D4 one control on all four Gantts: a "Hide columns" / "Show columns" button (`aria-expanded`, never `aria-pressed`) joined to a "Choose columns" checkbox menu (`timeline.md` "Hidden columns").
D5 print is what is on screen ("Print and export" in `timeline.md` stays deferred). D6 the project page's Team column hides; its bar still names the team.
- **Smaller defaults:** nothing is written to the browser until the user acts; a hidden Slack or Flags stays hidden when its column next appears; the control stays enabled during a save or a preview; the trays keep their columns; phones start expanded; Scroll to today is disabled outside the range, with a title; the name, the Roadmap's rank and project, and Operations are never offered, even if a wrapper marks them.
- **Decided while building:** a hidden column is a hole, never a re-index; a whole-project row of the critical chain on the team page gained "Open project" in its menu, its Project cell having been the only way on; the Roadmap e2e drag centres its rows, because the toolbar now wraps.
- Not built (`BACKLOG.md`): opening collapsed on a narrow screen, the trays following them, a hint while only some are hidden, a hideable rank, a print with every column, the account menu's language and theme as `Menu.RadioItem`.

### v1.33.0 — schedule proposals on the Gantts

The user's question of 2026-11-27, "What's the point of 'Schedule proposals'? Shouldn't proposal be showed on Gantt screens (for program or project)? It would be much more useful there.", answered "I agree, queue as the increment after the Team load fold". Built overnight on top of 1.32.0, a minor bump; no migration; 1.31.0 to 1.34.0 were released and deployed on 2026-11-27 (tags v1.31.0 to v1.34.0).

- **The user's answers:** dashed bars on the project page and the Roadmap overview (the project's end before and after); the Schedule proposals page REMOVED, its saved proposals moved to the Roadmap; the team page keeps its own; EVERYONE may preview; accepting moves only the teams the caller manages, ADMIN all.
- **Defaults taken overnight:** D1 the project page runs the teams of the project's active milestones (others fixed; no dependency closure). D2 the overview runs the teams of the projects shown (nothing narrowed = every team with a milestone); over 50 teams Propose is disabled. D3 the accept's optional `acceptTeamIds` (absent = the whole run, the 1.8 contract) is what the guard reads; other teams' items are skipped NOT_ON_TEAM. D4 Save stays ADMIN or the manager of every run team.
D5 the overview only, not Prioritization. D6 `CrossTeamProposal.projects[]` (the projects whose span moves) takes the stored format to 3; older saved rows read UNREADABLE. D7 the project page accepts only this project's moves, ticked by default. D8 no rate limit, REVERSED on the security audit: a per-user bucket `schedule-proposal-run`, 30 a minute, on the run and the accept (the check stays unbucketed).
- **Smaller defaults:** saved proposals are a collapsible "Saved proposals (N)" under the overview timeline, remembered (`roadmap.savedProposalsOpen`), a saved run at `?mode=overview&proposal=<id>`; Save on the overview only; dashed bars always show the whole proposal; a project-page preview locks only date writes.
- **Decided while building:** the staleness sweep exempts only the accept teams' items; the per-team proposal's 403 stays, a product rule; a saved run's `projects[]` is as of the save; dependencies stay editable (an edit makes the accept stale); a failed rights read degrades to a preview; a `?proposal=` address beats the remembered program pick, and a saved run opened from the list keeps the pick, with a note when moved projects lie outside it;
one partial accept makes a saved proposal CHANGED for the other managers; a saved CURRENT proposal's `can.accept` is ADMIN or a manager of one of its teams; the project page's section sits after the tray, its end sentence conditional ("If every team's moves are accepted…"). A manager can no longer run exactly their own two teams with the rest fixed, except from a project or program whose teams are those.
- Not built (`BACKLOG.md`): choosing the run's teams, a dependency closure, a preview in Prioritization, bars that follow the ticks, a preview for non-managers on the team page, the kernel off the request threads, a saved run's `projects[]` recomputed at read.

### v1.32.0 — Team load folded into Teams

The user's question of 2026-11-27, "Does 'Team Load' add any value? We see how teams are loaded in team view", answered "Yes, fold" and, asked how, "One table". Built overnight on top of 1.31.0, a minor bump; the API only gains `description`. No migration. 1.31.0 to 1.34.0 were released and deployed on 2026-11-27 (tags v1.31.0 to v1.34.0).

- **The user's answers:** Team load is folded into Teams as ONE table (everyone reads, ADMIN writes) with Team load's columns, the warning and past-weeks filters and "Weeks with a warning" below, not tabs; the admin row actions stay; Home's team figures open Teams with the filter; the nav leaf goes; `/team-load` redirects as the 1.29 pages did.
- **Defaults taken overnight:** D1 the page reads only `GET /views/team-load`, which gains `description`; the paged `GET /teams` stays for pickers. D2 no paging: the view's 200 rows and a "first N teams" line. D3 the name filter is page state, applied as you type, not in the address, not remembered. D4 the description is a dimmed line under the name. D5 only the name sorts, its direction remembered.
D6 Home's "N not scheduled yet" opens plain Teams. D7 the `teamLoad.*` keys, `api/teamLoad.ts`, `teamLoadFilters.ts` and `TeamLoadWeeks.tsx` keep their names. D8 `team-load.spec.ts` and its scenario stay, retitled. D9 the pending-filter-vs-delete race e2e moves to People. D10 no manager reads a dimmed "No manager".
- **Decided while building:** the name filter matches names only (not descriptions or managers); "Showing N of M teams" counts the rows held (at most 200); the Operations column shows for ADMIN only; "Show every team" clears Name and Show and keeps "Include past weeks".
- Not built (`BACKLOG.md`): a sort by a load figure; a filter for teams not scheduled yet; a server-side search past 200 teams. Gone: the page, its nav leaf, the Teams pager, the remembered name filter (`teams.paging`, `teams.filter.name` linger unused).

### v1.31.0 — names as links

The user's request of 2026-11-27: wherever a work stream, program, project, milestone, team or user is named, the name links to its details (`web-internals.md` "Entity links"). Built overnight; a minor bump, the API only gains ids. No migration.

- **The user's answers:** a work stream or program opens the Roadmap overview narrowed to it (not the Plan's "Show only this"); a milestone its project page with the row marked and focused; an owner or manager the person page, a login on an admin screen its edit page, "saved, taken, linked, acknowledged by" the login's person when it has one; a second name in a timeline cell is a pointer link plus an "Open ..." item in the row menu (one tab stop per cell stays).
- **Defaults taken:** the saved-proposal document's stored format goes 1 to 2 (it embeds the proposal end, now with `projectId`); a proposal saved before reads as unreadable, the stack had none; the Plan's breadcrumbs stay Plan navigation (a control); `?milestone=` leaves the address after arrival; links keep the theme look (no underline at rest), underlined inside a sentence; the work stream narrowing lives in the address only, never remembered; an overview node row gained a menu; the Plan tree's disclosure button is chevron-only.
- Not linked: a page's own subject, names in dialogs or on other controls, entities gone from the plan, a name whose id is unknown.

### v1.30.0 — the 1.29 follow-ups

The seven `[next]` items of 2026-11-26; a minor bump. No migration.

- **The user's answers:** `GET /milestones` loses every unused filter, sort and row member, not deprecated first (an exception to API-VER-002); sortable headers at the theme's 12 px; a milestone hit is a dimmed line under its project.
- **Defaults taken:** under forced colours a tinted bar keeps its colour, like the swatch; the panel's arrival focus waits for the view; the picker asks from two characters, the first 100 hits.

### v1.29.0 — one Roadmap, a Projects view, team colours

Built overnight on 2026-11-26 from the user's answers of 2026-11-25; a minor bump, the API only gains `colour` on teams. Migration V35. Designs: `team-colours.md`, `projects-view.md`, `web-internals.md` "Programs" (the modes).

- **The user's answers:** a fixed, contrast-checked palette of twelve (a new team gets the least used; sharing allowed, with a hint); the Milestones filters kept as a table on Projects; the dependency list hideable beside the Gantts, add, edit and delete as before; the Roadmap opens in the mode last used here (Prioritization at first) and names it in the address.
- **Defaults taken:** the dependency panel on the Roadmap in both modes, every dependency, as Home's count does; only milestone bars take a team colour; ADMIN edits it, a PUT without one keeps it; `/projects` reopens the last project viewed; Milestones table: Schedule in the address, team and name page state; `/programs`, `/milestones`, `/dependencies` redirect; every endpoint stays.
- A mode switch drops the Prioritization-only filters and the program pick (a link-only pick is not carried across); the row menu's "Dependencies" narrows the panel to that project alone; the cross-project milestone list is gone (`GET /milestones` trimmed in 1.30).

### v1.28.0 — the Plan page as one tree

Built overnight on 2026-11-26 from the user's answers (`plan-tree.md`); a minor bump, the API only gains members. Migration V34 (the two order tables).

- The design and its defaults: `plan-tree.md` (the order, its PUTs) and `web-internals.md` "Plan"; pins and folds are per browser, the order is shared (also on the Programs page).
- Re-arranging is refused while a search, the owner filter or Show only this hides part of a list.
- Verified on a throwaway stack with the sample plan (light, dark, phone, print, forced colours) and the full e2e suite.

### v1.27.0 — finding and linking work

Built overnight and released on the user's word on 2026-11-25; a minor bump, the API only gains members. No migration.

- `GET /milestones` gains `programId`, `workStreamId` and two sort keys (all removed in 1.30); the plan view's project gains `can.createDependency` (a hint equal to the guard, `authorization.md` "Dependencies"); `GET /views/team/{id}?criticalChain=true` carries the chain, at most 100 members and 500 links (`planning-model.md` "The critical path").
- The e2e rank test appends two throwaway projects to the global ranking (the plan had meant none to); U4 cannot be shown without ranked projects.
- Measured: `timeline.md` "Measured figures"; the five untested cells are decided (three scale tests, two design notes); no stop line was crossed.

### v1.26.0 — saved proposals, frozen links and capacity

Built 2026-11-23 to 11-24, released overnight on the user's word; a minor bump, the API only gains members; it carries the 1.25 review's fixes.

**Scope:**
- Saved proposals (V32: `scheduling.md` "Saved proposals"), links and capacity frozen in baselines (V33: `planning-model.md` "Baselines"; older baselines read "not captured") and the paged `GET /work-streams` and `GET /programs` (`planning-model.md` "The picker and milestone lists"), with the bind dialog's program picker searching the server.
- **The cross-team run re-places only stale teams:** a team is placed again only when a team with a link into it changed (wire-identical; `scheduling.md`).
- **Technical:** every instruction doc under a byte ceiling (`ci.md` "Docs shape"); nine main files split below 360 lines; the unit tests' sleeps cut. The CI budget re-baseline (G5) is its own commit.

**Upgrade effect:** V32 and V33 are additive (a table, two frozen tables, two nullable count columns). A baseline taken before 1.26 has null counts and reads "not captured", never "no changes".

**The answers (the user's, 2026-11-23):**
- Q1 (a) every signed-in user may read a saved proposal. Q2 (a) the newest 20 are kept, the oldest dropped on the 21st save. Q3 (b) the wider option: the comparison page AND the team page's "was" capacity and the project page's "new since the baseline". Q4 (a) the bind dialog's program picker over `GET /programs`; work streams stay API-only.
- Q5 and Q6 were not asked; defaults: (a) the CI re-baseline runs last on the then-last ten green master runs, (a) the byte ceilings become limit 9.
- The 1.25 review's call: an incomplete Flow sprint snapshot stays listed with a neutral marker on the Roadmap and the team page.

**Defaults taken for v1.26.0:**
- A save is not plan state: no plan lock, no revision bump. Any save removes the globally oldest saved row (Q2); the delete guard (ADMIN or the manager of every stored team) stops a targeted delete only. The save has its own bucket of 10 a minute per user.
- A saved run is acceptable only while CURRENT, with `can.accept` and `asOf` equal to today; "Propose again" shows with `can.delete`.
- The team overlay's "was" capacity is `baseline.capacity {captured, periods}` inside the existing overlay; `newSinceBaseline` is absent when links were not captured (unknown, not "all new").
- Links compare as added, removed or changed (type, lag); capacity as date ranges of the figure in force, so splitting a period in two equal ones is no change. A capacity-only change (team data, outside the plan revision) leaves the comparison's `revision` equal, and the page's "plan has not changed" note says the capacity has.

### v1.25.1 — a new logo

Released on the user's word (2026-11-23), a patch: the logo and favicon redrawn (a mariner's astrolabe with a wind rose), built outside the planned-release workflow; no migration, endpoint or wire change. It was on `master` before the 1.25 review's fixes, so those ship as the next patch.

### v1.25.0 — reliability and navigation

The quality checkup adds V31 to track whether a Flow team's sprint snapshot is complete. Capacity import and comparisons wait for a complete refresh,
and a partial refresh preserves sprint acknowledgements. Project fields and target dates can be replaced together with `PUT /projects/{id}/details`.
Paged registry reads share a database snapshot, and successful creates return a projection taken within the write transaction.

The app shell groups work by task and Home separates plan figures, risks and actions. Very wide timelines window their date headers.

Built outside the planned-release workflow (PR #41) and released 2026-11-22, a minor bump; the questions put to the user were not recorded here.

**On the wire:** `PUT /projects/{id}/details` (the fields and the target window in one write); `truncated` on `GET /schedule-proposals/teams` (at most 1,000 teams, ordered by the accent-folded name); `sprintsComplete` on the capacity-import preview. **Upgrade effect:** V31 starts every mirrored Flow team incomplete, so its comparisons and capacity import wait for the next complete run of its connection.

### v1.24.0 — what shipped

A technical release, built and released on the user's word 2026-11-15; a minor bump (the API removes a member). No feature, migration (V30 stays the last), endpoint, audit event, Jira or Flow call, or dependency.

**Scope:** no behaviour change (`ci.md` "Docs shape" and the two CI forks; the contract is the spec).

**On the wire:** the items of `GET /views/deviations` no longer carry the deprecated item-level `acknowledgement` (Q5); each line's own, the filters, the counts and the acknowledge routes are unchanged.

**The answers (the user's, 2026-11-15):** Q1 (a) reword the lines that quoted a real installation's figures; Q2 (b) restructure all nine large docs plus the guard ("Rules first"); Q3 (a) two forks in CI, find why vitest is slow, then re-baseline; Q4 (a) no implicit `8086`; Q5 (a) remove the deprecated item-level `acknowledgement` now; Q6 all four refactors ("Build all of it").

**Defaults that still bind:**
- Docs: history is deleted, not archived (`ci.md`); `README.md` and `BACKLOG.md` are outside the guard.
- Spec: a nullable enum used twice is a `Nullable<Name>` twin; `ProblemDetail.type` stays a string listing every slug; `SyncFailureCode` is declared in the spec only (`sync.md` "Failure codes").
- Code: a split keeps ONE public service; "shared" means identical after renaming the connector, never a registry or a `kind` switch.
- e2e: all four `E2E_*` URLs required, none defaulted; the flaky list never gates (`retries` stays 2).
- CI: budgets are re-baselined from the last ten green master runs; two forks stay only if the first five master runs are 20 % under the one-fork time; no vitest shard.
- A release that changes the API contract is at least a minor bump.

**History kept here:** the item-level summary was deprecated since 1.12 and read by no client; its removal is an accepted exception to API-VER-002 and API-VER-004 (`product.md` "The Jira sync"), and the changelog names it. **Not built:** the checkup's lower tiers, each a `[new]` BACKLOG line marked (1.24); the CI budgets wait for ten green master runs.

### v1.23.0 — what shipped

Released on the user's word (2026-11-15), a minor bump (a new configuration key, a new flag kind, new members on Home's rows). The user picked five `BACKLOG.md` items and was PRESENT. No migration, endpoint, write, audit event, rate bucket, Jira or Flow call, stub data or dependency. What binds: `persistence.md`, `security.md` (the limit), `authorization.md` (the typed `500`), `planning-model.md`, `timeline.md` (the flag, Home's owner-chain rows).

**The answers:**
- Q1 (a) one statement limit of 15 seconds on the whole pool, 0 = off, covering the views and everything else.
- Q2 (a) a project gets one flag per team, naming the team and the number of milestones (the rule is `product.md` "The Flow sync"). Reverses 1.9 Q3 ("team view only") in part.
- Q3 (b) "Yours" lists everything under a work stream or program you own, each row names its owner, and a switch "Only what I own myself" (off by default, remembered in this browser) narrows both tables to the rows you own yourself. Reverses 1.18 Q2a (direct ownership only) in part.

**Defaults taken:** the 15 s value is whole seconds, 0..300, boot-validated (the test harness boots with 60 s); the two `sync` readers assign `queryTimeout` only when positive and the telemetry reads keep their own budgets; a cancelled request's EARLIER committed step stays (a create's re-read runs in a second transaction, so a cut re-read leaves the row and a retry may meet a `409`); a cancelled access-check read answers the typed `500`, never a `401`;
days compare as calendar days, both ends inclusive; the Roadmap and Programs show the flag without a "Flow data may be out of date" note.

**Not built:** each a `[new]` `BACKLOG.md` line (Q1b, Q2b, Q2c, Q3c, and what a frozen database or the browser's own timeout would need).

### v1.22.0 — what shipped

Released on the user's word (2026-11-15), a minor bump (new headers, a new page action): view validators that cannot go stale, dependencies edited from their list, the team load from this week on. The user picked five `BACKLOG.md` items, was PRESENT, answered Q1-Q4 with (a) and chose to BUILD the view ETags. No migration, endpoint, write, audit event, rate bucket or Jira/Flow call. `GET /views/dependencies` rows gain `can{edit, delete}`;
`GET /views/team-load` gains `currentWeekStart`; ten view GETs gained a request header, a response header and a `304`.

**The answers (all (a)):**
- Q1 the validator (`product.md` "Home and the lists"); a `304` saves the transfer and its compression, NOT the view's work.
- Q2 ten reads (Plan, Home, Team load, Dependencies, Roadmap, Programs, a project, a team, a baseline comparison, the Jira links), not the two Deviations documents.
- Q3 each Dependencies row says what the caller may do (`can`), the project page's own flags.
- Q4 "Weeks with a warning" starts at the server's current week and an "Include past weeks" switch (`?past=true`) brings the earlier ones back.

**What binds:** `security.md` "Caching", `planning-model.md` "View validators" and "The dependencies view".

**Not built** (each a `[new]` `BACKLOG.md` line): the pre-check (Q1b, Q1c), validators for the two Deviations documents, a time zone for "this week", the weeks without capacity as ranges (Q4b). **Recorded as risks:** the project page's possible focus race, the Dependencies page at its 1,000-row cap in a real browser.

### v1.21.0 — what shipped

Released on the user's word (2026-11-15) right after 1.20.0, a minor bump: filters, Team load per week and a slimmer Dependencies document. The user picked five `BACKLOG.md` items and went away: **the user was ABSENT** and every question took the recommended option (a). No new endpoint, parameter or migration;
`GET /views/team-load` gained `warningWeeks` per row and `warningWeeksTruncated` (additive); `GET /views/dependencies` names its ends once (breaking for the page only: the endpoint was unreleased).

**The answers taken (all (a)):**
- Q1 the Programs pick follows the Roadmap's 1.19 rule unchanged.
- Q2 a "Flag severity" select (Any / Warning / Info) and an "Unranked projects only" switch beside "Flagged projects only", in the address and remembered; Home's "N unranked" links to `?unranked=true` and the warnings and infos badges each open their own severity.
- Q3 a Project select fed by the plan document with the chip kept, and the Team select reading every team (100 a page, to the end), shared with the Deviations panel; an id the lists lack shows as "Team N" / "Project N".
- Q4 a second table "Weeks with a warning" under the Team load table: one row per team and overloaded or over-WIP week with the team page's own cells, following the "Show" filter, at most 2,000 weeks in team order, oldest first.
- Q5 the slimmer document built last.

**Defaults taken:** the address spellings and the team options (`listEveryTeam`, at most 20 pages) are `web-internals.md`'s; the dependency list resolves names in its query function, not in `select` (`web-internals.md` "Dependencies"), and a document naming something it does not hold is a `MalformedAnswerError` (`web/CLAUDE.md` "Query retry").
**Not built:** the alternatives of Q2b to Q4c, each a `[new]` `BACKLOG.md` line; warning weeks from today and the focus after ranking the last unranked row were built in 1.22.

### v1.20.0 — what shipped

Released on the user's word (2026-11-15), a minor bump: Dependencies, plus seven small fixes. The user picked the theme and items 1-8 on 2026-11-14 and was **ABSENT**: every question took the recommended option (a). One new read, `GET /views/dependencies`; no migration, write, audit event, rate bucket or Jira/Flow call.

**The answers taken (all (a)):**
- Q1 one list of every dependency (`product.md` "Home and the lists"), a page "Dependencies" under Planning.
- Q2 read-only, each end names its project whose page edits the link (1.22 built edit and delete in the list).
- Q3 "Dependencies" in the Roadmap's and Programs page's project row menus, "N dependencies" on the team page's facts line, the red conflicts badge opening the violated ones, no bar renamed.
- Q4 evidence first for the server gate beside the stack. Q5 the stricter axe sweep fixes a missing name or role and records (does not patch or waive) a contrast finding.

**What it delivers:** the dependency list for everyone (a page until 1.29, then the Roadmap's panel: `planning-model.md` "The dependencies view"), the Jira and Flow writes that mark Home stale (`web-internals.md` "Home") and the deploy check on the login pages ("The deploy check"). The server gate runs beside the compose stack (`testing.md`).
**Defaults taken:** a view, not a paged list (the order and the status are a kernel's result); a lean five-statement loader; filters only in the address; the Roadmap's item on every project row, with no count.
The `projectId` filter on `GET /milestones` already existed since 1.19 (the predecessor picker stays plan-wide on purpose). **Not built:** each a `[new]` `BACKLOG.md` line (the alternatives of Q1b to Q3c).

### v1.19.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump: Home's figures lead somewhere. The user picked five `BACKLOG.md` items and answered Q1 to Q4 with (a), **the user being present**. Three filters and two sorts on `GET /milestones`, one new read `GET /views/team-load`; no migration, write, audit event, rate bucket or Jira/Flow call.

**The answers (all (a)):**
- Q1 the Roadmap's filters live in the address by Flow's rule (see `product.md` "Home and the lists").
- Q2 a **Milestones** page under Planning: every milestone, filtered by schedule, team, project and name in the address only (a table on Projects since 1.29); its not-scheduled count was exactly Home's.
- Q3 a **Team load** page under Planning: every team with its manager, milestones, how many are not scheduled, its overloaded weeks, weeks over the WIP limit and weeks without capacity, filtered by warning in the address; its totals and Home's two team counts are one function over one loader; at most 200 rows with `truncated`.
- Q4 Home's read (`GET /views/home`) is kept for 60 seconds like the two deviation counts: the user's own writes still show at once, another person's change or a Jira/Flow observation after at most a minute.

**Also:** Home's figures became links (`product.md` "Home and the lists"). **Defaults taken:** `GET /milestones` grows rather than a new list; zero is not a claim;
a team with work and no capacity can never be overloaded, so Team load says so in gray. **Not built:** a rank sort on Milestones (`BACKLOG.md`); the violated-dependency list, address filters and weekly Team load came in 1.20 and 1.21.

### v1.18.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump (a new read and a rebuilt Home): the plan's figures and what is yours. The user picked the `BACKLOG.md` item "Home: figures of the plan and "my" items (1.10)" and answered Q1 to Q5, **the user being present**. **One new read, `GET /api/v1/views/home`** (any signed-in user; no parameter, write, migration, Jira/Flow call, audit event or rate bucket).

**The answers (2026-11-14):**
- Q1 **(b)** the plan figures plus the whole plan's capacity (teams with an overloaded week, teams over the WIP limit): the one answer off the recommended option, and it adds a team loop to every read.
- Q2 to Q5 **(a)**: "yours" is what the person linked to the login owns directly plus the teams that person manages (widened in 1.23 Q3); a managed team's row carries its capacity warnings, its Jira deviations and its Flow flag; a login without a person gets one plain sentence; worded lines and badges inside the three cards, with "Yours" as a section under them.

**Defaults taken** live in `planning-model.md` "The home view" (who "me" is, the plan block, the conflicts count, the four capped lists) and `web-internals.md` "Home" (the failed reads).
**Not built:** each a `[new]` `BACKLOG.md` line; a page for the overloaded teams, a URL for the Roadmap's filters and a list of every unscheduled milestone came in 1.19, "everything you may manage" in 1.23.

### v1.17.0 — what shipped

Released on the user's word the same day (2026-11-14), a minor bump (a new menu item, a new notice and a changed warning rule): follow-ups. The user picked five `BACKLOG.md` items and answered Q1 to Q5 with (a), **the user being present**. **Web-only**: no server file, route, spec change or migration; the one write a new path leads into is the existing `PUT /milestones/{id}/schedule`.

**The answers (all (a)):**
- Q1 the server-derived state is the one staleness rule everywhere (`isStaleSource`: not `CURRENT`, or the mapping does not fit), and the banner keeps skipping a disabled connection while the chips count one; the Deviations banner now also shows under STALE, during a first run and during a retry after a failure, and the dated "no deviations" claim is withheld under STALE.
- Q2 one dimmed sentence "Jira data may be out of date" on the facts line of the Roadmap and Programs.
- Q3 "Schedule on Jira's dates" is one click on the dashed row's menu, through the page's one write path, only for a caller whose `can.schedule` allows it and never while a proposal previews.
- Q4 and Q5 the deploy notice (`product.md` "Home and the lists"; the commit is in `<meta name="astrolabe-build">`). Also: the critical-path pick is announced once per target.

**Defaults taken:** the Deviations row's "· stale" mark keeps its own rule; the menu item shows on the dashed row and the baseline's "unscheduled since the baseline" row, left out when Jira's two dates are reversed, with no pre-check of working days; the deploy check is `web-internals.md` "The deploy check" (it never reloads by itself, and a rollback prompts too).
**The deploy check's limits** (more in `web-internals.md`): a tab open across the 1.17 deploy needs one manual reload; an intermediary that caches `index.html` but not deep links could show a notice a reload does not clear.
**Not built** (each a `[new]` `BACKLOG.md` line): Q3b, Q3c, Q4b, the plan pages' line narrowed to the projects on screen, the disabled connection's banner and chips, the dated claim blinking to "so far" on a refresh.

### v1.16.0 — what shipped

Built overnight on 2026-11-14 (four `BACKLOG.md` items the user picked on 2026-11-13) and released on the user's word the same morning, a minor bump. No migration, Jira or Flow call, route, rate bucket or audit event. Delivers: an unscheduled milestone whose Jira item holds both dates gets a dashed, read-only timeline row on the project and team pages (or its Jira bar on the baseline's "unscheduled since the baseline" row);
the timeline views' `jiraSites[]` carry the connection's `state` and `mappingOk` and the project and team chips add "Jira data may be out of date" while a site behind them is not `CURRENT` or its mapping does not fit; a folded program or work stream on the programs page shows one rolled-up arrow per pair of shown rows (END to START, red when any folded link is violated); the programs page shows the critical path to a picked project (`GET /views/programs?criticalPath=N`).

**Q1 to Q5 were not put to the user before the night: the build ran on the recommended option of each** (Q1 the chip's rule is the server-derived site state, wider than the Deviations banner's, which 1.17 then unified; Q2 the qualifier shows at any count; Q3 every tray milestone with both Jira dates while "Jira dates" is on; Q4 a folded row stands for the chain project, nothing opens on its own; Q5 a rolled-up arrow counts every link, project-to-project ones included).
**Defaults taken:** one row per tray milestone, the baseline idiom exactly; the wire carries the state, not a verdict, through `planning`'s own `JiraSiteState` mirroring `sync`'s names (pinned by a test); a client-side fold of `links[]`, no `programLinks[]`; the target is page-local; a deleted or unknown target is the roadmap's plain `400`.
**Not built:** each a `[new]` `BACKLOG.md` line; scheduling a tray milestone from its Jira row came in 1.17 and a text equivalent of the arrows in 1.20.

### v1.15.0 — what shipped

More ways into the rooted import and a slimmer Jira payload (six `BACKLOG.md` items approved on 2026-11-13; built overnight, released on the user's word), a minor bump. No migration, no new Jira call, JQL or field, no rate bucket, no audit event. Delivers: the rooted import starts from a linked project's row on the Plan page and from the connection page's links list; the Plan page reads the narrow `GET /views/jira-links`; the preview suggests a link for a renamed item;
the Jira blocks of the timeline views are slimmer.

**The answers (all four on the recommended option):**
- Q1 a row that would land outside the root is skipped for **everyone** (one kernel rule, `OUTSIDE_ROOT`; an administrator or the stream's owner no longer re-homes those milestones from this dialog, they import from that project).
- Q2 the **strict word match**: the same words with case, accents, punctuation and order aside; the longer name may only add words; the shared words make up at least half; numbering words equal; unique both ways. A replaced word or a typo is still previewed as new.
- Q3 a suggestion is confirmed with **"Link instead", then "Preview again"** (the preview stays the exact picture of what Import will do).
- Q4 **all three cuts** of the Jira blocks: a flag's null members absent, a flag's evidence without the repeated severity, an evidence detail's null members absent (also on `GET /views/deviations`).

**Defaults taken** (`jira-sync.md`): the links view is open to any authenticated user, discloses nothing new, is parameterless and unpaged (2,000 links, `truncated`), has no `revision` and no `can`, and the Plan page asks it on every visit; a project row's entry is gated on `can.createMilestone` rather than `can.edit`.
A suggestion attaches only to a CREATE row under an existing plan item (or a program under the picked stream); ambiguity means none, and the server honours a confirmed `matches[{jiraId, nodeId}]` entry only when it equals its own suggestion recomputed under the plan lock (stale: `CHANGED`).

**Not built:** each a `[new]` `BACKLOG.md` line (a tab left open across a deploy came in 1.17).

### v1.14.0 — what shipped

The import from a linked node (the user's request of 2026-11-12), released 2026-11-13, a minor bump. No migration. An import can start from a linked program or project and reads only what Jira lists under it, with the same preview, apply, filter and guards.

**The answers:** Q1 projects AND their milestones, all ticked as today; Q2 the linked node's owner chain or ADMIN may start it; Q3 the Plan page's program menu plus a button on a linked project's page; Q4 the real-site check of `parent = <key>` (ledger A18) NOT done, released on the stub caveat; Q5 the filter as today ("Leave out done items" on, 365 days).

**Defaults taken** (`jira-sync.md`):
- An optional `root {level, nodeId}` on the existing import endpoints (no new endpoint); the children are read by numeric id; the root takes no preview row; a rooted import lands under the root and never creates a program; defaults must stay under the root.
- An unreadable or foreign root answers `409` `jira-root-unusable`; a rooted preview is audited (`jira.import_previewed`); a gone program link says so up front.

**Also in 1.14:**
- *Coverage summary:* the connection page's table counts, per mapped level, the issues in scope, linked, open and unlinked (`GET …/coverage`, ADMIN, counts only; `jira-sync.md`).
- *A project's target window from Jira* (reverses 1.2 decision C): "Copy Jira's dates" gives a project the import CREATES the window of its level's mapped dates, both or neither (else the info `TARGET_NOT_COPIED`); nothing else is touched.
- *Overnight extras:* a per-row owner in the import (`overrides.ownerPersonId`); the deviation `CHILDREN_OPEN` (INFO, milestones only: the plan's end is before today and some of the bound epic's children are open; acknowledgeable, reopens when the counts change; may fire beside `PROGRESS_MISMATCH`, about a different fact); the `useDialogFocus` fix (no pull back once the user moved to another row).

### v1.13.4 — what shipped

The import preview's search (the user's request of 2026-11-12: cherry-pick an item by id or text), a patch bump: web only, no migration. A box above the preview table hides rows by a case- and accent-insensitive substring; its mechanics are `web-internals.md` "The preview search".

### v1.13.3 — what shipped

The overnight batch (eight `BACKLOG.md` items the user chose, 2026-11-11), a patch bump; no migration; additive members only (`POST /users` `alsoCreatePerson`, `personId` on every user read, `DeviationJira.previousKey`, a nullable `JiraImportItem.issueKey`). Shipped: a new login can create its linked person in the same transaction; the roadmap's flag panel filters All / Warnings / Infos; a moved Jira item shows "was OLD-1"; the 1.13.2 audit's LOW-1;
a capacity write locks the team's binding row before the team and prunes the acknowledgements in its own transaction; no `X-RateLimit-*` header on admitted answers (`Retry-After` only on a 429); the image's `apt-get update` fails when an index cannot be fetched; `checkVerificationMetadata` fails `check` on a superseded entry.

**Defaults taken** (the overnight rule): the "Also create a linked person" switch is ON by default (the request default stays false); the severity filter is the roadmap's only; LOW-1 conceals a redacted row's key, id and parent for a non-admin under an active filter (one residual, a lone issue's group count, is in `authorization.md` and `BACKLOG.md`); a database failure in the capacity prune aborts the write with a `500`.

### v1.13.2 — what shipped

The Jira import's filter (the user's request of 2026-11-11: leave out done items and items updated longer ago than a configurable number of days), released on the user's word, a patch bump: no migration; the additive `filter` request member and two row infos. A Jira project with more than 2,000 items at the mapped levels could not be imported at all (the browse stops at 2,000).

**The answers:** Q1 the filter narrows EVERY mapped level inside the search query; a left-out direct parent of a read item is fetched by id and kept (`KEPT_AS_PARENT`; at most 200 reads a browse, past that the preview is `truncated`); a parent answered `404` skips its child (`PARENT_UNREADABLE`), any other failure is the `502` (`jira-sync.md`). Q2 the filter is set per import in the dialog (Leave out done items on, Updated within 365 days, 1..3,650, empty = no limit), nothing stored. **Only the import reads through the filter** (Refresh,
Deviations and the roll-ups read everything). **Defaults:** the window is sent in minutes; the preview does not count what was left out; the stub does not evaluate the filter (the isolated `IMF` project proves the by-id read and the `404`); `jira.import_applied` carries `excludeDone` and `updatedWithinDays`; ledger rows A16 and A17 stay stub-only.

### v1.13.1 — what shipped

The fixes batch (the `[next]` items promoted 2026-11-11), a patch bump: every item is a fix or hardening; no migration. **The answers:** the proposal's accept **looks again** instead of refusing (a changed holiday dictionary refuses only when it changes a date being accepted; otherwise the same 409 `stale-scope`); **Refresh now** rides a per-user `sync-run` bucket, **10 a minute**; the verification-metadata prune is included.

**Also shipped:** a capacity write (a manual period POST, a changed PUT, a DELETE, the import apply) clears the capacity acknowledgements of the sprints it brings in line, after its commit, through the `teams/` listener seam (own transaction, binding row first; one audit vocabulary, `via=capacity`). **Upgrade note:** a proposal open during the upgrade carries the old `scopeHash` layout and is refused once (409 `stale-scope`), then proposed again by the page.

### v1.13.0 — what shipped

The Jira tail (five items promoted 2026-11-11, plus the moved-out e2e), a minor bump; **V29** `jira_observations.gone_probed_key` and **V30**, which drops V22's `jira_bindings.ack_*` (1.11 and older can no longer run on the schema; 1.12 can). **The answers:** D3 the binding's key follows the key the gone probe's 200 carries, and a key inside the connection's project keys reads `NOT_LISTED`; D4 the header splits the gone total (`totals.stillInJira`, "N still in Jira, out of scope");
D5 the V22 columns are dropped now. **Defaults** (`jira-sync.md`): a readable gone item is asked again once per `jira.censusHours` and on Refresh now; an in-memory back-off (`GoneProbeDamper`) rotates the retry order. After the security audit: the key pattern on the three response key members, `isInScope` refuses a non-key.

### v1.12.0 — what shipped

The Jira deviation polish (three items the user promoted on 2026-11-11; released on the user's word), a minor bump; **V28** `jira_deviation_acknowledgements`. **The answers:** Q2 a milestone's team manager may acknowledge and withdraw every deviation of a milestone binding of their team, whoever stamped it (project and program bindings unchanged; reverses 1.3 Q4 in part); Q3 the earlier whole-list acknowledgements are **reset** by the upgrade; Q4 per line plus "Acknowledge all (N)" / "Withdraw all (N)" (reverses 1.3 Q3's whole-list key);
Q5 a line that leaves and returns identical stays acknowledged (no pruning).

**Defaults** (`jira-sync.md`): `MOVED_OUT` is a wire reason derived from the stored `OUT_OF_SCOPE` plus `gone_probed_at` (a known over-claim after a type change); the API stays additive (`kind` optional on the existing POST/DELETE; the kind-less POST stamps the open lines, the kind-less DELETE clears every row; totals count open lines); a kind/severity chip matches the lines in the selected Status. After the security audit the DELETE refuses any query parameter but `kind`.

### v1.11.0 — what shipped

Overnight part 2 of 2026-11-11 (released on the user's "Feel free to release"), a minor bump; no migration. **Withdraw all:** `POST /integrations/flow/team-bindings/{id}/unacknowledge-all` and "Withdraw all (N)" beside "Acknowledge all (N)" (supersedes 1.10 D12's "no withdraw all"; sprints only, all or nothing with the `409 stale-deviations`, `204`, shown at two or more acknowledged rows). **The Netty read timeout re-armed per interval** (`security.md` "Slow requests"): a stalled request is cut with `408` on a reused or once-idle connection too.

### v1.10.1 — what shipped

Fifteen small fixes of the overnight run of 2026-11-10/11, a patch bump at the user's request; no migration. User-visible: the ADMIN "All teams" shortcut on `/schedule-proposals` (the first 50, the run's `teamIds` cap); a per-user `password-change` bucket (10/min) on `PUT /users/{id}/password` (its 429 typed `password-change-locked`); the outbound guard refuses the IPv4-translated SIIT range `::ffff:0:0:0/96` whole, never unwrapped; a run claim locks its connection row `FOR SHARE`,
so a claim racing a connection delete leaves no orphan `sync_runs` row.

### v1.10.0 — what shipped

The sync follow-ups (2026-11-10), a minor bump; **V27** (`jira_observations.gone_probed_at`); proven against the stubs only. The four overnight items are in `product.md` "Domain decisions", the rest in `product.md` "Defaults taken for v1.10.0". Delivers the gone-probe stamp and retry, the pruned acknowledgements and `acknowledge-all`, the `::/96` refusal, the Home landing, "Import from Jira..." on the work-stream menu. **Consequences:** the first 1.10 run probes every row already gone (up to 100 a run) and an acknowledged `GONE` whose reason changes reopens once;
the first Flow run deletes every stored acknowledgement whose row is not listed.

### v1.9.0 — what shipped

The 1.6 follow-ups (2026-11-10); **V26** (`flow_capacity_acknowledgements`: one row per Flow team binding and sprint, `sprint_id NULL` is the team's own `TEAM_GONE` row); proven against the Flow stub only. The answers (Q8a-Q11a) are in `product.md` "Domain decisions", the defaults in `product.md` "Defaults taken for v1.9.0". Delivers the per-sprint acknowledge `POST|DELETE /integrations/flow/team-bindings/{id}/acknowledge` (audited, `409 stale-deviations`), the OPEN-by-default listing and the team view's `FLOW_CAPACITY` flag and `weeks[].flowCapacity`.
**Consequence:** a later release that changes a kernel rule or the deviation's figures un-acknowledges everything, by design.

### v1.8.0 — what shipped

The cross-team schedule proposal run (2026-11-10), a minor bump; no migration. The user's answers Q9a-Q13a of 2026-11-09 are in `product.md` "Domain decisions"; the 1.8 plan added (Q1a) ONE plan-scoped check called by BOTH pages ("go ahead with 1.8, all recommended"); the defaults are `product.md` "Defaults taken for v1.8.0". The page learns the caller's teams from `GET /schedule-proposals/teams`; the team page's check is vitest only. **Consequences:** a run is page state (lost on navigation; `BACKLOG.md`);
a drag of any run team's unticked milestone refuses the accept and the page re-proposes at once with the ticks kept; an unsettled run (a loop between teams) may be accepted, its dates are the last pass's.

### v1.7.0 — what shipped

The planning features (2026-11-09), a minor bump; **V25** (`milestones.pinned`, and `ck_milestones_pinned_scheduled`: a pin needs dates). **The answers** ("all recommended", 2026-11-09): (Q1a) **1.7.0 = the critical path on the team page AND the roadmap (with the per-link slack), the stored pin, the baseline-vs-baseline diff (with the rank movement)**; the cross-team run goes to 1.8.0 (the pin comes first, so managers can protect dates before a run moves them); Q2a-Q7a are in `product.md` "Domain decisions"; (Q8) **out:** the ticked-subset link check (went with 1.8)
and keep-what-fits with the target-window start bound. The pin writes `milestone.pinned` and `milestone.unpinned` and is inside the proposal's scope hash.

### v1.6.0 — what shipped

The capacity deviation (released 2026-11-08); no migration, nothing stored. **The answers** ("all recommended", 2026-11-08): (Q1a) **no acknowledge** in 1.6.0 (reversed in 1.9.0: per sprint); (Q2a) the Deviations page gains a section "Capacity from Flow" and the team page's Flow section a "Capacity vs Flow" line, both from the SAME document (`GET /views/capacity-deviations`, `flow/`), no timeline flag (reversed in 1.9.0 and 1.23.0); (Q3a) **per sprint over the days it holds**, current or future (`end >= today` in the connection's zone),
`flowMd = round2(mdPerWeek x W / 5)` beside Flow's raw `flowTotalMd`, both rounded before the 0.5 threshold, skipped and `LONG_WINDOW` sprints silent; (Q4a) `CAPACITY_MISSING` per sprint (the web folds a team's rows into one line); (Q5a) a second endpoint beside the Jira one (`jira/` and `flow/` may not name each other).

**Defaults taken:** `today` in the connection's zone, `asOf` the UTC date; only deviating teams are items, no `all`; caps 1,000 teams / 100 connections; the section hides itself without a Flow connection; no `revision` (team data). **Decided while building:** a sprint with no plan period against Flow's 0 is silent; a `ZERO_CAPACITY` sprint carried by an earlier period is a WARNING whose remedy is ticking it by hand in the preview; Flow's per-sprint figures and the zone are disclosed to every login (`authorization.md`).
**Consequence:** a team imported under 1.5.0 may show differences until imported again.

### v1.5.1 — what shipped

The fixes from the first connections to a real Jira Cloud site and a real Flow; no migration (D1-D5 "all recommended"). **Jira:** the development stub serves only sites whose tenant label starts with `stub-` (`JiraStubRouting`); every other site reaches Atlassian, and the test result, the connection response and `jira.connection_tested` carry `stub`. **Flow:** the base-URL refusal names its cause, ADMIN reads the allowed origins (`GET /integrations/flow/origins`), `docker-compose.real-flow.yaml` reaches a Flow compose stack;
the capacity import counts Flow's days (`flow-sync.md` F3, F11, F12). **Consequence:** an existing development connection to `sample.atlassian.net` reaches the real Atlassian until deleted.

### v1.5.0 — what shipped

Flow teams, capacity and membership (released 2026-11-08), proven against the Flow stub only (walk-through and ledger F1-F10: `flow-sync.md`). **V24** (additive: `persistence.md`; the mirror is one Flow document replaced wholesale per run; `team_capacity_periods.source` is `MANUAL`|`FLOW`). Delivers the ADMIN registry with Test connection, `SyncKind.FLOW` through the 1.3 scheduler, binding by name, `GET /teams/{id}/flow`, the capacity import (preview then apply, one transaction under the team lock),
the team page's Flow section and the Flow stub (host port 8097). The answers Q1a-Q7a are in `product.md` "Domain decisions"; the defaults are `product.md` "Defaults taken for v1.5.0". **Consequences:** an import is a snapshot (a re-import updates Flow-sourced periods; removals are listed and never preselected); the roster is information only (`BACKLOG.md`); a revoked or expired token fails the runs with `AUTHENTICATION_FAILED` until a new token is saved.

### v1.4.0 — what shipped

Coverage and roll-ups, proven against the stub only (`jira-sync.md` "The census" states what was built). **V23** (additive: `persistence.md`); the config key `JIRA_TEST_RATE_LIMIT_PER_MINUTE` is in `security.md`. The answers Q1a-Q6a (the user's "all recommended, go ahead", 2026-11-07) are in `product.md` "Domain decisions".

**Defaults taken** (rules: `jira-sync.md` "The census"): done Jira children are not `UNLINKED_IN_JIRA` (closed work the plan never had is history) but count in roll-ups; "linked" is an ACTIVE binding on the same site (D1); roll-up points are the discovery's `storyPoints` marker, never converted to man-days; a project link's `rollup` is always null; a disabled connection's link carries no roll-up and raises no flag; program-level coverage shows on the Deviations page only; a children read past the page ceiling keeps what it read and warns, any other failure leaves the run SUCCEEDED, unstamped.

**Consequences:** a binding that gains one of the new kinds reopens only that line (a new fingerprint); a story deleted in Jira can inflate a roll-up for up to `censusHours`; a site whose stories point at their epic through Epic Link shows no children (A12); the first run after the upgrade reads every connection in full once. **Not in 1.4:** program and work-stream coverage flags on the timelines, a drill-down from the roll-up.

### v1.3.0 — what shipped

Polling, status, acknowledge and the timeline markers, proven against the stub only. **V22** (additive: `persistence.md`; its acknowledgement columns were dropped in 1.13). The scheduler and the five states are `sync.md`; the acknowledge routes, the deviation flags and the markers are `jira-sync.md` and `planning-model.md` "The roadmap view".

**The answers** (the user: "yes, recommendations are fine", 2026-11-07): (Q1) a per-connection `pollIntervalMinutes`, default 15, 5..1440, `null` = manual only; existing connections start polling at the upgrade. (Q2) Flow's five states derived per read from `sync_runs` and `enabled`, nothing stored. (Q3) an acknowledgement keys on the sha256 of the binding's deviation list (per line since 1.12); (Q4) the node's owner chain or ADMIN may acknowledge, like the bind. (Q5) a server-side fold:
one flag per open deviation on the project's own binding, one roll-up per project for its milestones. (Q6) the Jira shadow bar is on by default with a remembered toggle. (Q7) Flow's back-off from `sync_runs`, capped at six hours. (Q8) a disabled connection is not polled, raises no flag and draws no bar, but its bindings stay visible. (Q9) the poll's run lock and the import's plan lock are independent.

**Rulings while building:** the back-off is `max(interval, min(interval x 2^(n-1), 6 h))`; a run that outlives `sync.maxRunMinutes` without a claim reads FAILED (interrupted); the Jira dates bar is drawn only inside the plan's own dates padded by a year; a binding through a disabled connection stays a link (no dates, no flags) so its owner can still unlink it. **Consequence:** a later release that changes a deviation rule changes every fingerprint and un-acknowledges everything.

### v1.2.0 — what shipped

Import from Jira, proven against the stub only (walk-through and ledger A10: `jira-sync.md` "Import"). **No migration.**

**The decisions** (the user's, on the plan's recommended options): (A) the e2e imports an isolated `IMP` stub project, not `E2E` (program names are globally unique); (B) the modal is on the connection page only (ADMIN; superseded in 1.10 by the work-stream menu); (C) a project's target window is not copied from Jira (reversed in 1.14).

**Rulings while building:** for a non-admin every skipped row but `ALREADY_BOUND` is redacted and `unmatchedTeams` counts the created rows only; the apply's rights are the ticked rows' targets, narrower than a full preview's (so an owner of one node cannot read every summary in scope); a milestone whose dates cannot be copied is created unscheduled, never skipped. **Consequences:** linking is by name, so an unlinked item renamed in Jira previews as a new one (1.15 suggests a link); the planner reads only the direct Jira parent,
so an item under an unmapped intermediate level goes to the default parent, else is skipped `NO_PARENT`.

### v1.1.0 — what shipped

The Jira sync's first release, proven against a built-in stub only (`jira-sync.md`). V21. **Not in 1.1:** polling, acknowledge, import, coverage, Flow. `ingest/`, the raw store and the role switch were deliberately not ported (see `product.md` "Donors"). The five overnight defaults were ruled on and kept (`product.md` "The Jira sync").

### v1.0.0 — what shipped

The checkup: no new domain feature, no migration. Doc drift fixed, coverage floors raised to the measured actuals, a11y lint and axe, the OrbStack Kubernetes overlay and a hardened compose app, a password-change lock and an MFA live-code limit; performance re-measured at scale, no fix justified (`BACKLOG.md`).

**Defaults taken (the user accepted a, b and c):** (a) **Kubernetes stays local on OrbStack**, its overlay sets `KTOR_DEVELOPMENT=true` and `HTTP_BEHIND_PROXY=false`, so only the server suite proves production mode (`security.md`); (b) **the MFA limit replaces the oldest code** (default 3, 1..100) rather than answering 429, which let a password holder keep the block going; (c) **the password-change lock is one `LoginThrottle` per user id on the login lockout's knobs** (5 attempts, 15 minutes; login is unaffected), with an email or an admin reset as the exits.

### v0.9.0 — what shipped

Baselines (V20) on the answers in `product.md` "Domain decisions", plus four carried items: the telemetry e2e waits for the NEWEST live process, one theme-owned table hover tint, the proposal's `dependencies[]` slimmed to the links violated before or after the moves, and the batch accept's scope check (`scopeHash`, `409 stale-scope`). Database triggers refuse any update or delete of the frozen rows; take, rename and delete are plan writes audited as `baseline.created|updated|deleted`;
`?baseline=` on the four timelines (`400 unknown-baseline`) and `GET /views/baseline/{id}`. **Not built** (`BACKLOG.md`): baselines of links and capacity, per-team baselines, an automatic baseline at a release.

### v0.8.0 — what shipped

Auto-proposal (no migration), on the answers in `product.md` "Domain decisions": the pure `ScheduleKernels` place ONE team's not-started milestones (`scheduling.md` "The auto-proposal"). `POST /teams/{id}/schedule-proposal {asOf}` (the team's manager or ADMIN;
a read-only snapshot, no lock, no audit event) and the accept `POST /teams/{id}/milestone-schedules {expectedRevision, items}` (N schedule PUTs in one plan write, per-item `skipped` reasons, one revision bump, audited as `milestone.scheduled` per change plus `team.schedule_batch_applied`). The team page previews dashed on the same timeline and is read-only while a proposal is open.

### v0.1.0 to v0.7.0 — foundation to calendar

The Roadmap tables above hold each version's scope; the answers behind them are in `product.md` "Domain decisions", the mechanics in `planning-model.md` and `timeline.md`. v0.1.0 was Flow @ `e9c3b726` (1.35.0) renamed and trimmed: Jira and GitLab ingestion, the metrics layer, reports, the role switch and the worker process were removed; one process serves everything.
