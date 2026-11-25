# Milestones (every milestone of the plan, filtered in the URL)

- **Spec**: [tests/milestones.spec.ts](../tests/milestones.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, team, work stream, program, project and three milestones of that team (unique `e2e-ms-*` names; one scheduled 2027-05-03 to 2027-05-07, two left unscheduled), all seeded through the API in the test and removed through the API in the afterEach (the project first, its milestones go with it, then program, work stream, team, person), even after a failure. May 2027 on purpose: nothing here depends on working days, so no holiday and no far-off year. The two 1.27 scenarios own a second world each (`e2e-msrank-*`, scenario 3); only the rank scenario appends two of its projects to the GLOBAL ranking, which their deletion removes. No scenario writes a holiday or a connection, and none needs a lock. The plan is shared by four workers, so the page is narrowed to the spec's own team before any row is counted.

## Scenario: the Milestones page lists a team's milestones, and the schedule filter narrows them to the ones not scheduled yet

1. The administrator signs in, opens **Milestones** from the Planning section of the sidebar, opens the filter panel and picks the spec's team in the Team select.
   - *Expected*: the page heading (h2) is "Milestones"; the address carries `teamId`; exactly three rows; the scheduled milestone shows 2027-05-03 and 2027-05-07, the other two read "Not scheduled".
2. They choose "Not scheduled" in the Schedule select, then reload the page.
   - *Expected*: the address carries `scheduled=false`; exactly two rows (the scheduled milestone is gone); after the reload the same two rows.
3. They click the project's name in a row.
   - *Expected*: the project page's heading (h2) is the project's name.

## Scenario: the Milestones page's Project select narrows the list to one project and shows it as a chip

1. The administrator signs in, opens **Milestones** from the Planning section of the sidebar, opens the filter panel and chooses the spec's project in the Project select (click, type its name, pick the option).
   - *Expected*: the address carries `projectId=<the project's id>`; the chip "Project: <name>" shows beside the Filters button; exactly the project's three milestones are rows (the scheduled one and the two not scheduled).
2. They remove the chip (its "Remove the project filter" button).
   - *Expected*: the address has no `projectId`, the chip is gone and the Project select is empty.

## Scenario: the Milestones page sorts by the project's rank, with the milestones of unranked projects last whichever way it sorts

Its world (the 1.27 scenarios share it; unique `e2e-msrank-*` names, seeded through the API in the test and removed through the API in the afterEach, the projects first and the people last): one team, a person, two work streams, three programs (the first two under the first work stream) and five projects `...-proj-a` to `...-proj-e` of one unscheduled milestone each (a, b and c in the first program, d in the second, e in the third), created in the order d, e, c, b, a. Projects b and a are appended to the GLOBAL ranking in that order (`updateRankingViaApi`, a read-modify-write that keeps the other workers' entries); c, d and e stay unranked. The projects' deletion takes them out of the ranking. No position is asserted as a number, only the order of the two ranked ones against each other.

1. The administrator signs in and opens `/milestones?workStreamId=<the first work stream>` (milestones of a, b, c and d, found by name).
   - *Expected*: the heading (h2) is "Milestones"; four rows in the order of their project names (a, b, c, d); the Rank header has `aria-sort="none"`.
2. They click the Rank header.
   - *Expected*: `aria-sort` is "ascending"; the rows read b, a, c, d; the first two Rank cells hold numbers and b's is the smaller; the last two cells read "Unranked" (a dash for the eye).
3. They click it again.
   - *Expected*: `aria-sort` is "descending"; the rows read a, b, c, d (the ranked ones flipped, the unranked ones still last and in the same order); a's number is larger than b's; the last two cells read "Unranked".

## Scenario: the Milestones page narrows to a work stream and to a program from the address, and a work stream pick drops a program outside it

1. The administrator signs in and opens `/milestones?programId=<the first program>`, then `?programId=<the second program>`.
   - *Expected*: first exactly three rows (a, b and c) with the Program select showing the program's name; then exactly one (d).
2. They open `/milestones?workStreamId=<the first work stream>` and open the filter panel.
   - *Expected*: four rows (a, b, c, d); the Work stream select shows the stream's name; the Program select lists the stream's two programs and not the third (the other stream's).
3. They pick the second program, then reload.
   - *Expected*: the address carries `programId=<the second program>`; exactly one row (d), also after the reload.
4. They pick the second work stream in the Work stream select.
   - *Expected*: the address carries its `workStreamId` and no longer a `programId` (the program is not under it); exactly one row (e); the Program select is empty.

## Not covered here (and why)

- The plan-wide count and values, the name search, the other sorts and the paging: four workers share the plan; vitest and `MilestoneListTest` pin them (Home's link to this page is `home.md`'s last scenario).
- The server's rules for the filters and the rank sort (a malformed id, an id that names nothing, `startDate`, the nulls last in the key list) and the web's cascade for every combination: `MilestoneListTest`, vitest.
- The Dependencies page's Project select (the same component; vitest) and a team beyond the first hundred (the Team select reads every team; vitest, because an e2e would need 101 teams on a shared stack).
- The Polish text (vitest).
