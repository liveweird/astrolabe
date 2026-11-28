# Schedule proposals in the web app

The web side of the server's schedule proposals (`scheduling.md`): the preview on the team page, the project page and the Roadmap overview, the cross-team run and its saved proposals, the shared checks and the dashed Gantt bars. Read the host's section and `proposals-preview.md` "Shared checks"; page mechanics stay in `web-internals.md`.

## The team page

### The schedule proposal

A third write path, `hooks/useScheduleProposal.ts`. "Propose schedule" (timeline header; since 1.39 drawn for every viewer, though only a viewer with `team.can.schedule` reaches the per-team route, the others get "Plan together with") POSTs the viewer's local day as
`asOf`. A proposal with something to show opens the **Proposed schedule section** (`components/TeamProposal.tsx`, h3, under the timeline before the Unscheduled tray; its summary line, table and
unplaced rows are `components/ProposalTable.tsx`, a controlled, action-free table over the structural `ProposalContent`, which the cross-team page composes once per team); one with nothing to show
(nothing to propose / no capacity: add a period first) opens nothing and says so in a note. The page is read-only while a proposal is requested or open (`hooks/useProposalLock.ts`).

- **The section** is controlled by the hook (`selected`, `toggle`, `selectAll`, `selectNone`, `accept`, `discard`).
  - A summary line ("3 moves · 1 newly scheduled · 2 stay · 1 could not be placed"), a RED "N links would be violated" badge for links violated AFTER and not before (a gray "N links stay violated" for
    those violated both times: `linkTotals`).
  - The table (`teams.proposal.tableAria`): a header "Accept all" `Checkbox` (`indeterminate` while only some rows are ticked), a per-row `Checkbox` "Accept {{name}}"; Milestone with the project as a
    link, Current, Proposed with its working days, Change = `changeSentence`, Links = `linksAtMove`: "would violate: <link> must start on <date> or later" (start or end by the link type,
    `requiredEdge`: FS/SS start, FF/SF end) in red with a red "Conflict" badge, "resolves: link with ..." gray, nothing for an unchanged link.
  - A "Could not be placed" row group with the reason in words (no capacity after {{date}}, the request's `asOf` / no room within the 520-week horizon, `PROPOSAL_HORIZON_WEEKS`; no checkbox).
  - **Accept selected (N)** (primary; disabled at zero or while ANY write of the page runs) and **Discard** (disabled while the accept runs). The intro says the link warnings and the proposed load follow the ticks.
- **Announcements.** Accept all / none are announced in the page's one polite region ("2 of 3 selected"); a per-row tick is a self-announcing checkbox. **What an accept came to** is a dismissible
  `role="note"` line lasting until the next action (`ProposalNotes` under the timeline header, green; orange when something was skipped: "3 scheduled · 1 skipped: rescheduled in the meantime"), as are
  the whole-batch stale refusal and the re-proposal after a `stale-scope` refusal. The status region is the single announcer (never an `Alert` with its implicit `role="alert"`); no success toast on accept.
- **Failures.** A 403/404/400 of the accept is a `FormErrorAlert` INSIDE the open section above the actions (the preview stays open, the selection is kept) and takes the focus (the disabled Accept
  would otherwise drop it to the body); a propose's failure shows under the timeline header while no preview is open.
- **Focus** (`hooks/useProposalFocus.ts`): the section's heading on open ("The cross-team run" "Saved proposals"); Propose gets it back after Discard, an accept or a stale refusal, once no write runs (a disabled button cannot take it).

### Plan together with

(1.38) `hooks/useTeamProposals.ts` is the one surface of the page's proposals (buttons, notices, lock, focus and range read it), in two forms; `used` is the form of the last Propose and cannot change while one is requested or open.
- **Alone** (nothing chosen, the default, and the viewer has `team.can.schedule`): `useScheduleProposal`, the per-team route and `TeamProposal`, as above; no rights are read.
- **Together**: beside Propose the "Plan together with" `RunTeamsPicker` (every other team; not drawn while one is requested or open) and **Add linked teams** (the far ends of `view.dependencies`, `linkedTeamIds`; absent without any). With teams chosen Propose asks ONE run over `[this team, ...chosen]` (`useCrossTeamProposal`; `useProposalRights(enabled)` is read only then and Propose waits for it, 50 teams at most).
- **A viewer without `team.can.schedule` (1.39)** previews: the Propose row, the picker and Add linked teams are theirs too, and their Propose is ALWAYS the run (`[this team, ...chosen]`; alone it is the run over this one team, since the per-team route stays 403).
  - Their rights are read as the page opens (`useProposalRights(chosen || !can.schedule)`) and Propose waits for them, so "nothing is acceptable" is known before the run opens and no Accept flashes.
  - Alone they tick nothing: no ticks, no Accept, the overview's one "This is a preview" sentence, Discard. With chosen teams only the moves of teams they manage tick and accept (1.38's rule). `CrossTeamRunView`'s `openTeamId` keeps THIS team's table open though none of it is theirs.
  - The check overlays this team's block (`shown`) only when `run === null || rights.acceptable.has(teamId)`; else their ticks (none of this team's) would blank the preview's proposed load.
  - The page has no writes for them to lock (every control reads `can`); the lock only ends their Propose (while a preview is requested or open it also freezes the Baseline picker and the Critical path toggle, as for a manager). A manager with nothing chosen keeps the per-team proposal (pinned in `useTeamProposals.test.tsx`).
  `TeamRunSection` (h3 "Schedule proposal", `CrossTeamRunView acceptable`, Accept selected, Discard; no Save: the overview's) replaces `TeamProposal`. This team's moves and those of every other run team the viewer may accept are ticked; the other sections are previews. `proposal` is this team's block of the run (with its `revision`, `scopeHash`).
  `onAccepted(result, items)` patches the page's own team-view entry (`applyAcceptedBatch`, shared with the per-team accept) before the refresh, or the next Move up would be built on a list lacking the milestone just scheduled.
- **The rows** (`utils/teamRunPreview.ts`, the `run` prop of `TeamTimeline`): each milestone of ANOTHER run team and each project of `projects[]` that a link of this team's milestones names and the run moves is a dimmed `ghost:m|p:<id>` row after the chain's (ghost bar = its dates now, dashed bar = the proposed, by the ticks; the row stays when the dash goes); a chain row the run moves takes the dashed bar, no second row; `barOf` knows the ids, so the arrows reach them; the range covers them.

## The project page

### The schedule proposal on the project page

Propose (`components/ProjectProposal.tsx`, state in `hooks/useProjectProposal.ts`) is a click only (the run and the accept share a per-user rate limit), after `useProposalRights`. ONE cross-team run over the distinct teams of the project's milestones, scheduled or not (other teams stay fixed) by default, plus, on a click, the teams of every project it waits on ("The team picker", the closure); the viewer may choose any other active teams ("The team picker"), over 50 or none keeps Propose off with its reason.
Everyone previews: `ProjectTimeline`'s `proposal?` prop (`ProjectTimelineProposal.tsx`) draws a dashed bar on each moved row, a "(new)" row per placed tray milestone and the summary row's `proposal:project` span (`projects[]`), drops the idle bands, makes every bar and the tray read-only.
**The dashes follow the ticks (1.38):** `ProjectPreview.drawn` (`drawnMoves`) keeps a bar for a ticked move and for one the viewer cannot tick, none for an unticked move of theirs (its "(new)" row and table entry stay); the summary span and the end sentence below are `overlayProjects`' entry (`proposals-preview.md` "Shared checks"; the sentence says "If the ticked moves are accepted…" when the entry is the check's, "If every team's moves are accepted…" for the run's own: every move of the project ticked IS the run's).
The h3 after the tray gives the project's end ("would end on D instead of D′, N working days earlier", "would not change", "newly scheduled"), cuts `CrossTeamRunView` to this project (`projectId`), counts the run's moves of the same teams elsewhere (shown, not offered) and offers Accept selected, Propose again, Discard; no Save. Only this project's moves tick, for the teams the viewer may accept; the accept names their teams, the check describes exactly them.
Only DATE writes lock while a run is requested or open (`lockActions`, `guardDrop`); other edits stay (one that moves dates through a link makes the accept stale, 409).

## The Roadmap overview

### The schedule proposal

Every login previews ONE cross-team run on the tree (the run, rights and sections: "The cross-team run" "What the viewer may accept").
- **Propose** is a click (never automatic: run and accept share a 30/min bucket), off (the hint is its description) until the rights are read, while the address's work stream is unsettled or a window write runs, over 50 teams ("narrow the pick or choose fewer"), or with no team ("Choose at least one team"). It covers
  `overviewTeamIds` by default: the union of the SHOWN projects' `teamIds` (`shownProjects`, `treeRows`' own filter: pick + work stream), every team with a milestone when nothing is narrowed; the viewer may choose any other ("The team picker"). `outside` (`OutsidePickNote`) counts the projects a SAVED run or a CHOSEN-set run moves beyond the shown ones; the default run stays silent (1.37).
- **Bars:** the projects that follow the TICKS (`overlayProjects`, 1.38: `proposals-preview.md` "Shared checks"; `useOverviewProposal.projects`) give a project row `proposal:<id>` (`projectTrack`'s `{proposed, locked}`; the roadmap passes none) and a node row `proposedSpan` (union, only when different),
  `proposal:ws|pg:<id>`; `usePlanScale` covers the WHOLE run's spans (`days`), whatever is ticked, so the range never moves under a tick. The "Projects whose dates would move" table keeps the RUN's rows and their order whatever is ticked (it sits above the checkboxes): a row the ticked moves no longer move reads "Unchanged" / "Would not move", the others take the check's dates and end shift; the "No project's dates would move" sentence is only for a run that moves none.
- **Lock** (`useProposalLock`, request to Discard): window bars read-only, no draw surface or window items, `guard(commit)` refuses out loud. Dependencies stay UNLOCKED (decision): an edit bumps the
  revision, so the accept is refused as stale and the page says so.
- **Section** (h3 under the timeline): the teams as links, "Projects whose dates would move", `CrossTeamRunView`, Save (only when every run team is acceptable), Accept selected (N), Propose again,
  Discard. Nothing acceptable = a preview.
- **Saved proposals**: `?proposal=<id>` opens a stored run in this section; the "Saved proposals (N)" panel sits under it ("The cross-team run" "Saved proposals").

## The cross-team run

Files: `api/scheduleProposals.ts`; `hooks/use{CrossTeamProposal,ProposalRights,ScheduleCheck,SavedRun,StatusAnnouncer}.ts`;
`utils/{planProposal,scheduleProposal,savedProposal}.ts`; `components/CrossTeam{Facts,ProposalSection,RunView}.tsx`; saved: `api/savedProposals.ts`, `components/Saved{ProposalsPanel,ProposalsTable,RunHeader,ProposalState}.tsx`, `SaveProposalModal.tsx`.

There is no page of its own (gone in 1.33 with its nav leaf). The run is previewed on the Roadmap overview, the project page and (1.38) the team page ("The Roadmap overview" "The schedule proposal" - the host, the bars, the lock) and accepts the
ticked moves in ONE plan write (`scheduling.md` "The cross-team run"). `/schedule-proposals` redirects to `/roadmap?mode=overview` (`LegacyRedirect`, `carry={false}`), `/schedule-proposals/saved/:id` to the
overview with `proposal=<id>` (`LegacySavedProposalRedirect`, `legacySavedProposalTarget`; a malformed id: the overview alone).

### The run

`useCrossTeamProposal` is the team page's `useScheduleProposal` state machine over a run.

- `propose(teamIds)` (local `asOf`; a run with no move anywhere opens nothing and leaves the team page's two notes), ONE `selected` set over every team's move ids (milestone ids are
  global), `toggle`, `selectAll/selectNone(teamId)` (acts on THAT team; the status region says "n of N selected"), `discard()` (not while the accept runs), `dismiss()`.
- `accept()` posts `{expectedRevision, scopeHash, teamIds (the run's blocks), acceptTeamIds, items}` for the ticked moves of all sections on the write key `["schedule-proposals","accept"]`. A synchronous in-flight ref makes a double click ONE request; a second accept or Propose while it runs is refused out loud (`refused`, `project.busy` announced).
- On success the preview closes, `["plan"]` and `["roadmap"]` refresh and `outcome` is the inline note ("N scheduled · M skipped: reasons", `teams.proposal.reason.*`; no toast).
- `409 stale-revision` closes the run (reload note); **`409 stale-scope`** closes it, re-proposes the SAME teams once and keeps the ticks of the moves that still exist (`rescoped`, orange note); any other failure is the inline `FormErrorAlert` (focused), the run open.
- The host owns the ONE polite status region the hook announces into; `useProposalFocus` focuses the section's heading on open ("Saved proposals" below), Propose on close.

### What the viewer may accept

Every login previews a run; only the teams of `GET /schedule-proposals/teams` have moves to tick.
- `useProposalRights()` over `["schedule-proposals","teams"]` → `{acceptable: Set<teamId>, ready, error}`; a host asks for no run before `ready`; a first load that fails is `ready` and empty (a preview) with `error` set.
- `useCrossTeamProposal(announce, {acceptable, projectId, initialTicks})`: only the moves of acceptable teams (of `projectId`) are TICKABLE (`tickableMoveIds`): default ticks
  (`initialTicks` narrows them), `toggle`, select all/none and "n of N" follow; `accept()` adds `acceptTeamIds` (`acceptTeamIdsOf`; none without `acceptable`). `canAccept` false =
  a preview: no Accept, `enabled: false` for `useScheduleCheck` (no check request). The run and accept share a 30/min per-user bucket (a 429 = `common.error.tooManyRequests`).
- `CrossTeamRunView acceptable projectId`: other teams' sections are collapsed (`TableDisclosure`: no table while closed), read-only ("Shown as it would be if this team's manager
  accepts…", checkboxes disabled) and keep the run's own verdicts (`overlayCheck` and the check state reach acceptable sections only); an orange badge counts a section's
  overloaded or over-WIP weeks (`warningWeekCount`); with none acceptable ONE "This is a preview" sentence replaces the per-section ones. `projectSlice` keeps a project's moves and
  unplaced rows (`unchanged`/`pinned` only for `projectMilestoneIds`); the run view keeps the links touching them.

### The sections

- `CrossTeamFacts` (`role="note"`): gray "Placed in N pass(es) · settled"; an ORANGE Alert when `!settled` (`scheduleProposals.facts.unsettled_*`: the teams depend on each other in a loop; the dates shown are the last pass's).
- One `CrossTeamProposalSection` per block of `teams[]` in PLACEMENT order: an h3 (the team's name, a dimmed "placed n of N"), the team page's `ProposalTable` (named per team through `label`) and, collapsed, `TeamWeeklyLoad` with `labels` (an h4 "Proposed load").
- **The ticked-subset check is `useScheduleCheck`** over ALL the run's team ids and moves; `overlayCheck(block, check, teamId)` gives a section the verdicts and load of the ticked moves (all = the run's own, none = no new warnings, some = the check's answer). Closing the run drops the `["plan","schedule-check"]` queries.

### Saved proposals

A saved run is the SERVER's own re-computation (`scheduling.md` "Saved proposals"): no document is sent, none recomputed. `SAVED_PROPOSALS_KEY`: an accept, a stale refusal and a delete refresh it; a delete or a 404 drops the record's copy.

- **Save proposal** (beside Accept, one move ticked, only when every run team is acceptable): `SaveProposalModal` posts the name, `asOf`, teams, `revision`, `scopeHash` and the ticks. A `409` is inline (focus on **Propose again**) = `proposeAgain(teamIds, ticks, rescoped?)`. `open(run, ticks)` takes a stored run, no request.
- **`SavedProposalsPanel`**, an h3 "Saved proposals (N)" under the overview's timeline: the count is the list's own (read always, ≤ 20, no documents), the table (`SavedProposalsTable`: Delete by the row's `can.delete`) sits in a controlled `TableDisclosure`, hidden by default, remembered under `roadmap.savedProposalsOpen`. A name links to the CURRENT address with `proposal=<id>` set (`withProposal`: the pick and the narrowing stay).
- **`useSavedRun`** (in `useOverviewProposal`) reads `?proposal=` (the saved list's links and the old page's redirect set it): once the rights are read the stored run opens in the overview's own run (`flow.open`), under an h3 "Saved proposal: name" (`SavedRunHeader`: the facts, a state badge `data-state`, green CURRENT else gray).
  `can.accept` AND CURRENT AND `asOf` = today make it acceptable: ticks editable, the stored `check` (its verdicts and its `projects`, `storedCheckState`) for the stored ticks (no request), the live one for any other; else the stored ticks are read-only (a refetch that turns it CHANGED takes the Accept away).
  A fresh run (Propose again, a stale scope) is the viewer's own (`sameRun`: Save returns). The accept names the ticked teams (`acceptTeamIds`).
- **Opening lands on the top, one rule for every run** (fresh or saved; team page, project page, overview; `useProposalFocus(run, busy)`): the section's h3 (`headingRef`, `tabIndex={-1}`, `ANCHORED_HEADING_STYLE`, whose scroll margin clears the 56 px header) is scrolled to the top (`scrollIntoView({block:"start"})`) and focused with `preventScroll`.
  No control takes the focus on open (Discard/Close, a tall section's LAST control, scrolled the page to its bottom). An opening is the run object (the latch, cleared on close): a tick, a refetch, a failed accept or a window focus never lands again; Propose again (plan unchanged too), a stale refusal's fresh run, another saved proposal or the same one reopened after Close do. A saved run opens once its record is read. Vertical scroll only.
- **The open one is marked**: `SavedProposalsTable`'s row of the run on screen (`openId` = `saved.record.id`; a failed read marks nothing) takes `aria-current="true"` and `.rowCurrent`, cleared with the run.
- It ends with **Close** (Discard once fresh), an accept, a stale refusal, Back or a mode switch (`RoadmapModes` drops `proposal`): the parameter leaves the address. A 404 (also a malformed id), an `UNREADABLE` record (saved by an earlier version) or a failed read opens nothing, says so in a dismissible note (`SavedNotice`) and drops the parameter.

### The team picker

`components/RunTeamsPicker.tsx` (props `value`, `onChange`, `defaultIds`, `disabled?`, `label?`; the team page reuses it, "Plan together with") is a searchable `MultiSelect` named "Teams in the run" over EVERY active team (`useTeamOptions`, the one cached read, the theme's folded filter), wrapping at 390 px, with a "Use this page's teams" reset only while it is enabled and the value differs from the defaults as a set.
All three pages (the team page's too) DRAW NO picker while a run is requested or open (a disabled one failed dark-scheme contrast; the run's sections name its teams, so nothing can disagree with them).
`hooks/useRunTeams.ts` holds the choice as page state (never remembered): `ids` is the page's own array while untouched or re-chosen to the same set, so an untouched picker posts exactly what the page always posted; a chosen set is sorted by id, and choosing the page's own set (by hand or the reset) stores nothing, so the picker keeps following the page.
The overview's and project page's hooks spread `picker` (`useOverviewProposal`, `useProjectProposal`: value, change, the page's set, `disabled` while a run is requested or open, when the section leaves it out: changing the set means Discard, then Propose).
`MAX_RUN_TEAMS` (50, the server's ceiling) lives there; Save keeps its rule (every run team acceptable), so a manager who picks only their own teams gets it.

**The dependency closure (1.39, the project page only).** "Add the teams this project waits on" (`hooks/useRunClosure.ts`, drawn by `ProjectProposal`, exposed as `useProjectProposal().closure`) fills the picker for a chain of projects.
- **Shown** when `view.dependencies` holds a link whose successor is in this project and whose predecessor is in another (`waitsOnOtherProject`); hidden, like the picker, while a run is requested or open; disabled (loading) while it reads, and Propose is off then too (its hint says why), so no run starts over a set the answer is about to change. No Roadmap read at mount.
- **A click** reads the Roadmap document through the query client (`fetchQuery(roadmapViewKey(null), getRoadmapView)`, `retry: false` so a failure shows at once; the default `staleTime` 0 means a cached copy is revalidated by the ETag, never trusted, so a link made a moment ago on this page is seen).
- **The walk** is `upstreamTeamIds(links, projects, [projectId], MAX_RUN_TEAMS, ids)` (`utils/runClosure.ts`, pure): the WHOLE upstream chain over the document's project-pair `links` (predecessor to successor; links inside one project are not listed) and each project's `teamIds`,
  breadth-first so nearest first (one distance by project id), cycle-safe; a project with no teams adds nothing and the walk goes on through it.
- **The bound** is the run's 50 teams for the WHOLE set (`have` = the picker's set counts): a project is taken whole, and the walk STOPS before the one that would pass 50 (`cut`), never skipping to a smaller one further out. `runTeams.set` takes the union with the set as it is when the answer arrives; a set equal to the page's own stores nothing, as ever.
- **Outcomes** are a `role="note"` (gray; red when the read failed) and the page's `announce`: "Added N teams this project waits on.", "Nothing to add: …already in the run.", "Added N teams, then stopped: a proposal takes at most 50 …" (or "Nothing added: the next project upstream would take the proposal past 50 teams."), "The roadmap could not be read…". The note goes with Propose or a hand edit of the picker.
- **Upstream moves are never acceptable here** (1.33 D7): `others` counts and links them. The check already covers a ticked move that relies on one: its items are only the ticked moves, so the upstream predecessor is judged at its stored dates (`ProjectView.runTeams.test.tsx`).

### Tests

Co-located: `Programs.{proposal,saved,save,runTeams}.test.tsx`, `ProjectView.runTeams.test.tsx`, `TeamDetails.run.test.tsx`, `useTeamProposals`, `teamRunPreview`, `RunTeamsPicker`, `useRunTeams`, `Saved*`, `CrossTeam*`, `useCrossTeamProposal*`, `planProposal` (fixtures `test/{crossTeamRun,overviewRun}.ts`); e2e `roadmap-proposal.spec.ts`, `team-run.spec.ts`.

The checks shared by the hosts and the Gantt preview: `proposals-preview.md` ("Shared checks", "The Gantt preview").
