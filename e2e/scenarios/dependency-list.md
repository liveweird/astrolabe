# Dependencies (every link of the plan, violated first, filtered in the URL)

- **Spec**: [tests/dependency-list.spec.ts](../tests/dependency-list.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, ONE team (no manager), work stream, program and two projects (unique `e2e-deplist-*` names), all seeded through the API in the test and removed through the API in the afterEach (the projects first, their milestones and links go with them, then program, work stream, team, person), even after a failure. The first project holds milestones A (2027-06-07 to 2027-06-11), B (2027-05-24 to 2027-05-28) and C (2027-06-21 to 2027-06-25), the second D (not scheduled), all of the one team; the links are A to B (finish-to-start: B ends long before A does, violated by weeks whatever a holiday does), A to C (finish-to-start, kept with a week to spare) and D to C (D is not scheduled). The 1.22 scenario seeds the same world with two throwaway USER logins (`e2e-deplist-owner-*`, whose person owns the work stream and so every project, and `e2e-deplist-nobody-*`, linked to no person), created and removed through the API too (the logins last). June 2027 on purpose: no far-off year, nothing here depends on a specific number of working days (the shortfall is matched by a pattern). It writes no ranking, no holiday and no connection, and needs no lock. The plan is shared by four workers, so every count is taken after the page is narrowed to the spec's own project or team. The Team select lists every team of the plan (read to the end, 1.21), so other specs' teams cannot hide the spec's own from it.

## Scenario: the Dependencies page lists a project's links with the violated one first, and the status filter narrows them

1. The administrator signs in and opens `/dependencies?projectId=<the first project>`.
   - *Expected*: the heading (h2) is "Dependencies"; the chip "Project: <name>"; exactly three rows in the order violated, kept, not scheduled yet; the first reads "Violated · N working days short" (a pattern, never the number), the second "OK", the third "Not scheduled yet"; each end shows its milestone, its project and the team.
2. They open the filter panel and choose Status "Violated", then reload the page.
   - *Expected*: exactly one row (the link from A to B); the address carries `status=violated`; after the reload the same row.
3. They click the predecessor's project name in that row.
   - *Expected*: the project page's heading (h2) is the project's name.

## Scenario: the roadmap's row menu, the team page and Home open the Dependencies page filtered to that project, that team and the violated links

1. The administrator opens the Roadmap narrowed to the spec's program (the program pick is a remembered browser setting) and chooses "Dependencies" in the first project's row menu.
   - *Expected*: the address is `/dependencies?projectId=<the first project>`, the chip "Project: <name>" and exactly three rows.
2. They open the spec's team page and click "3 dependencies" in the "Team facts" line.
   - *Expected*: the address is `/dependencies?teamId=<the team>`, the Team select shows the team and exactly three rows. Back on the team page, the red "1 conflict" opens the list with `status=violated` and `teamId` and exactly one row.
3. They open Home and click the Roadmap card's "N violated dependencies" (N is never asserted).
   - *Expected*: the address is `/dependencies?status=violated`, the Status select shows "Violated", and the spec's violated link (A to B) is among the rows, found by its two milestone names.

## Scenario: the owner of the successor's project changes a dependency's type and deletes it from the Dependencies page, and a user who owns nothing gets no row menu

1. The owner (a throwaway login whose person owns the spec's first project) signs in and opens `/dependencies?projectId=<the first project>`.
   - *Expected*: exactly three rows; every row has a menu button "Operations for <predecessor · project> → <successor · project>", the row of A and C included.
2. They choose "Edit…" in the row of A and C, change the Type to "Start → Start (SS)" and save.
   - *Expected*: the dialog shows both ends read-only, each with its project; the `PUT` answers `204`; the dialog closes; the row's Type cell reads "Start → Start (SS)"; the focus is on that row's menu button.
3. They choose "Delete" in the same menu and confirm.
   - *Expected*: the `DELETE` answers `204`; two rows are left; the page title (h2) has the focus. On the first project's page the Dependencies table lists two links and none of A and C.
4. The second login (linked to no person) signs in and opens the same address.
   - *Expected*: the two rows are listed, no row has a button and the table has no "Operations" column.

## Not covered here (and why)

- The values of `totals` and of Home's figure: four workers share the plan; vitest and `DependencyListViewTest` pin them.
- "Yours" on Home (vitest pins the hrefs), the Programs page's menu item (vitest; the Roadmap's is the same component), the cut note (vitest and `DependencyListViewTest`) and the Polish text (vitest).
- The cycle `409` and the `403` of the edit dialog (vitest and `DependencyListViewTest`), a row whose two flags differ (they cannot today) and the Polish text (vitest).
- The page's axe scans: `accessibility.spec.ts` (the page joins its list, light and dark).
