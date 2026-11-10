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
  found by the `e2e-import-` prefix and nothing else, over ALL pages (connections, the trees of work streams, then teams, people and logins); an "IMP Program" under any OTHER work stream is not ours and is never deleted: the run fails
  fast naming it.

The stub's `IMP` project (`sample-data/jira/world.mjs`): IMP-1 the Program "IMP Program"; IMP-2/IMP-3 the Initiatives "IMP Initiative Alpha/Beta" under it; epics IMP-4 "IMP Epic One"
(Mon 2045-01-02..Fri 01-06, 5 points) and IMP-5 "IMP Epic Two" (01-16..01-20, no Jira team) under Alpha, IMP-6 "IMP Epic Three" (undated), IMP-7 (a 110-character summary, dated) and
IMP-9 "IMP Epic Six" (01-30..02-03) under Beta, IMP-8 (dated) straight under the program, so it has no project to land in. The epics' Jira team is "IMP Team", which matches no team
here: every milestone takes the default team.

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
   **Preview**. Nothing is imported.
   - *Expected*: the table's `aria-rowcount` is above 1,000, the first mounted row is row 2 and fewer than 200 rows are in the DOM (the virtual path); axe reports zero violations in the dialog.
2. The preview's scroller is scrolled to the middle.
   - *Expected*: the first mounted row's `aria-rowindex` is above 100; axe reports zero violations.
3. The dark scheme is emulated on the same page, then the scroller goes back to the top.
   - *Expected*: the page renders in the dark scheme and axe reports zero violations mid-scroll and at the top (the first mounted row is row 2, after the header).
   The afterEach deletes the second connection with the rest of the test's rows.

## Not covered here (and why)

- The outcome's skipped-rows table is not axe-scanned in e2e: the UI never sends a row without a checkbox, so a first import has no skipped row to show.
- A second apply (a re-import that writes): after the first import every row is `ALREADY_BOUND`, so the modal has nothing to press; the server's `JiraImportApplyTest` covers the re-import.
