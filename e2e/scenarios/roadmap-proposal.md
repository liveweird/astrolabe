# Cross-team schedule proposal (the Roadmap overview, in 2048)

- **Spec**: [tests/roadmap-proposal.spec.ts](../tests/roadmap-proposal.spec.ts)
- **Actors**: three throwaway logins seeded through the API — a MANAGER (the manager of both teams, owning nothing), a SINGLE manager (the manager of team Y
  in the fourth scenario, of a third team Z in the fifth) and a project OWNER (a person who owns the project and manages no team); the seed administrator acts only through the API
  (seeding, and reading the stored milestones back), and in the last scenario signs in. Every overview run narrows the page to the spec's own program
  (`/roadmap?mode=overview&programId=<id>`): a run covers the teams of the projects the page shows, and the plan is shared by every parallel worker.
- **Owns** (exclusive server-side state): its throwaway users, people, TWO teams each with ONE capacity period (from Monday 2048-01-06, 10 man-days a week,
  no WIP limit), work stream, program, project, two milestones and the link between them (unique `e2e-ct-*` names; the saved-proposal scenario adds a third team Z, the SINGLE manager's, and the ONE saved proposal it saves, `e2e-ct-saved-*`), all seeded through the API (the saved proposal by the app) and removed by
  the afterEach through the API, the project first (its milestones and link go with it), then program, work stream, teams, people and users. Each test seeds
  its own teams, so tests never share a mutable row. Every date is in **2048**, a year no spec writes a holiday in (`public-holidays` owns 2040,
  `critical-path` 2041, `schedule-proposal` 2042, `baselines` 2043, `jira-sync` 2044, `jira-import` 2045, `jira-coverage` 2046, `flow-sync` and
  `flow-capacity-deviation` 2047): the real clock is the run's `asOf`, each team's first capacity period starts on Monday 2048-01-06, and a proposal cannot
  place anything before the first day with capacity, so the dates do not depend on today. A cross-team proposal's scope token carries the global holiday
  dictionary, which `public-holidays.spec.ts` writes (2040): a holiday written while a run is open can stale the accept (409 `stale-scope`, when it changes an accepted date; the lock stays, these files compare working-day figures), so this file
  takes the Playwright lock `holiday-dictionary` with `public-holidays` and `schedule-proposal` and never runs at the same time as they do.

**The world.** Team X and team Y (names `e2e-ct-teamx-*`, `e2e-ct-teamy-*`), each from Monday 2048-01-06 at 10 man-days a week and no WIP limit, i.e. 2 man-days
a working day. Milestones: `x1` 4 MD on team X scheduled Monday 2048-03-02 to Tuesday 2048-03-03; `y1` 2 MD on team Y unscheduled; a finish-to-start link
`x1 -> y1`. The MANAGER's person manages both teams (the SINGLE manager's person manages Y instead in the fourth scenario: a team has one manager).
The run, counted by hand on the Monday-to-Friday calendar (no holiday): team X is placed first, `x1` takes two working days from the first day with capacity,
**2048-01-06 to 2048-01-07**; team Y is placed with X's PROPOSED dates as facts, so `y1` starts the working day after x1's proposed end and takes one day,
**2048-01-08 to 2048-01-08**; one pass, settled. Against x1's STORED end (03-03) `y1` would start on 2048-03-04. The project's own span is 2048-03-02 to 2048-03-03 now and
2048-01-06 to 2048-01-08 after the run.

## Scenario: a login that manages no team previews a proposal: the dashed bars and the projects that would move, and nothing to accept

1. The project OWNER signs in and opens the Roadmap overview narrowed to the spec's program.
   - *Expected*: the timeline is shown and **Propose schedule** is enabled once the viewer's rights are read (everyone previews).
2. They press **Propose schedule**.
   - *Expected*: the run request succeeds; the "Schedule proposal" h3 and **Discard** appear; the note "This is a preview."; no **Accept selected** and no **Save proposal**; **Propose again** is offered; a dashed proposal bar is drawn
     (the work stream's and the program's, the project row being folded); the "Projects whose dates would move" table shows the project's span now (2048-03-02 to 2048-03-03) and proposed (2048-01-06 to 2048-01-08).
3. They open team Y's section ("Show the moves of <Y>").
   - *Expected*: y1's row reads "Unscheduled → 2048-01-08 to 2048-01-08, 1 working day" and its checkbox is disabled.
4. They press **Discard**.
   - *Expected*: the section and every dashed bar are gone; nothing was written.

## Scenario: the manager of two teams runs a cross-team proposal: the second team's milestone lands after the first team's proposed date, and one accept writes both

1. The MANAGER signs in and opens the Roadmap overview narrowed to the spec's program.
   - *Expected*: **Propose schedule** is enabled.
2. They press **Propose schedule**.
   - *Expected*: the run request succeeds and a **Discard** button appears; the facts line reads "Placed in 1 pass · settled"; two sections with h3 headings X then Y
     ("placed 1 of 2", "placed 2 of 2"); x1's row reads current 2048-03-02 to 2048-03-03 and proposed 2048-01-06 to 2048-01-07; y1's row reads "Unscheduled →
     2048-01-08 to 2048-01-08, 1 working day" (the day after x1's PROPOSED end); both moves are ticked and no row carries a "Conflict" badge.
3. They press **Accept selected (2)**.
   - *Expected*: ONE accept request succeeds, naming both teams (`acceptTeamIds`), with 2 accepted and 0 skipped, and its plan revision is above the run's; the note reads "2 scheduled"; the sections
     and the Discard button are gone; the API (as the administrator) shows x1 at 2048-01-06 to 2048-01-07 and y1 at 2048-01-08 to 2048-01-08.

## Scenario: unticking the first team's move keeps it in March, and the check turns the second team's link into a warning

1. The MANAGER opens the overview, presses **Propose schedule** (the same world and run as above).
   - *Expected*: both moves are ticked (**Accept selected (2)**) and team Y's table shows no "Conflict" badge.
2. They untick x1.
   - *Expected*: the ticked-subset check request succeeds; the button reads **Accept selected (1)**; y1's Links cell shows the red "Conflict" badge and
     "would violate: must start on 2048-03-04 or later (link from <project> › <x1>)" — x1 stays in March and ends 03-03, so y1 at 01-08 would precede it.
3. They tick x1 again.
   - *Expected*: the button reads **(2)** again; every move is ticked, so the run's own verdicts are exact (no check request) and y1's row carries no badge and no "must start on".

## Scenario: a manager of one team accepts that team's moves alone, and the other team's section is a preview

1. The SINGLE manager (manager of team Y only; team X is managed by the other person) signs in, opens the overview narrowed to the program and presses **Propose schedule**.
   - *Expected*: the run covers BOTH teams of the project (two h3 sections); team X's section is collapsed ("Show the moves of <X>" is not expanded); team Y's is open with y1 ticked and reading
     "Unscheduled → 2048-01-08 to 2048-01-08, 1 working day"; x1 stays in March unless its manager accepts, so the ticked-subset check shows "must start on 2048-03-04 or later" on y1; **Accept selected (1)**
     is offered and **Save proposal** is not (saving needs every team of the run).
2. They press **Accept selected (1)**.
   - *Expected*: ONE accept request succeeds; its body names two teams (`teamIds`) and ONE accepted team (`acceptTeamIds` = Y); 1 accepted, 0 skipped; the note reads "1 scheduled"; the section is gone; the API shows y1 at 2048-01-08 and x1 still at 2048-03-02 to 2048-03-03.

## Scenario: a manager of two teams saves a proposal, a manager of another team opens it from the list and cannot accept, and the first accepts it from there, after which it reads as changed

1. The MANAGER signs in, opens the overview, presses **Propose schedule**, then **Save proposal**, types a unique name (`e2e-ct-saved-*`) and presses **Save proposal** in the dialog.
   - *Expected*: the save request answers 201 and the dialog closes; showing the **Saved proposals (N)** panel (hidden until asked for) lists a row with the name, both teams and "2 of 2" ticked moves, with a Delete button for the saver; y1 is still unscheduled (saving writes nothing to the plan).
2. They sign out; the SINGLE manager (the manager of team Z only) signs in, opens the overview and shows the Saved proposals.
   - *Expected*: the same row shows no Delete button.
3. They open the proposal through its name link.
   - *Expected*: the address carries `proposal=<id>`; the h3 "Saved proposal: <name>"; the state badge reads **Current**; the note says they can read it but only an administrator or the manager of one of its teams can accept its moves; after "Show the moves of <Y>", y1's row reads "Unscheduled → 2048-01-08 to 2048-01-08, 1 working day"; no **Accept selected** and no **Save proposal**.
4. They press **Close**.
   - *Expected*: the saved heading is gone and `proposal` has left the address.
5. They sign out; the MANAGER signs in, opens the overview, shows the Saved proposals and opens the same proposal.
   - *Expected*: the badge reads **Current** and **Accept selected (2)** shows (the stored run is the editable preview).
6. They press **Accept selected (2)**.
   - *Expected*: ONE accept request succeeds with 2 accepted and 0 skipped; the note reads "2 scheduled"; the saved heading is gone and `proposal` has left the address; the API (as the administrator) shows y1 at 2048-01-08 to 2048-01-08.
7. They open the same proposal from the list again.
   - *Expected*: the badge turns **Changed** with its note ("The plan changed after it was saved, so it can no longer be accepted."); no Accept button is offered.

## Scenario: the retired Schedule proposals addresses lead to the Roadmap overview, and a saved proposal that does not exist says so there

1. The administrator signs in and opens `/schedule-proposals?x=1`.
   - *Expected*: the address becomes `/roadmap?mode=overview` (the old query is dropped) and the "Roadmap" h2 is shown.
2. They open `/schedule-proposals/saved/2147483000`.
   - *Expected*: the overview opens with that proposal asked for; the note "This saved proposal does not exist — it may have been deleted." shows and `proposal` leaves the address (`/roadmap?mode=overview`).
3. The navigation has no "Schedule proposals" link.
