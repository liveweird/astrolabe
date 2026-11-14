# Milestones (every milestone of the plan, filtered in the URL)

- **Spec**: [tests/milestones.spec.ts](../tests/milestones.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, team, work stream, program, project and three milestones of that team (unique `e2e-ms-*` names; one scheduled 2027-05-03 to 2027-05-07, two left unscheduled), all seeded through the API in the test and removed through the API in the afterEach (the project first, its milestones go with it, then program, work stream, team, person), even after a failure. May 2027 on purpose: nothing here depends on working days, so no holiday and no far-off year. It writes no ranking, no holiday and no connection, and needs no lock. The plan is shared by four workers, so the page is narrowed to the spec's own team before any row is counted.

## Scenario: the Milestones page lists a team's milestones, and the schedule filter narrows them to the ones not scheduled yet

1. The administrator signs in, opens **Milestones** from the Planning section of the sidebar, opens the filter panel and picks the spec's team in the Team select.
   - *Expected*: the page heading (h2) is "Milestones"; the address carries `teamId`; exactly three rows; the scheduled milestone shows 2027-05-03 and 2027-05-07, the other two read "Not scheduled".
2. They choose "Not scheduled" in the Schedule select, then reload the page.
   - *Expected*: the address carries `scheduled=false`; exactly two rows (the scheduled milestone is gone); after the reload the same two rows.
3. They click the project's name in a row.
   - *Expected*: the project page's heading (h2) is the project's name.

## Not covered here (and why)

- The plan-wide count and values, the name search, the project chip, the sort and the paging: four workers share the plan; vitest and `MilestoneListTest` pin them (Home's link to this page is `home.md`'s last scenario).
- The Polish text (vitest).
