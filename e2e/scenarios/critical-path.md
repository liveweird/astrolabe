# The critical path and the idle gaps (the project, team and roadmap pages)

- **Spec**: [tests/critical-path.spec.ts](../tests/critical-path.spec.ts)
- **Actors**: a throwaway project OWNER login (the person who owns the program, so all three projects; not the teams' manager, so the bars
  are read-only images; it also reads the roadmap); the seed administrator acts only through the API (seeding, the milestones' dates, the links)
  and, in the third scenario, reads the team page in the browser (the world has no manager login for P's team, and the figures are the same for every viewer)
- **Owns** (exclusive server-side state): its throwaway user, person, two teams (X's and Y's milestones on one, P's on the other), work
  stream, program, three projects X, Y, P and their milestones and links (unique `e2e-cp-*` names), seeded through the API and removed by
  the afterEach, the projects first (their milestones and links go with them), then program, work stream, teams, person and user. **Every date
  is in 2041**, a year nothing else in the suite touches: the holiday dictionary is global and `public-holidays.spec.ts` owns 2040, so the
  working-day figures asserted here (slack, idle gaps) cannot see a holiday. The world, per test: x1 (X, 2041-01-07..11), y1 (Y,
  2041-01-14..18), p1 (P, 2041-01-21..25) and an unlinked p2 (P, 2041-01-07..11), with finish-to-start links x1 -> y1 -> p1, no lag. All four
  scenarios run on that same shape, seeded afresh each time. The roadmap scenario writes nothing: it narrows the page to the world's program with
  the program pick (a browser setting, `astrolabe.viewSettings.planning.programPick`, local to the test's browser context) and the critical-path
  target is page-local (not stored), so it never touches the global ranking; the team-page scenario's toggle is the browser-stored
  `timeline.criticalPath`, also local to its context.

## Scenario: the critical path: the owner turns it on and reads the chain beyond the neighbouring project; it survives a reload and goes away when off

1. The owner signs in and opens project P.
   - *Expected*: the **Critical path** toggle is not pressed; the page has no `data-critical` element, no Slack column, no Critical chain
     section and no "Critical path" badge in the Dependencies table; y1 is a ghost row ("Y › y1", from the link y1 -> p1) and x1 has no row.
2. They press **Critical path**.
   - *Expected*: the toggle is pressed and a **Slack** column appears. p1 reads "0 critical path" (it drives P's end), p2 reads
     "10 working days" (it ends two weeks before P does), and the ghost row y1 reads "0 critical path" (the neighbour's own slack, looked up
     by kind and id).
   - *Expected*: exactly three elements carry `data-critical="true"`: the p1 bar, the ghost y1 bar (both with "on the critical path" in
     their accessible names) and the one arrow y1 -> p1, which is not violated; the p2 bar is not marked.
   - *Expected*: the Dependencies row of y1 reads "OK" and carries the gray "Critical path" badge.
3. They read the **Critical chain** section.
   - *Expected*: the "On the chain" table has the header and ONE row, x1: hops 2, "Milestone", project X, "2041-01-07 – 2041-01-11", "0 working
     days", its name a link to `/projects/<X>`; y1 is not listed (it is a ghost row and shows its slack there - hops are not a filter, this is
     the "farther than the neighbour" case); "Upstream with slack" reads "None."; the timeline has no row and no bar for x1.
4. They reload the page.
   - *Expected*: the toggle is still pressed (it is stored in the browser), the Slack column and p2's "10 working days" are back and the
     chain table has the same row.
5. They press the toggle again.
   - *Expected*: no `data-critical` element, no Slack column, no Critical chain heading and no badge: the page is as it was before step 2.

## Scenario: idle gaps: a five-working-day hole in the schedule is hatched, counted and listed on the project page and on its team's page

1. The owner signs in and opens project P (p2 in week 2041-01-07..11, p1 in 2041-01-21..25: the week between is a hole; y1 belongs to Y).
   - *Expected*: a band with `data-band-tone="idle"` and the title "Idle 2041-01-14 to 2041-01-18, 5 working days"; the facts line shows the
     gray "1 idle gap" badge; the h3 "Idle gaps" is there with its table closed.
2. They press **Show the idle gaps**.
   - *Expected*: the table "Idle gaps" has the header and one row: From 2041-01-14, To 2041-01-18, Working days 5.
3. They open the page of the team that does P's work (p1 and p2).
   - *Expected*: the same idle band title, the "1 idle gap" badge in the team facts, and after **Show the idle gaps** the same table row
     (the team's own schedule has the same hole).

## Scenario: the administrator reads the critical path on P's team page: p1 critical with no slack, p2 with ten working days, the toggle shared with the project page

1. The administrator signs in and opens the page of the team that does P's work (p1 and p2).
   - *Expected*: the **Critical path** toggle is not pressed; the timeline has no Slack column and no element with `data-critical`.
2. They press **Critical path**.
   - *Expected*: the toggle is pressed and a **Slack** column appears: p1 reads "0 critical path" (it drives P's end), p2 "10 working days";
     the note says slack and the critical path are measured toward each milestone's own project's end.
   - *Expected*: p1's bar (a movable button for the administrator) is named "..., on the critical path" and carries `data-critical="true"`;
     p2's does not; exactly ONE element on the page carries the flag, and no arrow is drawn (the link y1 -> p1 comes from the other team's
     milestone, which is no row of this page).
3. They open P's project page.
   - *Expected*: the toggle is already pressed (ONE stored choice for both pages) and the Slack column reads the same figures for p1 and p2.
4. They press the toggle off there and return to the team page.
   - *Expected*: the toggle is not pressed, the Slack column and every `data-critical` are gone.

## Scenario: the roadmap shows the critical path to P: X and Y emphasised, the chain panel lists them with their hops, None clears everything

1. The owner signs in, sets the program pick to the world's program (so the page shows only X, Y and P) and opens the **Roadmap**.
   - *Expected*: the "Critical path to…" picker reads **None**; no element has `data-critical`; there is no "Critical path to …" panel.
2. They choose **Show critical path to this project** from P's row menu.
   - *Expected*: the h3 "Critical path to <P>" appears, the picker reads P's name and the live region says "Showing the critical path to <P>".
   - *Expected*: the span bars of X, Y and the target P are named "..., on the critical path, read-only" and carry `data-critical="true"`; the two
     bundle arrows (X -> Y and Y -> P, one per project pair) carry it too and are the only arrows; five elements carry the flag in all.
3. They read the panel.
   - *Expected*: "Target: <P>, 2041-01-07 to 2041-01-25.", "Projects upstream: 2, on the chain: 2."; the table "Projects upstream of <P>" has the
     header and two rows in the server's order: Y (1 hop, the program, 2041-01-14 – 2041-01-18, "0 working days", "On the chain") and X (2 hops,
     2041-01-07 – 2041-01-11, "0 working days", "On the chain"); X's name links to its project page.
4. They choose **None** in the picker.
   - *Expected*: the picker reads None, no element has `data-critical` and the panel and its table are gone.
