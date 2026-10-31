# Project view (milestones on the shared timeline)

- **Spec**: [tests/project-view.spec.ts](../tests/project-view.spec.ts)
- **Actors**: two throwaway logins seeded through the API — a project OWNER (a person who owns the project, not its team) and a team
  MANAGER (the manager of the milestone's team, owning nothing); the seed administrator acts only through the API (seeding, and the
  "someone else moved it" write)
- **Owns** (exclusive server-side state): its throwaway users, people, team, work stream, program, project and milestones (unique
  `e2e-pv-*` names), all seeded through the API and removed by the afterEach through the API, the project first (its milestones go with
  it), then program, work stream, team, people and users. The plan revision is shared with every other spec's plan writes: nothing
  here asserts a revision, and a schedule write is only refused as stale when THIS milestone moved (the per-milestone check).

## Scenario: a project owner creates milestones in the Unscheduled tray and cannot schedule them

1. The owner signs in, opens the Plan page and follows the project's name link ("Open <project>").
   - *Expected*: the page heading is the project name; the facts line reads "Target window: 2027-01-04 – 2027-03-26" and "Nothing
     scheduled"; with no milestone yet the page says "No milestones yet".
2. They press **New milestone**, enter a name, pick the team in the Team picker, type an estimate of 2.5 and Create; then a second one
   with 0.25.
   - *Expected*: each POST succeeds with no dates; the page now shows the Timeline and **Unscheduled** sections; the tray lists both
     milestones with the team and "2.5 man-days" / "0.25 man-days".
3. They look for a way to schedule.
   - *Expected*: there is no **Schedule** button and no drag handle in the tray, the tray says the team's manager or an administrator
     schedules them, the facts line still says "Nothing scheduled"; the row menu offers Edit (for their plan fields) and no schedule
     item.

## Scenario: the team's manager schedules a milestone by button, by keyboard, by pointer drag and by resize, and meets the stale notice

1. The team's manager (not an owner of anything) signs in and opens the project; one milestone waits in the tray, and a second one
   (the "ruler") is already scheduled by the administrator for 2027-02-15 – 2027-02-19.
2. They press **Schedule <name>**.
   - *Expected*: the milestone becomes a bar for one calendar week starting at the later of today and the project's target start
     (2027-01-04); the tray is replaced by "Every milestone is scheduled."; its name is in the grid.
3. From the row menu they choose **Edit schedule of <name>**, type 2027-02-01 and 2027-02-05, and Save.
   - *Expected*: the bar reads "2027-02-01 to 2027-02-05".
4. They focus the bar and press Space, ArrowRight, Space (dnd-kit's keyboard sensor).
   - *Expected*: the live region announces the pick-up, the step and "Dropped <name>: 2027-02-02 to 2027-02-06."; the bar reads
     2027-02-02 to 2027-02-06.
5. They drag the bar with the pointer by two day cells (the cell width is measured from the bar: 28 px at week zoom).
   - *Expected*: the bar reads 2027-02-04 to 2027-02-08.
6. They drag the end handle with the pointer by one day cell.
   - *Expected*: the bar reads 2027-02-04 to 2027-02-09.
7. The administrator, through the API, moves the same milestone to 2027-03-01 – 2027-03-05 (with the freshly read revision). The manager
   repeats the keyboard move.
   - *Expected*: the server answers 409; the page says the milestone "was moved by someone else in the meantime", reloads, and the
     bar reads 2027-03-01 to 2027-03-05.
8. They choose **Unschedule <name>** from the row menu.
   - *Expected*: the bar is gone and the milestone is back in the tray.
9. They drag the milestone's tray row by its handle onto the timeline with the pointer, releasing three and a half day cells to the
   right of the ruler bar's last day, with the grid scrolled so that the ruler is on screen.
   - *Expected*: the server answers 200; the milestone becomes a bar for one calendar week starting on the day under the pointer
     (2027-02-23 to 2027-03-01) and the tray is empty again.

## Scenario: the project owner reads the scheduled timeline, the derived span and the drift, with no handles

1. The administrator (through the API) gives the project a target window 2027-01-04 – 2027-01-29 and schedules its one milestone for
   2027-01-11 – 2027-02-05. The project's owner signs in and opens the project.
   - *Expected*: the facts line shows the window, "Scheduled span: 2027-01-11 – 2027-02-05" and the drift in words: "Ends 7 days after
     the target" and "Starts 7 days after the target" (orange badges).
2. They look at the bar and its row menu.
   - *Expected*: the bar is a read-only image ("…, read-only") with no start/end handles and nothing to pick up; the row menu offers
     Edit but no schedule item.

## Not covered here (and why)

- **The 400 refusals, the optimistic rollback on a non-409 failure, the ignored change while a save is in flight, the pre-checked
  Saturday–Sunday span, the exact PUT bodies, delete with the milestone count, the zoom memory and the empty states** - pinned by
  `ProjectView.test.tsx`, `milestoneForm.test.ts`, `projectViewUpdate.test.ts` and the server's `MilestoneScheduleTest`; this journey
  drives the real browser paths (focus, dnd-kit's sensors, the stale notice).
- **A tray drop that lands outside the track (over the tray, the footer or the sticky columns)** - proposes nothing; pinned by
  `Timeline.test.tsx` (the visible-bounds test).
- **Who may schedule, per caller** - the server's authorization tests; here only the visible consequence (no handles, no Schedule).
