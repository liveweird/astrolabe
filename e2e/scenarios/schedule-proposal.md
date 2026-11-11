# Schedule proposal (the team page's Propose schedule, in 2042)

- **Spec**: [tests/schedule-proposal.spec.ts](../tests/schedule-proposal.spec.ts)
- **Actors**: two throwaway logins seeded through the API — a team MANAGER (the manager of the team, owning nothing) and a project OWNER (a
  person who owns the project, not its team); the seed administrator acts only through the API (seeding, and the schedule write that
  reschedules a milestone under an open proposal). The pin scenario (1.7) is the manager's: pinning is a schedule write of the team's manager or an administrator
- **Owns** (exclusive server-side state): its throwaway users, people, team (with its ONE capacity period), work stream, program, project,
  three milestones and the link between two of them (unique `e2e-sp-*` names), all seeded through the API and removed by the afterEach
  through the API, the project first (its milestones and link go with it), then program, work stream, team, people and users. Each test
  seeds its own team, so tests never share a mutable row. Every date is in **2042**, a year no spec writes a holiday in (`public-holidays` owns
  2040, `critical-path` 2041): the real clock is the proposal's `asOf`, the team's first capacity period starts on Monday 2042-01-06, and a
  proposal cannot place anything before the first day with capacity, so the dates do not depend on today. The proposal's scope token also carries the global holiday dictionary, which `public-holidays.spec.ts` writes (2040): a holiday written while a proposal is open can stale the accept (409 `stale-scope`, when it changes an accepted date; the figures these files compare are working-day counts, so the lock stays), so both files take the Playwright lock `holiday-dictionary` and never run at the same time.

**The world.** The team's period: from Monday 2042-01-06, 10 man-days per week, WIP limit 2 (so 1 MD a day per milestone, 2 MD a day for the team).
Milestones: `a` 4 MD and `b` 6 MD unscheduled, `c` 2 MD scheduled Monday 2042-03-03 to Tuesday 2042-03-04; a finish-to-start link `b -> c`.
The proposal, counted by hand on the Monday-to-Friday calendar (no holiday): the team order is c, a, b (the dated milestone first, the
unscheduled ones by name); b is hoisted ahead of c, which needs it. `b` takes six working days from 01-06: **2042-01-06 to 2042-01-13**;
`a` runs beside it for four: **2042-01-06 to 2042-01-09** (2 in progress = the limit, 2 MD a day = the daily capacity); `c` starts the working
day after b ends: **2042-01-14 to 2042-01-15**, **34 working days earlier** than 03-03. The proposed week of 01-06 loads 4 + 5 = 9 of 10 MD,
the week of 01-13 loads 1 + 2 = 3 of 10 (the server's answer agrees; checked by hand against `POST /teams/{id}/schedule-proposal`).

## Scenario: the team's manager proposes a schedule, reads the moves and the proposed load, and accepts them all

1. The team's manager signs in and opens the team's page.
   - *Expected*: the strip's week of 2042-03-03 reads "2 of 10 man-days" (c's current load); the Unscheduled tray lists a and b.
2. They press **Propose schedule**.
   - *Expected*: the proposal request succeeds and the **Proposed schedule** section opens with the summary "3 moves · 2 newly scheduled · 0 stay · 0
     could not be placed". Three dashed proposal bars are drawn (read-only images named "Proposed: <name>, <start> to <end>"): b
     2042-01-06 to 2042-01-13, a 2042-01-06 to 2042-01-09, c 2042-01-14 to 2042-01-15 (c beside its current bar, a and b on rows the preview appends).
     The load strip shows the proposed load: week of 2042-01-06 "9 of 10 man-days; up to 2 milestones in progress", week of 2042-01-13 "3 of 10 man-days",
     neither overloaded nor over the WIP limit.
3. They read the table.
   - *Expected*: four rows (header, then c, a, b in the team's order), the select-all box checked; c reads current 2042-03-03 to 2042-03-04, proposed
     2042-01-14 to 2042-01-15 and "34 working days earlier"; a reads "Unscheduled → 2042-01-06 to 2042-01-09, 4 working days"; b reads "Unscheduled
     → 2042-01-06 to 2042-01-13, 6 working days".
4. They press **Accept selected (3)**.
   - *Expected*: the batch request succeeds; the section and the dashed bars are gone; a note reads "3 scheduled"; b, a and c are bars at the
     proposed dates; the tray is gone and the page says "Every milestone is scheduled."; the strip (reloaded from the server) reads "9 of 10
     man-days" for the week of 2042-01-06 and has no cell for the week of 2042-03-03 any more; **Propose schedule** is enabled again.

## Scenario: the manager accepts some of the proposal and the rest stays as it was

1. The manager opens the team's page and presses **Propose schedule** (the same world and proposal as above).
   - *Expected*: the section opens with all three moves ticked.
2. They untick b.
   - *Expected*: a and c stay ticked, the select-all box is indeterminate, and the button reads **Accept selected (2)**.
3. They press **Accept selected (2)**.
   - *Expected*: the batch succeeds; the note reads "2 scheduled"; a is a bar at 2042-01-06 to 2042-01-09 and c at 2042-01-14 to 2042-01-15; b has
     no bar and is still a row of the Unscheduled tray (a has left it); the facts line names no conflict (b's link to c reads
     nothing while b is unscheduled).

## Scenario: a milestone rescheduled after the proposal is skipped and the others land

1. The manager opens the team's page and presses **Propose schedule**.
   - *Expected*: the section opens with all three moves ticked.
2. Meanwhile the administrator (through the API, with the team view's current revision) schedules a to 2042-02-04 to 2042-02-05.
   - *Expected*: the write succeeds; a's schedule revision is now above the proposal's.
3. The manager presses **Accept selected (3)**.
   - *Expected*: the batch succeeds as a whole; the note reads "2 scheduled · 1 skipped: rescheduled in the meantime"; a is a bar at the
     administrator's dates (2042-02-04 to 2042-02-05) once the page has reloaded the view, and not at its proposed ones; b is a bar at 2042-01-06 to
     2042-01-13 and c at 2042-01-14 to 2042-01-15; the tray is gone.

## Scenario: the project owner reads the team page without the Propose schedule button

1. The project's owner (not the team's manager) signs in and opens the team's page.
   - *Expected*: c's bar is a read-only image ("..., 2042-03-03 to 2042-03-04, ..., read-only"); the tray tells that the team's manager or an
     administrator schedules; there is no **Propose schedule** button (nor any button starting with "Propose") and no Proposed schedule section.

## Scenario: a pinned milestone keeps its dates: the manager pins c, proposes, c is not among the moves and the summary counts it, then unpins it

1. The manager opens the team's page (the same world) and chooses **Pin dates of <c>** from c's row menu (only a scheduled row offers it).
   - *Expected*: the pin request (`PUT /milestones/<c>/pin`) succeeds; the live region says "<c> pinned"; a hidden "pinned" follows c's name and its bar's
     accessible name ends ", pinned".
2. They press **Propose schedule**.
   - *Expected*: the summary reads "2 moves · 2 newly scheduled · 0 stay · 0 could not be placed · 1 pinned" and the section adds "1 milestone keeps its
     dates because it is pinned"; the table has the header, a and b only (no row for c); two dashed bars (b 2042-01-06 to 2042-01-13, a 2042-01-06
     to 2042-01-09) and none for c; the strip's week of 2042-03-03 still reads "2 of 10 man-days" (c stays where it is).
3. They press **Discard** and choose **Unpin dates of <c>** from c's row menu (a previewing page is read-only, so only after the discard).
   - *Expected*: the table is gone; the pin request succeeds; the live region says "<c> unpinned" and the hidden "pinned" is gone.
4. They press **Propose schedule** again.
   - *Expected*: the summary reads "3 moves · 2 newly scheduled · 0 stay · 0 could not be placed" with no pinned count or sentence; c's row reads
     2042-01-14 to 2042-01-15 and "34 working days earlier", as in the first scenario. Nothing is accepted.

## Not covered here (and why)

- **The unplaced rows ("no capacity after …", "no room within the 520-week horizon"), the link badges and the "resolves" text** — the server
  tests pin every verdict and the web unit tests render each row; `accessibility.spec.ts` scans the open proposal with a conflict and a resolved
  link on the page.
- **The 403/404 matrix of the proposal and batch routes** — covered by the server tests (`ScheduleProposalTest`, `TeamScheduleBatchTest`); here only
  the visible consequence (no button for the owner).
- **A discard** — covered by the web unit tests; it writes nothing (the pin scenario presses it only to leave the read-only preview).
- **The pin's refusals and the pinned milestone in an accepted batch** — the server tests (`MilestonePinTest`, `ScheduleKernelsTest`) and the web unit tests
  (`TeamDetails.pin.test.tsx`, `TeamProposal.test.tsx`); a pin of an unscheduled milestone (409) and a pin flipped after a proposal (`stale-scope`) are not driven here.
