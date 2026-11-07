# Import from Jira (scope, preview, import, re-preview, untick, skip reason, axe)

- **Spec**: [tests/jira-import.spec.ts](../tests/jira-import.spec.ts)
- **Actors**: a throwaway administrator per test (seeded through the API; the preview and the apply share a 5-a-minute bucket PER USER, so every test has its own
  login), who works in the browser; the seed administrator only seeds and tears down through the API
- **Owns** (exclusive server-side state): one Jira connection (`e2e-import-connection-*`, scoped to the stub's `IMP` project ONLY, on a unique throwaway site, tested once
  in the beforeAll through the API: Test connection shares a 10-a-minute bucket per IP with the other Jira specs; a 429 there waits the bucket out once) and, per test, a person, a team, a work stream (unique
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

## Not covered here (and why)

- The outcome's skipped-rows table is not axe-scanned in e2e: the UI never sends a row without a checkbox, so a first import has no skipped row to show.
- The virtualised table is not scanned in e2e: `IMP` has 9 rows, under the 80-row threshold, so the spacer rows and `aria-rowcount`/`aria-rowindex` are never rendered here. Manual evidence: on
  2026-11-07, axe over the real five-key preview at 1,120 rows, at the top and mid-scroll, light and dark, found 0 violations; `JiraImportModal.virtual.test.tsx` covers the path in vitest.
- A second apply (a re-import that writes): after the first import every row is `ALREADY_BOUND`, so the modal has nothing to press; the server's `JiraImportApplyTest` covers the re-import.
