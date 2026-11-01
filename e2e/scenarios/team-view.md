# Team view (schedule, order and capacity on the shared timeline)

- **Spec**: [tests/team-view.spec.ts](../tests/team-view.spec.ts)
- **Actors**: two throwaway logins seeded through the API — a project OWNER (a person who owns the project, not its team) and a team
  MANAGER (the manager of the team, owning nothing); the seed administrator acts only through the API (seeding, and the schedule
  writes that set a scenario up)
- **Owns** (exclusive server-side state): its throwaway users, people, team, work stream, program, project and milestones (unique
  `e2e-tv-*` names), all seeded through the API and removed by the afterEach through the API, the project first (its milestones go
  with it), then program, work stream, team (its capacity periods and its order go with it), people and users. The plan revision is
  shared with every other spec's plan writes: nothing here asserts a revision; the team's order has its own revision, so an order
  write is never refused because another spec wrote the plan.

## Scenario: the team's manager sets a capacity period with a WIP limit, schedules from the team page and reads the overloaded week and the WIP warning

1. The team's manager (not an owner of anything) signs in and opens the team's page; two milestones of 10 man-days each wait in the
   Unscheduled tray.
   - *Expected*: the Capacity section says "No capacity set".
2. They press **Add period**, enter the date 2027-02-03 (a Wednesday: any date is accepted), 8 man-days per week and a WIP limit of 1,
   and Create.
   - *Expected*: the POST succeeds; the Capacity table's row reads 2027-02-03, 8 and 1.
3. From the tray row's menu they choose **Edit schedule of <first>**, enter 2027-02-01 and 2027-02-05 and Save.
   - *Expected*: the schedule PUT succeeds; the strip's cell for the week of 2027-02-01 is overloaded; the facts line reads "1 week
     overloaded". With the weekly table expanded ("Show the weekly figures") that week reads capacity 4.80 (the Wednesday-to-Friday
     share of 8 over the week's five days), peak WIP 1 and the status "Overloaded · +5.20 MD", not "Over WIP limit".
4. They press **Schedule <second>** in the tray.
   - *Expected*: the milestone becomes a bar for one calendar week from today and leaves the tray ("Every milestone is scheduled.").
5. From that row's menu they choose **Edit schedule of <second>** and set 2027-02-04 to 2027-02-05.
   - *Expected*: the same week's strip cell is over the WIP limit; the facts line reads "1 week over WIP limit"; the weekly table's
     row shows a peak of 2 and the status "Over WIP limit".

## Scenario: the manager moves a milestone to the bottom, sees the custom order, and resets it

1. The administrator (through the API) schedules two milestones of the team (2027-02-01 – 2027-02-05 and 2027-02-08 – 2027-02-12).
   The manager signs in and opens the team's page.
   - *Expected*: the rows read first, second (the project rank's order — one project, so by start date); no "Custom order" badge.
2. From the first row's menu they choose **Move <first> to bottom**.
   - *Expected*: the order PUT succeeds (it carries the team's own order revision); the rows read second, first; the facts line shows
     the gray "Custom order" badge; the live region says "<first> moved to position 2 of 2".
3. They press **Reset order** and confirm with **Reset** in the dialog (which names the project rank).
   - *Expected*: the order PUT with the empty list succeeds; the rows read first, second again; the badge is gone and **Reset order**
     is disabled.

## Scenario: the manager drags a milestone row below another by its handle and the order is saved

1. The administrator (through the API) schedules two milestones of the team (2027-02-01 – 2027-02-05 and 2027-02-08 – 2027-02-12).
   The manager signs in and opens the team's page.
   - *Expected*: the rows read first, second.
2. They press the first row's handle (the grip at the start of its name cell), move the pointer into the lower half of the second row and
   press Escape before letting go.
   - *Expected*: while held, the insertion line sits at the slot after the second row; after Escape the line is gone, dnd-kit's live
     region says "Cancelled; <first> stays at position 1 of 2.", the rows still read first, second, there is no "Custom order" badge and **no order PUT was sent**.
3. They repeat the drag and release the pointer in the lower half of the second row.
   - *Expected*: the order PUT succeeds; the rows read second, first (the first is row 2 of the grid, `aria-rowindex` 3); the facts line
     shows the gray "Custom order" badge; the live region says "Dropped <first> at position 2 of 2."; no insertion line is left.

## Scenario: the project owner reads the team page without the manager's controls

1. The administrator (through the API) schedules one of the team's two milestones. The project's owner (who is not the team's
   manager) signs in and opens the team's page.
   - *Expected*: one row on the timeline; the facts line reads "2 milestones" and "1 scheduled".
2. They look for ways to change anything.
   - *Expected*: the bar is a read-only image ("…, read-only") with nothing to pick up, resize or schedule; there is no **Add period**,
     **Reset order**, **Edit** or row handle; the tray says the team's manager or an administrator schedules; the Capacity section says
     "No capacity set" and that the manager sets it; the row menu offers **Open project** and no schedule or order item.

## Not covered here (and why)

- **A row drag through autoscroll to a row that is not mounted** — needs a team of 100 rows (the virtual path); the two-row world here
  cannot scroll. It is a manual pass on the sample dataset (recorded in `timeline.md`), the slot arithmetic is unit-tested.
- **A row drag from the keyboard** — there is none by design: the handle is pointer-only and the row menu's Move items are the keyboard
  path (the scenario above, "moves a milestone to the bottom", drives them).
- **Pointer drags of bars** — the same shared Timeline gesture as the project page; `project-view.spec.ts` owns it.
