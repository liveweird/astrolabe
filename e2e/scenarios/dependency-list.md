# Dependency panel (every link of the plan on the Roadmap, violated first, filtered in the URL)

- **Spec**: [tests/dependency-list.spec.ts](../tests/dependency-list.spec.ts)
- **Actors**: the seed administrator (`admin@astrolabe.local`) in the browser; the same account through the API for seeding and teardown
- **Owns** (exclusive server-side state): its throwaway person, ONE team (no manager), work stream, program and two projects (unique `e2e-deplist-*` names), all seeded through the API in the test and removed through the API in the afterEach (the projects first, their milestones and links go with them, then program, work stream, team, person), even after a failure. The first project holds milestones A (2027-06-07 to 2027-06-11), B (2027-05-24 to 2027-05-28) and C (2027-06-21 to 2027-06-25), the second D (not scheduled), all of the one team; the links are A to B (finish-to-start: B ends long before A does, violated by weeks whatever a holiday does), A to C (finish-to-start, kept with a week to spare) and D to C (D is not scheduled). The 1.22 scenario seeds the same world with two throwaway USER logins (`e2e-deplist-owner-*`, whose person owns the work stream and so every project, and `e2e-deplist-nobody-*`, linked to no person), created and removed through the API too (the logins last). The 1.27 scenario seeds that world again, plus one more throwaway person with its own work stream, program and project (`e2e-deplist-foreign-*`, which the owner does not manage; removed first, in reverse creation order), and adds ONE link (between a milestone of each project, written on the second project), which goes with the projects. June 2027 on purpose: no far-off year, nothing here depends on a specific number of working days (the shortfall is matched by a pattern). It writes no ranking, no holiday and no connection, and needs no lock. The plan is shared by four workers, so every count is taken after the panel is narrowed to the spec's own project or team. The Team select lists every team of the plan (read to the end, 1.21), so other specs' teams cannot hide the spec's own from it.

## Scenario: the Roadmap's dependency panel lists a project's links with the violated one first, and the status filter narrows them

1. The administrator signs in and opens `/roadmap?dependencies=all&dependencyProjectId=<the first project>`.
   - *Expected*: the panel (a region named "Dependencies", h3) is open; the chip "Project: <name>"; exactly three rows in the order violated, kept, not scheduled yet; the first reads "Violated · N working days short" (a pattern, never the number), the second "OK", the third "Not scheduled yet"; each end shows its milestone, its project and the team.
2. They open the panel's own Filters and choose Status "Violated", then reload the page.
   - *Expected*: exactly one row (the link from A to B); the address carries `dependencies=violated`; after the reload the same row.
3. They click the predecessor's project name in that row.
   - *Expected*: the project page's heading (h2) is the project's name.

## Scenario: the roadmap's row menu, the team page and Home open the dependency panel filtered to that project, that team and the violated links

1. The administrator opens the Roadmap narrowed to the spec's program (the program pick is a remembered browser setting) and chooses "Dependencies" in the first project's row menu.
   - *Expected*: an in-page action: the address stays on `/roadmap` and gains `dependencies=all&dependencyProjectId=<the first project>` (the program pick stays), the panel's h3 has the focus, the chip "Project: <name>" and exactly three rows.
2. They open the spec's team page and click "3 dependencies" in the "Team facts" line.
   - *Expected*: the address is the Roadmap with `dependencies=all&dependencyTeamId=<the team>`, the panel's h3 has the focus, the panel's Team select shows the team and exactly three rows. Back on the team page, the red "1 conflict" opens the panel with `dependencies=violated` and `dependencyTeamId` and exactly one row.
3. They open Home and click the Roadmap card's "N violated dependencies" (N is never asserted).
   - *Expected*: the address is the Roadmap with `dependencies=violated`, the panel's Status select shows "Violated", and the spec's violated link (A to B) is among the rows, found by its two milestone names.

## Scenario: an old /dependencies bookmark lands on the Roadmap with the dependency panel open and its filters under the panel's names

1. The administrator opens `/dependencies?status=violated&projectId=<the first project>`.
   - *Expected*: the address becomes the Roadmap's with `dependencies=violated&dependencyProjectId=<the first project>`; the panel's h3 has the focus, the chip "Project: <name>" and exactly one row (the link from A to B).

## Scenario: the owner of the successor's project changes a dependency's type and deletes it from the dependency panel, and a user who owns nothing gets no row menu

1. The owner (a throwaway login whose person owns the spec's first project) signs in and opens `/roadmap?dependencies=all&dependencyProjectId=<the first project>`.
   - *Expected*: exactly three rows; every row has a menu button "Operations for <predecessor · project> → <successor · project>", the row of A and C included.
2. They choose "Edit…" in the row of A and C, change the Type to "Start → Start (SS)" and save.
   - *Expected*: the dialog shows both ends read-only, each with its project; the `PUT` answers `204`; the dialog closes; the row's Type cell reads "Start → Start (SS)"; the focus is on that row's menu button.
3. They choose "Delete" in the same menu and confirm.
   - *Expected*: the `DELETE` answers `204`; two rows are left; the panel's heading (h3) has the focus. On the first project's page the Dependencies table lists two links and none of A and C.
4. The second login (linked to no person) signs in and opens the same address.
   - *Expected*: the two rows are listed, no row has a button and the table has no "Operations" column.

## Scenario: a project owner adds a dependency from the dependency panel choosing among the projects they manage, and a user who owns nothing is offered no button

1. The owner (a throwaway login whose person owns the spec's whole work stream) signs in and opens `/roadmap?dependencies=all&dependencyProjectId=<the first project>`.
   - *Expected*: the chip "Project: <name>" (so the plan has been read) and exactly three rows; the panel's header has the button "Add dependency".
2. They click it.
   - *Expected*: the dialog "Add dependency" opens with the Successor's project select already on the first project. Its options are the two projects of the owner's work stream and no more: the foreign project (another person's work stream) is not among them.
3. They choose the second project, open the Successor select and pick milestone D, then find milestone B of the first project by name in the Predecessor select.
   - *Expected*: the Successor select lists only the second project's one milestone (D); the Predecessor option reads "<B> · <first project>"; the Type is "Finish → Start (FS)".
4. They save.
   - *Expected*: the `POST /api/v1/projects/<second project>/dependencies` answers `201`; the dialog closes; the list now has four rows, the new one (B and D, "Not scheduled yet") among them exactly once; the address still has `dependencyProjectId=<the first project>` and the chip; the focus is back on the "Add dependency" button.
5. A second throwaway login (linked to no person) signs in and opens the same address.
   - *Expected*: the chip and the four rows show (the plan has been read), and the page has no "Add dependency" button.

## Scenario: the Roadmap and the Programs page hide the dependency list until asked for, then list a project's links with the filters in the address

1. The administrator opens `/roadmap?programId=<the spec's program>`.
   - *Expected*: the h3 "Dependencies" region holds a toggle **Show the dependency list** (`aria-expanded` false) and no table: a hidden panel is not read.
2. They press it, then reload.
   - *Expected*: the toggle reads **Hide the dependency list** and has the focus; the plan's table "Dependencies of the plan" is shown before and after the reload (a browser memory).
3. They open `/roadmap?programId=<program>&dependencies=all&dependencyProjectId=<the first project>`.
   - *Expected*: the panel's h3 has the focus; exactly three rows in the order violated, kept, not scheduled yet. In the panel's own Filters they choose Status "Violated": the address becomes `…&dependencies=violated&dependencyProjectId=<the first project>` (the Roadmap's `programId` stays) and the one row of A and B is left.
4. They press **Hide the dependency list**.
   - *Expected*: no rows; the address no longer has `dependencies=` but keeps `dependencyProjectId`.
5. They open `/roadmap?mode=overview&programId=<program>`.
   - *Expected*: the same panel is hidden (the memory now says hidden); `/roadmap?mode=overview&programId=<program>&dependencies=violated&dependencyProjectId=<the first project>` shows one row, the link from A to B.

## Not covered here (and why)

- The values of `totals` and of Home's figure: four workers share the plan; vitest and `DependencyListViewTest` pin them.
- "Yours" on Home (vitest pins the hrefs), the Programs page's menu item (vitest; the Roadmap's is the same component), the cut note (vitest and `DependencyListViewTest`) and the Polish text (vitest).
- The cycle `409` and the `403` of the edit dialog (vitest and `DependencyListViewTest`), a row whose two flags differ (they cannot today) and the Polish text (vitest).
- The panel's row menu by `can`, the edit and delete flows, the focus on its h3 and what a save and a delete refresh (vitest `PlanDependenciesPanel.write.test.tsx` and `.dialogs.test.tsx`; the scenarios above drive them in the browser), the add dialog's writes (vitest, `PlanDependenciesPanel.add.test.tsx`) and its axe scan (`accessibility.spec.ts`, the `/roadmap` scans with the panel open, light and dark).
- The old `/dependencies` address with no filter, or with a malformed one (vitest, `legacyLinks.test.ts` and `LegacyDependenciesRedirect.test.tsx`).
- The cycle, the duplicate pair, a refused write (`403`/`404`), a whole project as the successor, the prefill from a project the caller may not manage and the lag (vitest, `PlanDependenciesPanel.add.test.tsx`, `DependencyAddModal.test.tsx`; the server pins `can.createDependency` against the guard in `PlanViewTest` and `PlanPermissionsTest`).
