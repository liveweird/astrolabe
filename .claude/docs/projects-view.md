# Projects view

Owns: the Projects nav leaf and its two routes, the project picker, the remembered project, the bare `/projects` and its empty states, the project page's Milestones table and (1.29) the two dependency panels. Not here: the project page's body (timeline, dependencies, editors: `web-internals.md` "Project view", `timeline.md`), the plan view the picker reads (`planning-model.md` "The view documents"), the nav model and the palette (`web-internals.md` "Navigation"). Added in 1.29.

## Rules

- **One page, two routes.** `projects` (no project) and `projects/:id` both render `pages/ProjectView.tsx`: without an id it renders `components/ProjectsStart.tsx`, with one `ProjectPage`. There is no second page component and no server endpoint of its own; the picker reads the cached plan view (`planViewKey`) and costs no request the Plan page does not already make until a search term of two characters asks for milestones ("The picker").
- **The picker is the only way between projects**, and the loaded page has no back link (the Plan is one nav click away). The not-found state keeps a link to `/projects` and shows the picker with nothing picked.
- **A pick is a push** (`navigate(projectPath(id))`), so Back returns to the project before. Picking the project already shown goes nowhere. The control is never clearable and never deselects (`clearable={false}`, `allowDeselect={false}`).
- **The bare page redirects by `replace`**, so Back never returns to a redirect. A project is forgotten only on a fresh SUCCESSFUL answer of the plan view that lacks it ("The remembered project"): a cached view may predate it, and a failed or paused read says nothing about it.
- **The Projects leaf owns every `/projects…` path.** Plan carries no `activeFor` for it (two leaves would tie on length in `activeNavPath`, and array order would decide).

## The picker (`components/ProjectPicker.tsx`)

- A Mantine `Select` in `PageHeader`'s `switcher` slot (above the title, where a back link sits; hidden in print, `data-print="hide"`; `EditPageLoadState` passes it through for the load and not-found states). Its accessible name is `common.filter.project` ("Project"): there is no visible label, and the name never repeats the role.
- **Options** (`utils/projectPicker.ts`, pure): one group per program, labelled "Work stream › Program"; a closed work stream (an end date) carries `project.picker.closedStream` after its name. Open streams first, then by name; programs and projects by name (`openFirstByName`, `byNameThenId`): the plan view's shared order is a hand arrangement only the Plan and Programs pages draw.
  A program with no project has no group. A project the plan view does not hold (a page still loading its view, a stale cache) stands alone, ungrouped and last, named by the page that loaded it (`currentName`), so the control never shows a blank for a project on screen.
- **The filter** (`projectOptionsFilter`) replaces the theme's `foldedOptionsFilter` for this one control and keeps its contract (a group keeps the items that match and disappears when none does; an ungrouped option is matched by its own label). Each item carries a `search` string: the project's own name, its program's, its work stream's and its OWNER's (the project's, not the program's or the stream's), matched case- and accent-insensitively (`foldDiacritics`). Typing "ola" or a program's name therefore finds the projects.
- **The milestone search** (1.30; the plan view holds no milestones): a project is also found by the NAME of one of its milestones, through the one request the picker makes, `listMilestones({ name, sort: "name", page: 1, pageSize: 100 })` (`GET /milestones`; only `name`, `projectId`, `sort=name` and paging of that list are relied on).
  - **When**: the search box is controlled. A term (trimmed) of at least two characters, 300 ms after typing pauses (`FILTER_DEBOUNCE_MS`), under the key `["plan","milestones","projectPicker",term]` with `keepPreviousData` (so a plan write refreshes it). SearchPicker's guard is ported: the picked project's own name, which Mantine writes into the box, is no term; a single character asks nothing.
  - **What shows**: a project with a milestone in the answer joins the options under its OWN option (grouped as ever, the project's name unchanged) with a dimmed second line "Milestone: X"; several matches say "Milestone: X (+N more)" for the first by name. The answer is re-checked locally with `foldDiacritics` against the LIVE text (a milestone the box no longer contains is dropped, so the lines never lag the typing); the project-name matches show at once, the milestone ones when the answer arrives.
  - **Honesty**: "No project matches" only once the search for this term has completed (never while it is debouncing or loading). `total` above 100 adds a disabled last line saying only the first 100 milestones are checked; a failed search adds one saying so, and the matches by project, program and owner stay listed. The disabled line is no choice (`ProjectPickerItem.notice`, kept by every filter).
  - Files: `components/ProjectPicker.tsx` (query, state, notices), `ProjectPickerOption.tsx` (`renderOption`, draws the check mark Mantine drops), `utils/projectPicker.ts` (`milestoneNamesByProject`, `withMilestoneHits`, `pickedLabel`, the filter).

## The remembered project

- **`projects.last`** (`astrolabe.viewSettings.projects.last`, `hooks/useLastProject.ts`): a project id. It is written once a project page has LOADED (any way in: the picker, a link, the address; a project that does not exist is never remembered), never read as state: only the bare page reads it, once on arrival.
- **A bare `/projects`** decides by the plan view, in this order:
  - a plan view, CACHED or fresh, that holds the remembered id: redirect (`replace`) at once, no wait;
  - otherwise, with an id remembered, wait for a fresh answer (`isFetchedAfterMount` and success); success that lacks the id: `forgetLastProject` and the empty state;
  - an error, with or without a cache: the failure alert (`ErrorAlert`), never an empty plan, and nothing is forgotten;
  - paused (offline, `fetchStatus` "paused"): nothing is forgotten and nothing spins. A cached plan gives the empty state with the picker and a dimmed note (`project.offline`); without a cache an alert says the server cannot be reached;
  - with nothing remembered the plan (cached or not) is all there is to wait for.
- **Deleting a project** forgets it (only when it is the remembered one) and still lands on the Plan.
- A stored value that is not a positive integer reads as none.

## Empty states

- **No project picked** (the plan holds projects, nothing remembered or the remembered one is gone): h2 "Projects", one sentence, the picker, "No project picked".
- **No projects yet** (the plan holds none): the same title and sentence, "No projects yet" with a hint and a link to the Plan; no picker (nothing to pick).

## The Milestones table (`components/ProjectMilestonesTable.tsx`)

The retired Milestones page's filters, kept for ONE project (the page is gone: `/milestones` redirects, see "Where the old links go"). An h3 "Milestones" after the Unscheduled tray and before Dependencies,
mounted only while the project has a milestone (an empty project has the page's own empty state).

- **Rows** are the view's own `scheduled` then `unscheduled` (`projectMilestones`), nothing fetched or recomputed; a write that moves a milestone changes the table with the view.
  - Columns: Milestone (plain text), Team (`TeamNameCell`: swatch and name, a link named by `common.entity.open.team`), Estimate, Start, End. A milestone without dates has ONE dimmed "Not scheduled" cell across Start and End.
  - The name cell is a `td`, not a row header: the timeline's rowheaders stay the only ones on the page (e2e addresses them by role).
- **Controls**, inline above the table (no drawer: three small controls; `data-print="hide"`):
  - Schedule (All, Not scheduled, Scheduled; never clearable).
  - Team (`TeamFilterSelect` over the project's OWN teams, `settled={false}` so it never invents a "Team 12"; a picked team the project no longer has is dropped, not left as an empty table).
  - Name (`ClearableTextInput`, a case- and accent-insensitive substring of the milestone's name, `foldDiacritics`).
  - "Clear the filters" shows while any narrows. A status line (`role="status"`) says "N milestones", or "Showing X of N milestones" while narrowed (the rows follow every keystroke, the announced count waits 300 ms for typing to pause, `FILTER_DEBOUNCE_MS`); nothing matching says so inside the table.
- **Sort**: Milestone, Team or Start (`SortHeader`; default Start ascending).
  - Text compares by an `Intl.Collator` (numeric, accents and case ignored); a milestone without dates is last in BOTH directions (as the server's start sort); ties fall back to the name, then the id.
  - Pure logic and the filters: `utils/projectMilestones.ts`. The old page's rank sort has no counterpart (one project has one rank).
- **The address** holds the Schedule choice only: `?milestones=all|unscheduled|scheduled` (exact words; anything else is no choice).
  - A Schedule change `replace`s the entry, keeps every other parameter and always writes the chosen word, "all" included. "Clear the filters" writes "all" only when the address already holds `milestones`, else leaves the address alone.
  - The Schedule choice is in the address, so it survives Back and a reload; Team, Name and the sort are page state and reset when another project is picked (the page is keyed by the project).
  - The link target for a project's "not scheduled" figures (Home) is `/projects/N?milestones=unscheduled` (`projectUnscheduledPath`).
- **Where the old links go.** `/milestones` redirects (`LegacyMilestonesRedirect`, `legacyMilestonesTarget` in `utils/legacyLinks.ts`, the old query dropped): a `projectId` to `/projects/N` with `milestones=unscheduled|scheduled` from `scheduled=false|true`; only a `teamId` to `/teams/N` (its Unscheduled tray); else `/projects`. Team load's and Home's team "not scheduled" figures lead to the team's page, Home's plan figure to `/team-load`.
- **Shown or hidden** (`TableDisclosure`, controlled with `open`/`onOpenChange`; `aria-expanded`/`aria-controls`, `data-print="hide"`): shown by default, remembered per browser under `project.milestonesOpen` (`astrolabe.viewSettings`, one flag for every project).
  - A hidden table is not rendered, so it neither prints nor costs a row; the heading and the toggle stay.
  - A valid `?milestones=` OPENS a table remembered as hidden WITHOUT writing the memory; hiding a table the address opened removes the parameter (and remembers "hidden"), or it would stay open.
- **Accessibility and widths**: the table is named by `project.milestones.tableAria` (also the `ScrollRegion`'s name, the keyboard stop) under the h3.
  - A sticky header inside a 420 px cap; dates and the estimate stay on one line.
  - The three controls stack full width below `xs` and the table scrolls sideways (min 640 px).
  - The team swatch is decorative beside the name (`TeamSwatch`); on a monochrome print the Team column tells teams apart.

## Dependency panels

The arrows stay on the Gantts; each of the pages that draws them also has the explicit list, hidden or shown on demand (the Dependencies page went in 1.29: the Roadmap's panel is the plan-wide list). One disclosure, `TableDisclosure` in its controlled mode, for both; a hidden list is not rendered (it neither prints nor costs a row), the toggle stays and keeps the focus, nothing animates.

- **The project page** (`components/ProjectDependencies.tsx`, h3): shown by default, remembered per browser under `project.dependenciesOpen` (one flag for every project).
  - The header always says what the list holds ("N dependencies" and, when any link is violated, a red "K violated"), so a hidden list leaves the arrows a statement in words; "Add dependency" is the header's button while the list is shown (the milestone row menu's shortcut works either way).
  - `?dependencies=all|violated|ok|unscheduled` (the Roadmap panel's words; this list has no filter, so any of them only opens it) OPENS a list remembered as hidden WITHOUT writing the memory and moves the focus to the heading once, on arrival; hiding a list the address opened removes the parameter (and remembers "hidden").
- **The Roadmap, in both modes** (`components/PlanDependenciesPanel.tsx`, mounted by the two PAGES, not their bodies: the last child of the page `Stack`, after the body, as `{!empty && …}`; it reads its own endpoint, so a failed read of the page's own view hides the timeline and not the list): EVERY dependency of the plan, whatever the page's program pick and filters, while the arrows are the rolled-up links between projects (Home's "N violated dependencies" counts them all, so the list it opens must).
  - **One tree position in every state** (loading, error, data): the panel never remounts when the view's read recovers, so an open Add dialog survives. It therefore stands while the view loads and goes when the plan is known to be empty.
  - **Arrival focus waits.** Because it stands before the timeline, its ARRIVAL focus (the address naming it, the row menu's action) waits for the page's own read to settle, loaded or failed (the `ready` prop, `!query.isLoading`), and fires once per arrival (per history entry for the action): a heading focused under the loading block would be pushed below the fold by the timeline arriving above it. With a critical path picked, its list (in the body) precedes the panel.
  - Hidden by default, remembered under `roadmap.dependenciesOpen` (one flag for both pages). A `<section>` named by its h3, so its own "Filters" toggle is told apart from the page's.
  - **Read only while shown** (`usePlanDependencies` `enabled`): the one `GET /views/dependencies` and the plan view (who may add); a hidden panel costs no request.
  - **The address** (`utils/dependencyListFilters.ts` `PANEL_PARAMS`): `dependencies=all|violated|ok|unscheduled` (the status; its presence OPENS the panel for that visit, the memory untouched, and moves the focus to the heading once), `dependencyTeamId`, `dependencyProjectId`. Prefixed because the Roadmap's own `teamId` is another filter. A link names no mode (the panel is the same in both). The retired `/dependencies?status=&teamId=&projectId=` is a redirect that translates the three names (`utils/legacyLinks.ts` `legacyDependenciesTarget`, `components/LegacyDependenciesRedirect.tsx`).
  - The panel never writes the address on its own. A filter change (the panel's Filters, "Clear the filters") writes the three names by `replace`, ALWAYS with the status word (`all` when unset), and keeps every foreign parameter (the Roadmap's filters, `programId`); hiding a panel the address opened removes the word only (the filters stay for the next opening).
  - "Add dependency" sits in the header row while shown and the plan lets the caller add (`can.createDependency`, as the page's); rows, row menu (Edit by `can.edit`, Delete by `can.delete`), dialogs and focus are the old page's own.
  - A save or a delete refreshes `["plan"]` and `["roadmap"]`, so both timelines' arrows follow.
- **Where it is opened from** (`utils/dependencyListLinks.ts`: `dependenciesFilteredPath`, `violatedDependenciesPath`): Home's "N violated dependencies" and "Yours" conflicts, and the team page's two facts links (`dependencyTeamId`).
  - The Roadmap and Programs row menus' "Dependencies" (`PlanProjectCells.tsx` `DependenciesItem`, name "Dependencies of {name}") is an in-page ACTION, not a link: it `replace`s the address with the panel's filter set to that project alone (earlier status and team filters dropped, every other parameter kept).
  - It asks for the focus by the entry's state (`OPEN_DEPENDENCIES_STATE`); the panel focuses its h3 a tick later, after the closing menu's own focus return.
- **One body, two hosts.** `hooks/usePlanDependencies.ts` (reads, rows, editor/add/delete state) and `components/PlanDependenciesContent.tsx` (filters, facts, table, empty states, dialogs) are what the panel mounts (a section heading, the toggle, the address) on the Roadmap in both modes.
- **Accessibility, phone, print**: the table stays in its `ScrollRegion` (a labelled, focusable scroller) with a sticky header and the 70vh cap; status, type and dates stay on one line; the toggle, the Add button and the filters are `data-print="hide"` (so is the panel's h3 while it is hidden: no lone heading prints), so a printed page holds the open table and nothing else; the headings take a scroll margin (`ANCHORED_HEADING_STYLE`) so a focused heading is not under the app header; the panel's controls wrap below `sm`.

## Tests

- Unit: `utils/projectPicker.test.ts` (grouping, order, the filter, milestone hits), `components/ProjectPicker.test.tsx` (the control: groups, owner/program/accent search, push, no clear, the milestone search: request, one-character guard, +N more, waiting, cut, failed), `hooks/useLastProject.test.tsx`.
- Pages: `pages/ProjectView.start.test.tsx` (the redirect, the cache hit, the waiting, the forget rules, a failed refetch and the offline states, the empty states, the heading outline), `ProjectView.test.tsx` (remember on load, forget on delete, the picker on the loaded and not-found pages).
- The Milestones table: `utils/projectMilestones.test.ts` (parse, filter, sort), `components/ProjectMilestonesTable.test.tsx` (controlled show/hide, the address, filters, sort), `pages/ProjectView.milestones.test.tsx` (its place in the page and the outline).
- e2e: `projects.spec.ts` (the remembered project, the picker finding a project by its program and by a milestone's name, the Milestones table narrowed by Schedule and name and hidden), the `/projects` axe scan and the open table in the `/projects/:id` scan.
- Dependency panels: `components/ProjectDependencies.disclosure.test.tsx` (show/hide, memory, the header words, `?dependencies=all`), `components/PlanDependenciesPanel.test.tsx` (hidden and unread, memory, the address, filters writing the prefixed names, Add, a failed read),
  `.list.test.tsx` (cells, ends, facts, address filters, empty/cut/failed states, Polish), `.add.test.tsx`, `.dialogs.test.tsx` (edit and delete dialogs, focus), `.write.test.tsx` (row menu by `can`, refresh of `["plan"]` and `["roadmap"]`),
  `pages/Roadmap.dependencies.test.tsx` and `pages/Programs.dependencies.test.tsx` (the outline, remembered filters beside the panel's parameters, the row menu's action, a failed view read beside the panel's rows, an open Add dialog across the recovery, the arrival focus waiting for the view, an empty plan without a panel), `utils/dependencyListFilters|Links|legacyLinks.test.ts` and `components/LegacyDependenciesRedirect.test.tsx`.
- e2e (panels): `dependencies.spec.ts` (hide, show, reload, the address), `dependency-list.spec.ts` (the panel on both pages), the `/roadmap` axe scans with the panel open.
