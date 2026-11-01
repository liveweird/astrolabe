# The critical path and the idle gaps (the project and team pages)

- **Spec**: [tests/critical-path.spec.ts](../tests/critical-path.spec.ts)
- **Actors**: a throwaway project OWNER login (the person who owns the program, so all three projects; not the teams' manager, so the bars
  are read-only images); the seed administrator acts only through the API (seeding, the milestones' dates, the links)
- **Owns** (exclusive server-side state): its throwaway user, person, two teams (X's and Y's milestones on one, P's on the other), work
  stream, program, three projects X, Y, P and their milestones and links (unique `e2e-cp-*` names), seeded through the API and removed by
  the afterEach, the projects first (their milestones and links go with them), then program, work stream, teams, person and user. **Every date
  is in 2041**, a year nothing else in the suite touches: the holiday dictionary is global and `public-holidays.spec.ts` owns 2040, so the
  working-day figures asserted here (slack, idle gaps) cannot see a holiday. The world, per test: x1 (X, 2041-01-07..11), y1 (Y,
  2041-01-14..18), p1 (P, 2041-01-21..25) and an unlinked p2 (P, 2041-01-07..11), with finish-to-start links x1 -> y1 -> p1, no lag. Both
  scenarios run on that same shape, seeded afresh each time.

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
