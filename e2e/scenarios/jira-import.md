# Import from Jira (scope, preview, import, re-preview, untick, skip reason, axe)

- **Spec**: [tests/jira-import.spec.ts](../tests/jira-import.spec.ts)
- **Actors**: a throwaway administrator per test (seeded through the API; the preview and the apply share a 5-a-minute bucket PER USER, so every test has its own
  login), who works in the browser (the owner test's actor is a throwaway NON-admin `USER` login linked to the person who owns the test's work stream); the seed administrator only seeds and tears down through the API
- **Owns** (exclusive server-side state): one Jira connection (`e2e-import-connection-*`, scoped to the stub's `IMP` project ONLY, on a unique throwaway site, tested once
  in the beforeAll through the API: Test connection shares a per-IP bucket (10 a minute by default, 30 on the e2e stacks) with the other Jira specs; a 429 there waits the bucket out once) and, per test, a person, a team, a work stream (unique
  `e2e-import-*` names), the login, and what the import creates under that work stream with **the stub's own names** ("IMP Program", "IMP Initiative Alpha",
  "IMP Initiative Beta", "IMP Epic One" ...): program names are global, so this is the only spec that may import `IMP` (it holds the Playwright lock `jira-import-stub`).
  Every date is the stub's, in **2045** (IMP-4 ends on 2045-01-06, Polish Epiphany: harmless while no spec loads 2045 holidays). Nothing ever applies into an existing
  work stream. Teardown is the afterEach, even after a failure: the connection's bindings (unlinked while their items are alive), then the stream's projects (their milestones
  go with them), programs and the stream, then the team, the person and the login; the afterAll deletes the connection. The beforeAll first sweeps a crashed run's residue,
  found by the `e2e-import-` prefix and nothing else, over ALL pages (connections, the trees of work streams, then teams, people and logins); an "IMP Program", "IMF Program" or "IMF Program Old" under any OTHER work stream is not ours and is never deleted: the run fails
  fast naming it.
  1.13.2 adds, per IMF test, one more connection (`e2e-import-filter-*`, scoped to the stub's `IMF` project ONLY, on a unique throwaway site, tested through the API: one more call of the Test bucket
  each); the first IMF test IMPORTS through it, so its bindings are removed (with the file's own connection's) before the stream's tree, and the stub's other names it creates
  ("IMF Program", "IMF Program Old", the "IMF Initiative ..." projects and four "IMF Epic ..." milestones, dated 2045) go with the stream. `IMF` is imported by this spec alone too (same lock).

The stub's `IMP` project (`sample-data/jira/world.mjs`): IMP-1 the Program "IMP Program"; IMP-2/IMP-3 the Initiatives "IMP Initiative Alpha/Beta" under it; epics IMP-4 "IMP Epic One"
(Mon 2045-01-02..Fri 01-06, 5 points) and IMP-5 "IMP Epic Two" (01-16..01-20, no Jira team) under Alpha, IMP-6 "IMP Epic Three" (undated), IMP-7 (a 110-character summary, dated) and
IMP-9 "IMP Epic Six" (01-30..02-03) under Beta, IMP-8 (dated) straight under the program, so it has no project to land in. The epics' Jira team is "IMP Team", which matches no team
here: every milestone takes the default team.

Since 1.13.2 the dialog's Scope step opens with the import filter on: **Leave out done items** ticked and **Updated within (days)** 365 (`fillScope` asserts both). The stub does not
evaluate the filter (its listings hold the done and quiet issues too); the server's rule drops them and reads the parents it needs by id. `IMP`'s nine issues are all open and stamped
2044, so every IMP scenario below keeps its figures at the defaults. The stub's `IMF` project (`sample-data/jira/world.mjs`, `expected.json` `imf`; the figures below are its
`byFilter`): 15 issues in the listings, dated 2045 - IMF-1 Program "IMF Program"; Initiatives IMF-2 Open, IMF-3 Done (status Done), IMF-4 Quiet (stamped 2010), IMF-5 Closed (Done), IMF-13 Old (Done, 2010) under
IMF-12 the Program "IMF Program Old" (Done, 2010); Epics IMF-6 under IMF-2, IMF-7 under IMF-3, IMF-8 under IMF-4, IMF-9 and IMF-10 (Done), IMF-11 (stamped 2010), IMF-14 under IMF-13, and IMF-15
under IMF-16, an Initiative that is in no listing and answers 404 by id (the parent the connection cannot read). The epics' Jira team "IMF Team" matches no team here.

## Scenario: admin imports the stub's IMP project tree and a re-import creates nothing

1. The administrator opens the connection's page, presses **Import from Jira…**, picks the work stream, the owner and the default team (the Jira project `IMP` is preselected,
   "Copy Jira's dates" is on, no default project) and presses **Preview**.
   - *Expected*: the totals read "Jira items: 9", "To create: 8", "To link: 0", "Skipped: 1" and "8 of 8 selected"; the note names the unmatched Jira team "IMP Team"; IMP-8 says
     "Nowhere to put it", IMP-6 "Jira's dates are missing or invalid: created unscheduled", IMP-7 "Name cut to 100 characters"; IMP-5's team select holds the default team.
2. They press **Import (8)**.
   - *Expected*: the outcome reads "Created: 8" (1 program, 2 projects, 5 milestones), "Linked: 0", "Scheduled: 4" (IMP-4, 5, 7, 9) and "Skipped: 0": IMP-8 has no checkbox, so it is not sent and the outcome has no skipped-rows table.
3. They close the dialog.
   - *Expected*: the connection page's "Links to plan items" table has 8 rows with an IMP key.
4. The plan is read through the API and the project page is opened.
   - *Expected*: the work stream holds exactly "IMP Program" with "IMP Initiative Alpha" and "IMP Initiative Beta"; Alpha's scheduled milestones are IMP Epic One 2045-01-02..2045-01-06
     and IMP Epic Two 2045-01-16..2045-01-20; Beta has IMP-7 (its 110-character summary cut at the 100-character name limit) 2045-01-23..2045-01-27 and IMP Epic Six 2045-01-30..2045-02-03 scheduled and IMP Epic Three in the tray; the project page shows Alpha's heading and its first milestone.
5. They open the modal again, fill the same scope and press **Preview**.
   - *Expected*: "To create: 0", "To link: 0", "Skipped: 9", "0 of 0 selected"; IMP-4 reads "Already linked", IMP-8 still "Nowhere to put it", **Import (0)** is disabled (there is nothing to
     press, so a re-import can create nothing), the links table still has 8 rows and a re-read of the stream's programs, projects and milestones (names and dates) is identical to step 4's.

## Scenario: an owner imports from the Plan page's work-stream menu

1. A throwaway non-admin login (linked to a person) owns a throwaway work stream (that person) with a team beside it. They open the Plan page, the stream's **Operations** menu and **Import from Jira…**.
   - *Expected*: the import dialog opens; its Jira connection is preselected when it is the only usable one (else the spec's connection is picked by name: other specs' connections may be offered too);
     the Work stream field reads the stream's name and is read-only.
2. They pick themselves (the person) as the owner of the new items and the team as the default team, and press **Preview**.
   - *Expected*: the totals read "Jira items: 9", "To create: 8", "To link: 0", "Skipped: 1" (the skipped row's own text is redacted for a non-admin and is not asserted).
3. They press **Import (8)** and close the dialog.
   - *Expected*: the outcome reads "Created: 8"; the Plan page lists "IMP Program" under the stream, and the plan read through the API holds exactly that program under it.

## Scenario: unticking a parent leaves its children out of the import, with the reason shown

1. The administrator previews the same scope (one preview call).
   - *Expected*: **Import (8)** is enabled.
2. They untick IMP-2 (the Initiative with IMP-4 and IMP-5 under it).
   - *Expected*: **Import (5)**, "5 of 8 selected", the polite sentence "Unticked IMP-2 and the 2 items created under it: they would be skipped."; IMP-4 and IMP-5 are unticked with the
     badge "Not imported" and "Its parent IMP-2 is not ticked, so this is not imported."; IMP-9 (the other branch) stays ticked.
3. They tick IMP-4.
   - *Expected*: IMP-2 is ticked again (what it is created under), **Import (7)**, IMP-5 stays "Not imported".

## Scenario: searching the preview cherry-picks one item to import

1. The administrator previews the same scope (one preview call).
   - *Expected*: "8 of 8 selected".
2. They press **Select none**, type "IMP-1" in **Search the preview**, and press **Tick shown**.
   - *Expected*: "Showing 1 of 9", the table holds only IMP-1 (the header and one row), **Import (1)** is enabled and "1 of 8 selected".
3. They search "epic one" and press **Tick shown**.
   - *Expected*: "Showing 1 of 9" with IMP-4 only; the polite sentence "Also ticked 1 item outside the search that the shown rows are created under." (IMP-2); **Import (3)**.
4. They search "no such item", then press **Clear the search**.
   - *Expected*: the note "No rows match “no such item”." and no table while the query is active; after clearing, all 9 rows are back with IMP-1, IMP-2, IMP-4 ticked and IMP-3, IMP-5, IMP-9 not.
5. They press **Import (3)**.
   - *Expected*: "Created: 3"; the plan read through the API holds "IMP Program" with the one project "IMP Initiative Alpha" and its milestone "IMP Epic One" dated 2045-01-02..2045-01-06.

## Scenario: a skipped row says how to fix it, and a default project makes it importable

1. The work stream already holds a program with a project (seeded through the API). The administrator previews with no default project.
   - *Expected*: IMP-8 is skipped with "Pick a default program or project, or import its parent." and has no checkbox; "Skipped: 1".
2. They press **Back**, pick that project as the **Default project** and press **Preview** again (the other choices are kept).
   - *Expected*: "To create: 9" and no "Skipped" total; IMP-8 reads "Under default <the project>", is ticked, **Import (9)** is enabled. Nothing is imported.

## Scenario: the import modal's three steps have no WCAG A/AA violations

1. The administrator opens the modal and scans the dialog empty (Scope), then filled; presses Preview and scans the Preview step (9 rows, no spacer rows: the table virtualises only above 80);
   presses Import and scans the Outcome step (the counts and the Close button; there is no skipped row).
   - *Expected*: axe (WCAG 2.0/2.1 A and AA, `color-contrast` included) reports zero violations in the dialog at each of the four points.

## Scenario: the import modal's three steps have no WCAG A/AA violations in the dark scheme

1. The same four scans with the dark scheme emulated.
   - *Expected*: the page renders in the dark scheme and axe reports zero violations at each point.

## Scenario: a preview of about 1,100 rows (the virtualised table) has no WCAG A/AA violations, at the top and mid-scroll, light and dark

1. A second connection, scoped to the stub's five work-stream projects (`CE`, `PF`, `CG`, `DI`, `OE`) on its own throwaway site, is created and tested through the API (one more
   call of the shared Test bucket (10 a minute by default, 30 on the e2e stacks); a 429 waits the minute out once); the administrator opens its import modal, picks the throwaway work stream, the owner and the default team, and presses
   **Preview**. Nothing is imported. Before the preview the filter is switched OFF (**Leave out done items** unticked, the days field emptied): the sample projects are stamped in 2026, so
   under the 365-day default window their row count would start to fall in late August 2027; both controls off also proves the request then carries no filter (1.13.1's), so the preview has no "Left out" note.
   - *Expected*: the table's `aria-rowcount` is above 1,000, the first mounted row is row 2 and fewer than 200 rows are in the DOM (the virtual path); axe reports zero violations in the dialog.
2. The preview's scroller is scrolled to the middle.
   - *Expected*: the first mounted row's `aria-rowindex` is above 100; axe reports zero violations.
3. The dark scheme is emulated on the same page, then the scroller goes back to the top.
   - *Expected*: the page renders in the dark scheme and axe reports zero violations mid-scroll and at the top (the first mounted row is row 2, after the header).
   The afterEach deletes the second connection with the rest of the test's rows.

## Scenario: the outcome's skipped-rows table (a row changed since the preview) has no WCAG A/AA violations

1. The work stream already holds a program with a project (seeded through the API). The administrator opens the modal, picks the stream, owner, default team and that project as the
   **Default project**, and presses **Preview**.
   - *Expected*: "To create: 9", no "Skipped" total, IMP-8 reads "Under default <the project>", **Import (9)** is enabled.
2. With the modal still open, a milestone named "IMP Epic Five" (IMP-8's name) is created in that project through the API, unlinked; then they press **Import (9)**. The apply's
   recomputation under the plan lock now finds an unlinked same-name sibling, so IMP-8 is a link where the user ticked a create: it is skipped as `CHANGED`.
   - *Expected*: the outcome reads "Created: 8", "Linked: 0", "Skipped: 1"; the note says "1 row changed since the preview and was skipped."; the "Skipped rows" table has the header and
     one row, IMP-8, with "Changed since the preview, in Jira or in the plan. Preview again."; axe (WCAG 2.0/2.1 A and AA, `color-contrast` included) reports zero violations in the dialog.
3. The default project's view is read through the API.
   - *Expected*: its only milestone is the one the test made (IMP-8 wrote nothing).

## Scenario: the outcome's skipped-rows table (a row changed since the preview) has no WCAG A/AA violations in the dark scheme

1. The same walk with the dark scheme emulated.
   - *Expected*: the page renders in the dark scheme, the outcome is the same, and axe reports zero violations.

## Scenario: the import filter leaves out done and quiet items and keeps the parents of what it reads

1. A connection scoped to the stub's `IMF` project alone is created and tested through the API (one more call of the shared Test bucket; a 429 waits the minute out once). The administrator
   opens its import modal, picks the throwaway work stream, the owner and the default team, leaves the filter at its defaults (the switch ticked, 365; no default project) and presses **Preview**.
   - *Expected*: the totals read "Jira items: 11", "To create: 10", "To link: 0", "Skipped: 1" and "10 of 10 selected"; the note reads "Left out: done items, and items not updated for more than 365
     days. Their parents in the selected projects are still read."; there is no row for IMF-5, IMF-9, IMF-10 or IMF-11; the rows of IMF-3 (a done parent), IMF-4 (a quiet parent), IMF-12 and IMF-13
     (the two-round chain, both left out by every filter) read "Kept as a parent of an item shown here" and IMF-1, 2, 6, 7, 8, 14 do not; IMF-7 reads "Under new IMF Initiative Done" and IMF-14
     "Under new IMF Initiative Old"; IMF-15 says "Nowhere to put it", reads "Its parent in Jira could not be read with the connection's account" (its parent IMF-16 answers 404 by id) and has no checkbox.
2. They press **Import (10)** (the apply re-reads the same parents under the same filter).
   - *Expected*: the outcome reads "Created: 10" (2 programs, 4 projects, 4 milestones), "Linked: 0", "Scheduled: 4" and "Skipped: 0", with no skipped-rows table. They close the dialog.
3. The connection page and the plan are read.
   - *Expected*: the "Links to plan items" table has 10 rows with an IMF key and none for IMF-5, 9, 10, 11 or 15; the work stream holds exactly "IMF Program" and "IMF Program Old" with the projects
     "IMF Initiative Done", "IMF Initiative Old", "IMF Initiative Open" and "IMF Initiative Quiet", each with its one milestone scheduled in 2045 (Under Done 01-23..01-27, Under Old 03-06..03-10, Open 01-02..01-06,
     Under Quiet 02-06..02-10) and nothing in any tray.

## Scenario: with the filter off the whole IMF project previews and no parent is read; with only the done switch on the quiet items stay

1. A connection scoped to `IMF` as above; the administrator fills the scope, unticks **Leave out done items**, empties **Updated within (days)** and presses **Preview**.
   - *Expected*: "Jira items: 15", "To create: 14", "To link: 0", "Skipped: 1"; no "Left out" note; IMF-5, 9, 10 and 11 each have a row; no row reads "Kept as a parent of an item shown here"; IMF-15 says
     "Nowhere to put it" and does NOT read "Its parent in Jira could not be read" (nothing was read, so nothing is known about its parent).
2. They press **Back** (the choices are kept), tick **Leave out done items** again (the field stays empty) and press **Preview**.
   - *Expected*: "Jira items: 12", "To create: 11", "Skipped: 1"; the note reads "Left out: done items. Their parents in the selected projects are still read."; IMF-5, 9 and 10 have no row, the quiet IMF-11
     does; IMF-3, 12 and 13 read "Kept as a parent of an item shown here" and IMF-4 (a real row now) does not; IMF-15 reads "Its parent in Jira could not be read". Nothing is imported, so no IMF program is ever created.

## Not covered here (and why)

- Skip reasons other than `CHANGED` in the outcome's table: the stub is static and the UI never sends an unticked or kernel-skipped row, so a plan row appearing between the
  preview and the apply (the `CHANGED` scenario above) is the one deterministic trigger; the server's `JiraImportApplyTest` pins the others.
- A second apply (a re-import that writes): after the first import every row is `ALREADY_BOUND`, so the modal has nothing to press; the server's `JiraImportApplyTest` covers the re-import.
