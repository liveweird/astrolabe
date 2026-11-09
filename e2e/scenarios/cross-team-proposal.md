# Cross-team schedule proposal (the Schedule proposals page, in 2048)

- **Spec**: [tests/cross-team-proposal.spec.ts](../tests/cross-team-proposal.spec.ts)
- **Actors**: three throwaway logins seeded through the API — a MANAGER (the manager of both teams, owning nothing), a SINGLE manager (the manager of team Y
  in the third scenario only) and a project OWNER (a person who owns the project and manages no team); the seed administrator acts only through the API
  (seeding, and reading the stored milestones back).
- **Owns** (exclusive server-side state): its throwaway users, people, TWO teams each with ONE capacity period (from Monday 2048-01-06, 10 man-days a week,
  no WIP limit), work stream, program, project, two milestones and the link between them (unique `e2e-ct-*` names), all seeded through the API and removed by
  the afterEach through the API, the project first (its milestones and link go with it), then program, work stream, teams, people and users. Each test seeds
  its own teams, so tests never share a mutable row. Every date is in **2048**, a year no spec writes a holiday in (`public-holidays` owns 2040,
  `critical-path` 2041, `schedule-proposal` 2042, `baselines` 2043, `jira-sync` 2044, `jira-import` 2045, `jira-coverage` 2046, `flow-sync` and
  `flow-capacity-deviation` 2047): the real clock is the run's `asOf`, each team's first capacity period starts on Monday 2048-01-06, and a proposal cannot
  place anything before the first day with capacity, so the dates do not depend on today. A cross-team proposal's scope hash covers the global holiday
  dictionary, which `public-holidays.spec.ts` writes (2040): a holiday written while a run is open would stale the accept (409 `stale-scope`), so this file
  takes the Playwright lock `holiday-dictionary` with `public-holidays` and `schedule-proposal` and never runs at the same time as they do.

**The world.** Team X and team Y (names `e2e-ct-teamx-*`, `e2e-ct-teamy-*`), each from Monday 2048-01-06 at 10 man-days a week and no WIP limit, i.e. 2 man-days
a working day. Milestones: `x1` 4 MD on team X scheduled Monday 2048-03-02 to Tuesday 2048-03-03; `y1` 2 MD on team Y unscheduled; a finish-to-start link
`x1 -> y1`. The MANAGER's person manages both teams (the SINGLE manager's person manages Y instead in the third scenario: a team has one manager).
The run, counted by hand on the Monday-to-Friday calendar (no holiday): team X is placed first, `x1` takes two working days from the first day with capacity,
**2048-01-06 to 2048-01-07**; team Y is placed with X's PROPOSED dates as facts, so `y1` starts the working day after x1's proposed end and takes one day,
**2048-01-08 to 2048-01-08**; one pass, settled. Against x1's STORED end (03-03) `y1` would start on 2048-03-04.

## Scenario: the manager of two teams runs a cross-team proposal: the second team's milestone lands after the first team's proposed date, and one accept writes both

1. The MANAGER signs in and opens **Schedule proposals** (`/schedule-proposals`).
   - *Expected*: the page heading; the **Teams** multi-select lists exactly the two teams the login manages (X, Y) and **Propose** is disabled until a team is picked.
2. They pick teams X and Y and press **Propose**.
   - *Expected*: the run request succeeds and a **Discard** button appears; the facts line reads "Placed in 1 pass · settled"; two sections with h3 headings X then Y
     ("placed 1 of 2", "placed 2 of 2"); x1's row reads current 2048-03-02 to 2048-03-03 and proposed 2048-01-06 to 2048-01-07; y1's row reads "Unscheduled →
     2048-01-08 to 2048-01-08, 1 working day" (the day after x1's PROPOSED end); both moves are ticked and no row carries a "Conflict" badge.
3. They press **Accept selected across teams (2)**.
   - *Expected*: ONE accept request succeeds with 2 accepted and 0 skipped, and its plan revision is above the run's; the note reads "2 scheduled"; the sections
     and the Discard button are gone; the API (as the administrator) shows x1 at 2048-01-06 to 2048-01-07 and y1 at 2048-01-08 to 2048-01-08.

## Scenario: unticking the first team's move keeps it in March, and the check turns the second team's link into a warning

1. The MANAGER opens the page, picks X and Y and presses **Propose** (the same world and run as above).
   - *Expected*: both moves are ticked (**Accept selected across teams (2)**) and team Y's table shows no "Conflict" badge.
2. They untick x1.
   - *Expected*: the ticked-subset check request succeeds; the button reads **Accept selected across teams (1)**; y1's Links cell shows the red "Conflict" badge and
     "would violate: must start on 2048-03-04 or later (link from <project> › <x1>)" — x1 stays in March and ends 03-03, so y1 at 01-08 would precede it.
3. They tick x1 again.
   - *Expected*: the button reads **(2)** again; every move is ticked, so the run's own verdicts are exact (no check request) and y1's row carries no badge and no "must start on".

## Scenario: a manager of one team is offered that team only, and a login managing nothing is told so

1. The SINGLE manager (manager of team Y only; team X is managed by the other person) signs in and opens the page.
   - *Expected*: the multi-select lists team Y alone.
2. They pick Y and press **Propose**.
   - *Expected*: "Placed in 1 pass · settled"; one section (h3 Y); y1's row reads "Unscheduled → 2048-03-04 to 2048-03-04, 1 working day" — after x1's STORED end, since
     team X is a fixed fact of this one-team run, not part of it.
3. They sign out and the project OWNER (who manages no team) signs in and opens the page.
   - *Expected*: the empty state "You manage no team" with its hint "A team's manager or an administrator can run a proposal."; no multi-select and no **Propose** button.
